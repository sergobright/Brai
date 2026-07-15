import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import readline from "node:readline";
import { spawn as nodeSpawn } from "node:child_process";

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
const ENVIRONMENT_ID = /^(?:prod|dev|preview-[a-e])$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const EFFORT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_TEXT_BYTES = 256 * 1024;
const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const DEFAULT_IDLE_MS = 15 * 60 * 1000;
const WORKSPACE = "/workspace";
const ASSISTANT_INSTRUCTIONS = [
  "Ты — Брай на базе Codex.",
  "Отвечай на языке пользователя.",
  "Среда изолирована и доступна только для чтения.",
  "У тебя нет доступа к данным Brai, проектам, базе данных или общему Vault.",
  "Честно сообщай об этих ограничениях и не утверждай обратного.",
].join(" ");

export class BrokerError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

class AppServerError extends Error {
  constructor(error) {
    super(String(error?.message || "Codex App Server request failed"));
    this.upstreamCode = error?.code ?? null;
  }
}

export class AppServerProcess extends EventEmitter {
  constructor(child, { requestTimeoutMs = 30_000 } = {}) {
    super();
    this.child = child;
    this.requestTimeoutMs = requestTimeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    this.reader = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.reader.on("line", (line) => this.#onLine(line));
    child.once("error", (error) => this.#close(error));
    child.once("exit", (code, signal) => this.#close(new Error(`Codex runtime exited (${code ?? signal ?? "unknown"})`)));
  }

  async initialize(expectedVersion) {
    const result = await this.call("initialize", {
      clientInfo: { name: "brai", title: "Brai", version: "1" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    if (!String(result?.userAgent || "").includes(expectedVersion)) {
      throw new BrokerError("BRAI_RUNTIME_VERSION_MISMATCH", "Codex runtime version mismatch");
    }
    this.notify("initialized", {});
    return result;
  }

  call(method, params = {}) {
    if (this.closed) return Promise.reject(new BrokerError("BRAI_RUNTIME_UNAVAILABLE", "Codex runtime is unavailable"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BrokerError("BRAI_RUNTIME_TIMEOUT", "Codex runtime request timed out"));
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.#write({ id, method, params });
    });
  }

  notify(method, params = {}) {
    this.#write({ method, params });
  }

  close() {
    if (!this.closed) this.child.stdin.end();
  }

  #write(message) {
    const line = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
      throw new BrokerError("BRAI_REQUEST_TOO_LARGE", "Runtime request is too large");
    }
    this.child.stdin.write(line);
  }

  #onLine(line) {
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
      this.#close(new Error("Codex runtime emitted an oversized message"));
      this.child.kill("SIGKILL");
      return;
    }
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.#close(new Error("Codex runtime emitted invalid JSON"));
      this.child.kill("SIGKILL");
      return;
    }
    if (message.id != null && ("result" in message || "error" in message)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new AppServerError(message.error));
      else pending.resolve(message.result);
      return;
    }
    if (typeof message.method === "string" && message.id == null) {
      if (message.method !== "item/reasoning/textDelta") this.emit("notification", message);
      return;
    }
    if (message.id != null) {
      this.#write({ id: message.id, error: { code: -32601, message: "Server requests are disabled" } });
    }
  }

  #close(error) {
    if (this.closed) return;
    this.closed = true;
    this.reader.close();
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new BrokerError("BRAI_RUNTIME_UNAVAILABLE", "Codex runtime is unavailable"));
    }
    this.pending.clear();
    this.emit("closed", error);
  }
}

export class RuntimeManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.spawn = options.spawn ?? nodeSpawn;
    this.fs = options.fs ?? fs;
    this.now = options.now ?? Date.now;
    this.dockerBin = options.dockerBin ?? "/usr/bin/docker";
    this.image = options.image ?? "brai-codex-app-server:0.144.4";
    this.expectedVersion = options.expectedVersion ?? "0.144.4";
    this.environment = requirePattern(options.environment ?? "prod", ENVIRONMENT_ID, "environment");
    this.stateRoot = path.resolve(options.stateRoot ?? "/srv/opt/brai-codex-runtime/prod");
    this.attachmentRoot = path.resolve(options.attachmentRoot ?? "/srv/projects/brai/vault");
    this.workspacePath = path.resolve(options.workspacePath ?? "/srv/opt/brai-codex-broker/workspace");
    this.authPath = path.resolve(options.authPath ?? "/srv/opt/codex-home/auth.json");
    this.configPath = path.resolve(options.configPath ?? "/srv/opt/brai-codex-broker/config.toml");
    this.requirementsPath = path.resolve(options.requirementsPath ?? "/srv/opt/brai-codex-broker/requirements.toml");
    this.seccompPath = path.resolve(options.seccompPath ?? "/srv/opt/brai-codex-broker/seccomp.json");
    this.apparmorProfile = requireOpaque(options.apparmorProfile ?? "brai-codex-app-server", "apparmorProfile");
    this.network = requireOpaque(options.network ?? "brai-codex-egress", "network");
    this.idleMs = positiveInteger(options.idleMs ?? DEFAULT_IDLE_MS, "idleMs");
    this.stopGraceMs = positiveInteger(options.stopGraceMs ?? 5_000, "stopGraceMs");
    this.runtimes = new Map();
    this.runtimeStarts = new Map();
    this.steerRequests = new Map();
    this.ready = false;
  }

  async preflight() {
    await this.#verifyFixedPaths();
    const runtime = await this.#startRuntime("__readiness__", []);
    try {
      requireRuntimeConfig(await runtime.app.call("config/read", { cwd: WORKSPACE }));
      requireRuntimeRequirements(await runtime.app.call("configRequirements/read"));
      const account = await runtime.app.call("account/read", { refreshToken: true });
      if (account?.requiresOpenaiAuth && !account?.account) {
        throw new BrokerError("BRAI_RUNTIME_AUTH_UNAVAILABLE", "Codex runtime authentication is unavailable");
      }
      const models = await runtime.app.call("model/list", { limit: 1 });
      if (!Array.isArray(models?.data) || models.data.length === 0) {
        throw new BrokerError("BRAI_RUNTIME_CAPABILITY_UNAVAILABLE", "Codex model capability is unavailable");
      }
      const profiles = await runtime.app.call("permissionProfile/list", { cwd: WORKSPACE });
      if (!profiles?.data?.some((profile) => profile?.id === "brai-chat" && profile?.allowed !== false)) {
        throw new BrokerError("BRAI_RUNTIME_PERMISSION_PROFILE_UNAVAILABLE", "Codex runtime permission profile is unavailable");
      }
      const canary = await runtime.app.call("command/exec", {
        command: [
          "/bin/sh", "-c",
          "if /bin/cat /codex-home/auth.json >/dev/null 2>&1; then exit 23; fi; if /bin/cat /proc/1/root/codex-home/auth.json >/dev/null 2>&1; then exit 24; fi; if /usr/local/bin/node -e \"const d=require('node:dgram').createSocket('udp4'); d.once('error',()=>process.exit(1)); d.bind(0,'127.0.0.1',()=>d.close(()=>process.exit(0)))\" >/dev/null 2>&1; then exit 25; fi; printf BRAI_PERMISSION_OK",
        ],
        cwd: WORKSPACE,
        permissionProfile: "brai-chat",
        timeoutMs: 5_000,
        outputBytesCap: 256,
      });
      if (canary?.exitCode !== 0 || canary?.stdout !== "BRAI_PERMISSION_OK" || canary?.stderr) {
        throw new BrokerError("BRAI_RUNTIME_PERMISSION_PROFILE_UNSAFE", "Codex runtime credential isolation failed");
      }
      const started = await runtime.app.call("thread/start", safeThreadParams({ ephemeral: true }));
      const threadId = started?.thread?.id;
      if (!threadId) throw new BrokerError("BRAI_RUNTIME_CAPABILITY_UNAVAILABLE", "Codex thread capability is unavailable");
      requirePermissionProfile(started);
      await runtime.app.call("thread/read", { threadId, includeTurns: false });
      this.ready = true;
    } finally {
      await this.#stopRuntime(runtime);
    }
  }

  readiness() {
    return {
      ready: this.ready,
      codexVersion: this.expectedVersion,
      capabilities: this.ready ? ["model/list", "thread/start", "thread/resume", "thread/read", "turn/start", "turn/steer", "turn/interrupt"] : [],
    };
  }

  async ensureRuntime(userId, attachments = null) {
    requireOpaque(userId, "userId");
    let runtime = this.runtimes.get(userId);
    if (attachments == null && runtime) {
      runtime.lastUsed = this.now();
      return runtime;
    }
    if (attachments == null) {
      const starting = this.runtimeStarts.get(userId);
      if (starting) return await starting.promise;
    }
    const selected = await this.#resolveAttachments(userId, attachments ?? []);
    const mountKey = selected.map(({ id, digest }) => `${id}:${digest}`).sort().join("\n");
    if (runtime && runtime.mountKey !== mountKey) {
      if (runtime.activeRequests > 0 || runtime.activeTurns.size > 0) {
        throw new BrokerError("BRAI_RUNTIME_BUSY", "Codex runtime is busy with a different attachment set");
      }
      await this.#stopRuntime(runtime);
      runtime = null;
    }
    if (!runtime) {
      let start = this.runtimeStarts.get(userId);
      if (!start) {
        const promise = this.#startRuntime(userId, selected)
          .then((started) => {
            this.runtimes.set(userId, started);
            return started;
          })
          .finally(() => {
            if (this.runtimeStarts.get(userId)?.promise === promise) this.runtimeStarts.delete(userId);
          });
        start = { mountKey, promise };
        this.runtimeStarts.set(userId, start);
      }
      if (start.mountKey !== mountKey) {
        throw new BrokerError("BRAI_RUNTIME_BUSY", "Codex runtime is starting with a different attachment set");
      }
      runtime = await start.promise;
    }
    runtime.lastUsed = this.now();
    return runtime;
  }

  async request(userId, method, params, attachments = null) {
    const runtime = await this.ensureRuntime(userId, attachments);
    return this.#requestRuntime(runtime, method, params);
  }

  async #requestRuntime(runtime, method, params) {
    runtime.activeRequests += 1;
    runtime.lastUsed = this.now();
    try {
      const result = await runtime.app.call(method, params);
      if ((method === "thread/start" || method === "thread/resume") && result?.thread?.id) {
        runtime.loadedThreads.add(result.thread.id);
      }
      if (method === "turn/start" && result?.turn?.id) {
        runtime.activeTurns.add(result.turn.id);
      }
      if (method === "thread/read" && Array.isArray(result?.thread?.turns)) {
        for (const turn of result.thread.turns) {
          if (!turn?.id) continue;
          if (turn.status === "inProgress") runtime.activeTurns.add(turn.id);
          if (turn.status === "completed" || turn.status === "interrupted" || turn.status === "failed") {
            runtime.activeTurns.delete(turn.id);
          }
        }
      }
      return result;
    } catch (error) {
      throw safeUpstreamError(error);
    } finally {
      runtime.activeRequests -= 1;
      runtime.lastUsed = this.now();
    }
  }

  async stopRuntime(userId) {
    requireOpaque(userId, "userId");
    const runtime = this.runtimes.get(userId);
    if (!runtime) return false;
    if (runtime.activeRequests > 0 || runtime.activeTurns.size > 0) {
      throw new BrokerError("BRAI_RUNTIME_BUSY", "Codex runtime has an active turn");
    }
    await this.#stopRuntime(runtime);
    return true;
  }

  notificationWatermark(userId) {
    const runtime = this.runtimes.get(userId);
    return { sequence: runtime?.notificationSequence ?? 0, epoch: runtime?.notificationEpoch ?? null };
  }

  async steer(userId, { threadId, turnId, text, clientUserMessageId, attachments = [] }) {
    const runtime = this.runtimes.get(userId) ?? await this.ensureRuntime(userId, attachments);
    const key = `${userId}\0${threadId}\0${turnId}\0${clientUserMessageId}`;
    if (runtime.deliveredSteers.has(key)) return { deduplicated: true };
    if (this.steerRequests.has(key)) return this.steerRequests.get(key);
    const request = (async () => {
      const snapshot = await this.#requestRuntime(runtime, "thread/read", { threadId, includeTurns: true });
      if (!hasClientMessage(snapshot, turnId, clientUserMessageId)) {
        await this.#requestRuntime(runtime, "turn/steer", {
          threadId, expectedTurnId: turnId, clientUserMessageId,
          input: userInput(text, attachments),
        });
      }
      runtime.deliveredSteers.add(key);
      return { deduplicated: hasClientMessage(snapshot, turnId, clientUserMessageId) };
    })().finally(() => this.steerRequests.delete(key));
    this.steerRequests.set(key, request);
    return request;
  }

  async sweepIdle(now = this.now()) {
    const stops = [];
    for (const runtime of this.runtimes.values()) {
      if (runtime.activeRequests === 0 && runtime.activeTurns.size === 0 && now - runtime.lastUsed >= this.idleMs) {
        stops.push(this.#stopRuntime(runtime));
      }
    }
    await Promise.all(stops);
    return stops.length;
  }

  async close() {
    await Promise.allSettled([...this.runtimeStarts.values()].map(({ promise }) => promise));
    await Promise.all([...this.runtimes.values()].map((runtime) => this.#stopRuntime(runtime)));
  }

  async #startRuntime(userId, attachments) {
    const digest = createHash("sha256").update(`${this.environment}\0${userId}`).digest("hex").slice(0, 24);
    const home = contained(this.stateRoot, path.join("users", digest));
    await this.fs.mkdir(home, { recursive: true, mode: 0o700 });
    const staging = attachments.length
      ? contained(this.stateRoot, path.join("staging", randomUUID()))
      : null;
    const stagedAttachments = [];
    if (staging) {
      await this.fs.mkdir(staging, { recursive: true, mode: 0o700 });
      for (const attachment of attachments) {
        const source = contained(staging, attachment.id);
        await this.fs.writeFile(source, attachment.data, { flag: "wx", mode: 0o400 });
        stagedAttachments.push({ ...attachment, source });
      }
    }
    const auth = await this.fs.stat(this.authPath);
    const name = `brai-codex-${this.environment}-${digest}`;
    const args = [
      "run", "--rm", "--interactive", "--name", name,
      "--label", "world.brightos.brai.component=codex-app-server",
      "--label", `world.brightos.brai.environment=${this.environment}`,
      "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges:true",
      "--security-opt", "systempaths=unconfined",
      "--security-opt", `seccomp=${this.seccompPath}`,
      "--security-opt", `apparmor=${this.apparmorProfile}`,
      "--pids-limit=128", "--memory=2g", "--cpus=2", "--network", this.network,
      "--user", `${process.getuid?.() ?? 65532}:${auth.gid}`,
      "--workdir", WORKSPACE,
      "--env", "CODEX_HOME=/codex-home", "--env", "HOME=/codex-home", "--env", "TMPDIR=/tmp",
      "--mount", bindMount(home, "/codex-home"),
      "--mount", bindMount(this.authPath, "/codex-home/auth.json", true),
      "--mount", bindMount(this.configPath, "/codex-home/config.toml", true),
      "--mount", bindMount(this.requirementsPath, "/etc/codex/requirements.toml", true),
      "--mount", bindMount(this.workspacePath, WORKSPACE, true),
      "--tmpfs", `/tmp:rw,noexec,nosuid,nodev,size=64m,uid=${process.getuid?.() ?? 65532},gid=${auth.gid},mode=0700`,
      ...stagedAttachments.flatMap(({ id, source }) => ["--mount", bindMount(source, `/attachments/${id}`, true)]),
      this.image,
    ];
    const child = this.spawn(this.dockerBin, args, { stdio: ["pipe", "pipe", "pipe"] });
    child.stderr?.resume();
    const app = new AppServerProcess(child);
    const runtime = {
      app, child, name, userId,
      mountKey: attachments.map(({ id, digest: attachmentDigest }) => `${id}:${attachmentDigest}`).sort().join("\n"),
      activeRequests: 0,
      activeTurns: new Set(),
      loadedThreads: new Set(),
      deliveredSteers: new Set(),
      notificationSequence: 0,
      notificationEpoch: randomUUID(),
      lastUsed: this.now(),
      stopping: null,
    };
    app.on("notification", (message) => this.#onNotification(runtime, message));
    app.on("closed", () => {
      if (this.runtimes.get(userId) === runtime) this.runtimes.delete(userId);
    });
    try {
      await app.initialize(this.expectedVersion);
      const account = await app.call("account/read", { refreshToken: false });
      if (account?.requiresOpenaiAuth && !account?.account) {
        throw new BrokerError("BRAI_RUNTIME_AUTH_UNAVAILABLE", "Codex runtime authentication is unavailable");
      }
      return runtime;
    } catch (error) {
      await this.#stopRuntime(runtime);
      throw safeUpstreamError(error);
    } finally {
      if (staging) await this.fs.rm(staging, { recursive: true, force: true });
    }
  }

  #onNotification(runtime, message) {
    runtime.lastUsed = this.now();
    runtime.notificationSequence += 1;
    const { turnId } = correlation(message.params);
    if (message.method === "turn/started" && turnId) runtime.activeTurns.add(turnId);
    if (message.method === "turn/completed" && turnId) runtime.activeTurns.delete(turnId);
    this.emit("notification", {
      userId: runtime.userId, sequence: runtime.notificationSequence,
      epoch: runtime.notificationEpoch, message,
    });
  }

  async #stopRuntime(runtime) {
    if (runtime.stopping) return runtime.stopping;
    const stopping = (async () => {
      runtime.app.close();
      if (runtime.child.exitCode == null && runtime.child.signalCode == null) {
        await Promise.race([
          new Promise((resolve) => runtime.child.once("exit", resolve)),
          new Promise((resolve) => {
            const timer = setTimeout(resolve, this.stopGraceMs);
            timer.unref?.();
          }),
        ]);
      }
      if (runtime.child.exitCode == null && runtime.child.signalCode == null) {
        const stopper = this.spawn(this.dockerBin, ["stop", "--time", "5", runtime.name], { stdio: "ignore" });
        const { code, signal } = await new Promise((resolve, reject) => {
          stopper.once("error", reject);
          stopper.once("exit", (exitCode, exitSignal) => resolve({ code: exitCode, signal: exitSignal }));
        });
        if (code !== 0 || signal != null) {
          throw new BrokerError("BRAI_RUNTIME_STOP_FAILED", "Codex runtime could not be stopped safely");
        }
      }
      if (this.runtimes.get(runtime.userId) === runtime) this.runtimes.delete(runtime.userId);
    })();
    runtime.stopping = stopping;
    try {
      return await stopping;
    } catch (error) {
      if (runtime.stopping === stopping) runtime.stopping = null;
      throw error;
    }
  }

  async #verifyFixedPaths() {
    const [auth, config, requirements, seccomp, workspace, state, attachments] = await Promise.all([
      this.fs.stat(this.authPath), this.fs.stat(this.configPath), this.fs.stat(this.requirementsPath), this.fs.stat(this.seccompPath), this.fs.stat(this.workspacePath),
      this.fs.stat(this.stateRoot), this.fs.stat(this.attachmentRoot),
    ]);
    if (!auth.isFile() || !config.isFile() || !requirements.isFile() || !seccomp.isFile() || !workspace.isDirectory() || !state.isDirectory() || !attachments.isDirectory()) {
      throw new BrokerError("BRAI_RUNTIME_CONFIGURATION_INVALID", "Codex runtime paths are invalid");
    }
  }

  async #resolveAttachments(userId, attachments) {
    if (!Array.isArray(attachments) || attachments.length > MAX_ATTACHMENTS) {
      throw new BrokerError("BRAI_ATTACHMENT_INVALID", "Invalid attachment selection");
    }
    const selected = [];
    let total = 0;
    const seen = new Set();
    for (const attachment of attachments) {
      exactObject(attachment, ["id", "threadId"], ["id", "threadId"]);
      const id = requireOpaque(attachment.id, "attachment.id");
      const threadId = requireOpaque(attachment.threadId, "attachment.threadId");
      if (seen.has(id)) throw new BrokerError("BRAI_ATTACHMENT_INVALID", "Duplicate attachment selection");
      seen.add(id);
      let handle;
      try {
        handle = await this.#openAttachment(userId, threadId, id);
        const stat = await handle.stat();
        if (!stat.isFile()) throw new BrokerError("BRAI_ATTACHMENT_INVALID", "Selected attachment is unavailable");
        total += stat.size;
        const data = await handle.readFile();
        if (data.length !== stat.size || total > MAX_ATTACHMENT_BYTES || !hasImageSignature(data)) {
          throw new BrokerError("BRAI_ATTACHMENT_INVALID", "Selected attachment is invalid");
        }
        selected.push({ id, data, digest: createHash("sha256").update(data).digest("hex") });
      } catch (error) {
        if (error instanceof BrokerError) throw error;
        throw new BrokerError("BRAI_ATTACHMENT_INVALID", "Selected attachment is unavailable");
      } finally {
        await handle?.close();
      }
    }
    return selected;
  }

  async #openAttachment(userId, threadId, id) {
    const directoryFlags = fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW;
    const directories = [];
    try {
      let current = await this.fs.open(this.attachmentRoot, directoryFlags);
      directories.push(current);
      for (const segment of [userId, "Brai", "Chat", threadId]) {
        const next = await this.fs.open(`/proc/self/fd/${current.fd}/${segment}`, directoryFlags);
        directories.push(next);
        current = next;
      }
      return await this.fs.open(`/proc/self/fd/${current.fd}/${id}`,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    } finally {
      await Promise.allSettled(directories.reverse().map((handle) => handle.close()));
    }
  }
}

export class BrokerServer {
  constructor(manager, { socketPath, maxLineBytes = MAX_LINE_BYTES } = {}) {
    this.manager = manager;
    this.socketPath = path.resolve(socketPath);
    this.maxLineBytes = maxLineBytes;
    this.server = net.createServer((socket) => this.#accept(socket));
    this.clients = new Set();
    manager.on("notification", ({ userId, sequence, epoch, message }) =>
      this.#broadcast(userId, sequence, epoch, message));
  }

  async listen() {
    await fs.mkdir(path.dirname(this.socketPath), { recursive: true });
    await fs.unlink(this.socketPath).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.socketPath, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    await fs.chmod(this.socketPath, 0o660);
  }

  async close() {
    for (const client of this.clients) client.socket.destroy();
    if (this.server.listening) await new Promise((resolve) => this.server.close(resolve));
    await fs.unlink(this.socketPath).catch(() => {});
    await this.manager.close();
  }

  #accept(socket) {
    socket.setEncoding("utf8");
    const client = { socket, buffer: "", subscriptions: new Map() };
    this.clients.add(client);
    socket.on("data", (chunk) => this.#read(client, chunk));
    socket.on("close", () => this.clients.delete(client));
    socket.on("error", () => this.clients.delete(client));
  }

  #read(client, chunk) {
    client.buffer += chunk;
    if (Buffer.byteLength(client.buffer) > this.maxLineBytes) {
      client.socket.destroy();
      return;
    }
    let newline;
    while ((newline = client.buffer.indexOf("\n")) >= 0) {
      const line = client.buffer.slice(0, newline);
      client.buffer = client.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      void this.#dispatch(client, line);
    }
  }

  async #dispatch(client, line) {
    let request;
    try {
      request = JSON.parse(line);
      validateRequest(request);
      const result = await this.#handle(client, request.method, request.params ?? {});
      send(client.socket, { id: request.id, result });
    } catch (error) {
      const id = request && validRequestId(request.id) ? request.id : null;
      const safe = error instanceof BrokerError ? error : new BrokerError("BRAI_BROKER_ERROR", "Brai Codex broker request failed");
      send(client.socket, { id, error: { code: safe.code, message: safe.message } });
    }
  }

  async #handle(client, method, params) {
    switch (method) {
      case "readiness":
        exactObject(params, [], []);
        return this.manager.readiness();
      case "ensureRuntime": {
        exactObject(params, ["userId"], ["userId"]);
        await this.manager.ensureRuntime(params.userId);
        return { ready: true };
      }
      case "listModels": {
        exactObject(params, ["userId", "cursor", "limit"], ["userId"]);
        const query = {};
        if (params.cursor != null) query.cursor = boundedString(params.cursor, 256, "cursor");
        if (params.limit != null) query.limit = integerBetween(params.limit, 1, 100, "limit");
        return this.manager.request(requireOpaque(params.userId, "userId"), "model/list", query);
      }
      case "startThread": {
        exactObject(params, ["userId", "model", "reasoningEffort", "attachments"], ["userId"]);
        if (params.reasoningEffort != null) requirePattern(params.reasoningEffort, EFFORT, "reasoningEffort");
        const result = await this.manager.request(
          requireOpaque(params.userId, "userId"),
          "thread/start",
          safeThreadParams({ model: optionalModel(params.model) }),
          params.attachments ?? [],
        );
        requirePermissionProfile(result);
        const threadId = result?.thread?.id;
        if (!threadId) throw new BrokerError("BRAI_UPSTREAM_ERROR", "Codex runtime did not return a thread");
        return { threadId };
      }
      case "resumeThread": {
        exactObject(params, ["userId", "threadId", "model", "attachments"], ["userId", "threadId"]);
        const result = await this.manager.request(
          requireOpaque(params.userId, "userId"),
          "thread/resume",
          safeThreadParams({
            threadId: requireOpaque(params.threadId, "threadId"), model: optionalModel(params.model),
          }),
          params.attachments ?? [],
        );
        requirePermissionProfile(result);
        return {};
      }
      case "readThread": {
        exactObject(params, ["userId", "threadId", "includeTurns"], ["userId", "threadId"]);
        const userId = requireOpaque(params.userId, "userId");
        const watermark = this.manager.notificationWatermark(userId);
        const result = await this.manager.request(userId, "thread/read", {
          threadId: requireOpaque(params.threadId, "threadId"), includeTurns: params.includeTurns === true,
        });
        return {
          ...result,
          notificationWatermark: watermark.sequence,
          notificationEpoch: watermark.epoch,
        };
      }
      case "startTurn": {
        exactObject(params, ["userId", "threadId", "text", "model", "reasoningEffort", "clientUserMessageId", "attachments"], ["userId", "threadId", "text"]);
        const userId = requireOpaque(params.userId, "userId");
        autoSubscribe(client, userId);
        const attachments = params.attachments ?? [];
        const threadId = requireOpaque(params.threadId, "threadId");
        const runtime = await this.manager.ensureRuntime(userId, attachments);
        if (!runtime.loadedThreads.has(threadId)) {
          const resumed = await this.manager.request(userId, "thread/resume", safeThreadParams({
            threadId,
            model: optionalModel(params.model),
          }), attachments);
          requirePermissionProfile(resumed);
        }
        const result = await this.manager.request(userId, "turn/start", safeTurnParams(params), attachments);
        const turnId = result?.turn?.id;
        if (!turnId) throw new BrokerError("BRAI_UPSTREAM_ERROR", "Codex runtime did not return a turn");
        return { turnId };
      }
      case "steerTurn": {
        exactObject(params, ["userId", "threadId", "turnId", "text", "clientUserMessageId", "attachments"], ["userId", "threadId", "turnId", "text", "clientUserMessageId"]);
        const userId = requireOpaque(params.userId, "userId");
        autoSubscribe(client, userId);
        return this.manager.steer(userId, {
          threadId: requireOpaque(params.threadId, "threadId"),
          turnId: requireOpaque(params.turnId, "turnId"),
          clientUserMessageId: requireOpaque(params.clientUserMessageId, "clientUserMessageId"),
          text: boundedString(params.text, MAX_TEXT_BYTES, "text", true),
          attachments: params.attachments ?? [],
        });
      }
      case "interruptTurn": {
        exactObject(params, ["userId", "threadId", "turnId"], ["userId", "threadId", "turnId"]);
        return this.manager.request(requireOpaque(params.userId, "userId"), "turn/interrupt", {
          threadId: requireOpaque(params.threadId, "threadId"), turnId: requireOpaque(params.turnId, "turnId"),
        });
      }
      case "subscribe": {
        exactObject(params, ["userId", "threadId", "turnId"], ["userId"]);
        const subscriptionId = randomUUID();
        client.subscriptions.set(subscriptionId, {
          userId: requireOpaque(params.userId, "userId"),
          threadId: optionalOpaque(params.threadId, "threadId"),
          turnId: optionalOpaque(params.turnId, "turnId"),
        });
        const watermark = this.manager.notificationWatermark(params.userId);
        return {
          subscriptionId, notificationWatermark: watermark.sequence,
          notificationEpoch: watermark.epoch,
        };
      }
      case "unsubscribe": {
        exactObject(params, ["subscriptionId"], ["subscriptionId"]);
        const subscriptionId = boundedString(params.subscriptionId, 128, "subscriptionId");
        return { removed: client.subscriptions.delete(subscriptionId) };
      }
      case "stopRuntime": {
        exactObject(params, ["userId"], ["userId"]);
        return { stopped: await this.manager.stopRuntime(params.userId) };
      }
      default:
        throw new BrokerError("BRAI_METHOD_NOT_ALLOWED", "Broker method is not allowed");
    }
  }

  #broadcast(userId, sequence, epoch, message) {
    const ids = correlation(message.params);
    for (const client of this.clients) {
      const subscriptions = [...client.subscriptions.values()];
      if (!subscriptions.some((item) => item.userId === userId
        && (!item.threadId || item.threadId === ids.threadId)
        && (!item.turnId || item.turnId === ids.turnId))) continue;
      send(client.socket, {
        method: "notification",
        params: {
          userId, threadId: ids.threadId, turnId: ids.turnId,
          notificationSequence: sequence, notificationEpoch: epoch,
          method: message.method, params: message.params ?? {},
        },
      });
    }
  }
}

function safeThreadParams(extra = {}) {
  return {
    approvalPolicy: "never",
    permissions: "brai-chat",
    cwd: WORKSPACE,
    developerInstructions: ASSISTANT_INSTRUCTIONS,
    ...Object.fromEntries(Object.entries(extra).filter(([, value]) => value != null)),
  };
}

function safeTurnParams(params) {
  return {
    threadId: requireOpaque(params.threadId, "threadId"),
    approvalPolicy: "never",
    permissions: "brai-chat",
    cwd: WORKSPACE,
    input: userInput(params.text, params.attachments ?? []),
    ...(optionalModel(params.model) ? { model: params.model } : {}),
    ...(params.reasoningEffort != null ? { effort: requirePattern(params.reasoningEffort, EFFORT, "reasoningEffort") } : {}),
    ...(params.clientUserMessageId != null ? { clientUserMessageId: requireOpaque(params.clientUserMessageId, "clientUserMessageId") } : {}),
  };
}

function requirePermissionProfile(result) {
  if (result?.activePermissionProfile?.id !== "brai-chat") {
    throw new BrokerError("BRAI_RUNTIME_PERMISSION_PROFILE_UNSAFE", "Codex runtime permission profile is not active");
  }
}

function requireRuntimeConfig(result) {
  const config = result?.config;
  const features = config?.features;
  if (config?.approval_policy !== "never"
    || config?.default_permissions !== "brai-chat"
    || config?.web_search !== "disabled"
    || config?.sandbox_mode != null
    || !disabledFeatures(features)) {
    throw new BrokerError("BRAI_RUNTIME_CONFIGURATION_INVALID", "Codex runtime configuration is unsafe");
  }
}

function requireRuntimeRequirements(result) {
  const requirements = result?.requirements;
  const enabledProfiles = requirements?.allowedPermissionProfiles
    && Object.entries(requirements.allowedPermissionProfiles)
      .filter(([, allowed]) => allowed === true)
      .map(([profile]) => profile);
  if (!sameValues(requirements?.allowedApprovalPolicies, ["never"])
    || !sameValues(enabledProfiles, ["brai-chat"])
    || requirements?.defaultPermissions !== "brai-chat"
    || !sameValues(requirements?.allowedWebSearchModes, ["disabled"])
    || requirements?.allowManagedHooksOnly !== true
    || requirements?.allowAppshots !== false
    || requirements?.allowRemoteControl !== false
    || !disabledFeatures(requirements?.featureRequirements)) {
    throw new BrokerError("BRAI_RUNTIME_CONFIGURATION_INVALID", "Codex runtime requirements are unsafe");
  }
}

function disabledFeatures(features) {
  return features?.apps === false
    && features?.plugins === false
    && features?.tool_suggest === false
    && features?.enable_mcp_apps === false;
}

function sameValues(actual, expected) {
  return Array.isArray(actual)
    && actual.length === expected.length
    && expected.every((value) => actual.includes(value));
}

function userInput(text, attachments) {
  const value = boundedString(text, MAX_TEXT_BYTES, "text", true);
  if (!Array.isArray(attachments) || attachments.length > MAX_ATTACHMENTS) {
    throw new BrokerError("BRAI_ATTACHMENT_INVALID", "Invalid attachment selection");
  }
  return [
    { type: "text", text: value },
    ...attachments.map((attachment) => ({ type: "localImage", path: `/attachments/${requireOpaque(attachment.id, "attachment.id")}` })),
  ];
}

function autoSubscribe(client, userId) {
  const subscriptionId = `auto:${userId}`;
  if (!client.subscriptions.has(subscriptionId)) client.subscriptions.set(subscriptionId, { userId, threadId: null, turnId: null });
}

function correlation(params = {}) {
  return {
    threadId: params.threadId ?? params.thread?.id ?? params.turn?.threadId ?? null,
    turnId: params.turnId ?? params.turn?.id ?? params.item?.turnId ?? null,
  };
}

function hasClientMessage(snapshot, turnId, clientUserMessageId) {
  const turns = Array.isArray(snapshot?.thread?.turns) ? snapshot.thread.turns : [];
  const turn = turns.find((item) => item?.id === turnId);
  return Boolean(turn?.items?.some((item) =>
    item?.type === "userMessage" && item.clientId === clientUserMessageId));
}

function safeUpstreamError(error) {
  if (error instanceof BrokerError) return error;
  const message = String(error?.message || "").toLowerCase();
  if (/auth|login|credential|unauthorized/.test(message)) return new BrokerError("BRAI_UPSTREAM_AUTH", "Codex authentication is unavailable");
  if (/rate.?limit|quota|capacity/.test(message)) return new BrokerError("BRAI_UPSTREAM_RATE_LIMIT", "Codex capacity is temporarily unavailable");
  if (/overload|busy|retry later/.test(message)) return new BrokerError("BRAI_UPSTREAM_OVERLOAD", "Codex is temporarily overloaded");
  return new BrokerError("BRAI_UPSTREAM_ERROR", "Codex runtime request failed");
}

function validateRequest(request) {
  exactObject(request, ["id", "method", "params"], ["id", "method"]);
  if (!validRequestId(request.id)) throw new BrokerError("BRAI_INVALID_REQUEST", "Invalid request id");
  boundedString(request.method, 64, "method");
  if (request.params != null && (!request.params || typeof request.params !== "object" || Array.isArray(request.params))) {
    throw new BrokerError("BRAI_INVALID_REQUEST", "Invalid request params");
  }
}

function validRequestId(id) {
  return (Number.isSafeInteger(id) && id >= 0) || (typeof id === "string" && id.length > 0 && id.length <= 128);
}

function exactObject(value, allowed, required) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BrokerError("BRAI_INVALID_REQUEST", "Expected an object");
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new BrokerError("BRAI_INVALID_REQUEST", `Unexpected field: ${key}`);
  for (const key of required) if (!(key in value)) throw new BrokerError("BRAI_INVALID_REQUEST", `Missing field: ${key}`);
}

function requireOpaque(value, name) {
  return requirePattern(value, OPAQUE_ID, name);
}

function optionalOpaque(value, name) {
  return value == null ? null : requireOpaque(value, name);
}

function optionalModel(value) {
  return value == null ? null : requirePattern(value, MODEL_ID, "model");
}

function requirePattern(value, pattern, name) {
  if (typeof value !== "string" || !pattern.test(value)) throw new BrokerError("BRAI_INVALID_REQUEST", `Invalid ${name}`);
  return value;
}

function boundedString(value, maxBytes, name, allowEmpty = false) {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) || Buffer.byteLength(value) > maxBytes) {
    throw new BrokerError("BRAI_INVALID_REQUEST", `Invalid ${name}`);
  }
  return value;
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new BrokerError("BRAI_RUNTIME_CONFIGURATION_INVALID", `Invalid ${name}`);
  return value;
}

function integerBetween(value, min, max, name) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new BrokerError("BRAI_INVALID_REQUEST", `Invalid ${name}`);
  return value;
}

function contained(root, relative) {
  const candidate = path.resolve(root, relative);
  if (candidate === root || !candidate.startsWith(`${root}${path.sep}`)) {
    throw new BrokerError("BRAI_PATH_REJECTED", "Resolved path escapes its allowed root");
  }
  return candidate;
}

function bindMount(source, target, readonly = false) {
  return `type=bind,src=${source},dst=${target}${readonly ? ",readonly" : ""}`;
}

function hasImageSignature(buffer) {
  const head = buffer.subarray(0, 12);
  return head.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
    || head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    || (head.subarray(0, 4).toString("ascii") === "RIFF" && head.subarray(8, 12).toString("ascii") === "WEBP");
}

function send(socket, message) {
  if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
}
