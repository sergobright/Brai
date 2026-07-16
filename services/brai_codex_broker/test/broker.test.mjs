import assert from "node:assert/strict";
import { spawn as nodeSpawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { AppServerProcess, BrokerServer, RuntimeManager } from "../src/broker.mjs";
import { BraiCodexBrokerClient } from "../src/client.mjs";

const USER_A = "user_00000001";
const USER_B = "user_00000002";
const THREAD = "thread_00000001";
const TURN = "turn_000000001";
const ATTACHMENT = "attach_0000001";
const IMAGE_ITEM = "image_item_0001";
const GENERATED_ATTACHMENT = "generated_attach_0001";
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const GENERATED_ROOT = "/codex-home/generated_images";
const LARGE_IMAGE_RESULT = "A".repeat(4 * 1024 * 1024);

function generatedPath(filename, threadId = THREAD) {
  return path.posix.join(GENERATED_ROOT, threadId, filename);
}

class FakeDocker {
  calls = [];
  runtimes = [];
  sequence = 0;
  turnItems = [];
  turnStatus = "inProgress";
  emitTurnStarted = true;
  hangOnClose = false;
  stopExitCode = 0;
  execLocally = false;
  generatedHostRoot = null;
  titleResponse = "Хайку о весне";
  config = {
    config: {
      approval_policy: "never",
      default_permissions: "brai-chat",
      sandbox_mode: null,
      web_search: "disabled",
      features: { apps: false, plugins: false, tool_suggest: false, enable_mcp_apps: false },
    },
    origins: {},
  };
  requirements = {
    requirements: {
      allowedApprovalPolicies: ["never"],
      allowedPermissionProfiles: { "brai-chat": true },
      defaultPermissions: "brai-chat",
      allowedWebSearchModes: ["disabled"],
      allowManagedHooksOnly: true,
      allowAppshots: false,
      allowRemoteControl: false,
      featureRequirements: { apps: false, plugins: false, tool_suggest: false, enable_mcp_apps: false },
    },
  };
  canary = { exitCode: 0, stdout: "BRAI_PERMISSION_OK", stderr: "" };

  spawn = (command, args, options) => {
    this.calls.push({ command, args, options });
    if (args[0] === "stop") return exitedChild(this.stopExitCode);
    if (args[0] === "exec" && this.execLocally) {
      const localArgs = args.slice(3);
      if (this.generatedHostRoot) {
        const scriptIndex = localArgs.indexOf("-e") + 1;
        localArgs[scriptIndex] = localArgs[scriptIndex].replace(
          'const ROOT = "/codex-home/generated_images";',
          `const ROOT = ${JSON.stringify(this.generatedHostRoot)};`,
        );
        localArgs[localArgs.length - 1] = path.join(
          this.generatedHostRoot,
          path.posix.relative(GENERATED_ROOT, localArgs.at(-1)),
        );
      }
      return nodeSpawn(args[2], localArgs, options);
    }
    assert.equal(args[0], "run");
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    child.requests = [];
    child.kill = (signal) => finish(child, null, signal);
    child.stdin.setEncoding("utf8");
    let buffer = "";
    child.stdin.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line) this.#request(child, JSON.parse(line));
      }
    });
    child.stdin.on("finish", () => {
      if (!this.hangOnClose) finish(child, 0, null);
    });
    this.runtimes.push(child);
    queueMicrotask(() => child.emit("spawn"));
    return child;
  };

  #request(child, request) {
    child.requests.push(request);
    if (request.id == null) return;
    const respond = (result) => child.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
    switch (request.method) {
      case "initialize":
        respond({ userAgent: "codex_app_server_rs/0.144.4", codexHome: "/codex-home", platformFamily: "unix", platformOs: "linux" });
        break;
      case "account/read":
        respond({ account: { type: "chatgpt", email: null, planType: "plus" }, requiresOpenaiAuth: true });
        break;
      case "config/read":
        respond(this.config);
        break;
      case "configRequirements/read":
        respond(this.requirements);
        break;
      case "model/list":
        respond({ data: [{ id: "gpt-5.4", model: "gpt-5.4" }], nextCursor: null });
        break;
      case "permissionProfile/list":
        respond({ data: [{ id: "brai-chat", description: "isolated", allowed: true }], nextCursor: null });
        break;
      case "command/exec":
        respond(this.canary);
        break;
      case "thread/start": {
        const id = `codex_thread_${++this.sequence}`;
        respond({ thread: { id }, activePermissionProfile: { id: "brai-chat", extends: null } });
        break;
      }
      case "thread/resume":
        respond({ thread: { id: request.params.threadId }, activePermissionProfile: { id: "brai-chat", extends: null } });
        break;
      case "thread/read":
        respond({ thread: { id: request.params.threadId, turns: [{ id: TURN, status: this.turnStatus, items: [...this.turnItems] }] } });
        break;
      case "turn/start":
        if (request.params.input?.[0]?.text?.startsWith("Придумай краткий смысловой заголовок")) {
          const titleTurnId = `title_turn_${++this.sequence}`;
          respond({ turn: { id: titleTurnId } });
          queueMicrotask(() => {
            child.stdout.write(`${JSON.stringify({
              method: "item/agentMessage/delta",
              params: {
                threadId: request.params.threadId,
                turnId: titleTurnId,
                itemId: `title_item_${this.sequence}`,
                delta: this.titleResponse,
              },
            })}\n`);
            child.stdout.write(`${JSON.stringify({
              method: "turn/completed",
              params: {
                threadId: request.params.threadId,
                turn: { id: titleTurnId, status: "completed" },
              },
            })}\n`);
          });
          break;
        }
        this.turnItems = [{
          type: "userMessage", id: "upstream-start-user", clientId: request.params.clientUserMessageId,
        }];
        respond({ turn: { id: TURN } });
        if (this.emitTurnStarted) {
          child.stdout.write(`${JSON.stringify({ method: "turn/started", params: { threadId: request.params.threadId, turn: { id: TURN } } })}\n`);
        }
        child.stdout.write(`${JSON.stringify({ method: "item/reasoning/textDelta", params: { threadId: request.params.threadId, turnId: TURN, delta: "raw" } })}\n`);
        break;
      case "turn/steer":
        this.turnItems.push({
          type: "userMessage", id: `upstream-steer-${this.turnItems.length}`,
          clientId: request.params.clientUserMessageId,
        });
        respond({});
        break;
      case "turn/interrupt":
        respond({});
        child.stdout.write(`${JSON.stringify({ method: "turn/completed", params: { threadId: request.params.threadId, turn: { id: request.params.turnId, status: "interrupted" } } })}\n`);
        break;
      default:
        child.stdout.write(`${JSON.stringify({ id: request.id, error: { code: -32601, message: "not found" } })}\n`);
    }
  }
}

test("preflight verifies version, auth and required capabilities before readiness", async () => {
  const fixture = await createFixture();
  const docker = new FakeDocker();
  const manager = fixture.manager(docker);
  await manager.preflight();
  assert.equal(manager.readiness().ready, true);
  assert.deepEqual(manager.readiness().capabilities, [
    "model/list", "thread/start", "thread/resume", "thread/read", "turn/start", "turn/steer", "turn/interrupt",
  ]);
  assert.equal(docker.calls.filter(({ args }) => args[0] === "run").length, 1);
  const initialize = docker.runtimes[0].requests.find(({ method }) => method === "initialize");
  assert.deepEqual(initialize.params.capabilities, { experimentalApi: true, requestAttestation: false });
  assert.ok(docker.runtimes[0].requests.some(({ method }) => method === "config/read"));
  assert.ok(docker.runtimes[0].requests.some(({ method }) => method === "configRequirements/read"));
  const accountRequests = docker.runtimes[0].requests.filter(({ method }) => method === "account/read");
  assert.equal(accountRequests.length, 1);
  assert.deepEqual(accountRequests[0].params, { refreshToken: false });
  const startRequest = docker.runtimes[0].requests.find(({ method }) => method === "thread/start");
  assert.equal(Object.hasOwn(startRequest.params, "sandbox"), false);
  assert.equal(startRequest.params.permissions, "brai-chat");
  const canary = docker.runtimes[0].requests.find(({ method }) => method === "command/exec");
  assert.equal(canary.params.permissionProfile, "brai-chat");
  assert.equal(canary.params.command.join(" ").includes("cat /codex-home/auth.json"), true);
  assert.equal(canary.params.command.join(" ").includes("/proc/1/root/codex-home/auth.json"), true);
  assert.equal(canary.params.command.join(" ").includes("/proc/1/environ"), false);
  assert.equal(canary.params.command.join(" ").includes("createSocket('udp4')"), true);
  assert.equal(canary.params.command.join(" ").includes("d.bind(0,'127.0.0.1'"), true);
});

test("preflight fails closed when managed Codex requirements are weakened", async () => {
  const fixture = await createFixture();
  const docker = new FakeDocker();
  docker.requirements.requirements.featureRequirements.apps = true;
  const manager = fixture.manager(docker);
  await assert.rejects(
    manager.preflight(),
    (error) => error.code === "BRAI_RUNTIME_CONFIGURATION_INVALID",
  );
  assert.equal(manager.readiness().ready, false);
});

test("production and Dev fixed environment names pass configuration validation", async () => {
  const fixture = await createFixture();
  const docker = new FakeDocker();
  const prod = fixture.manager(docker, { environment: "prod" });
  const dev = fixture.manager(docker, { environment: "dev" });
  await prod.ensureRuntime(USER_A);
  await dev.ensureRuntime(USER_B);
  assert.equal(prod.runtimes.has(USER_A), true);
  assert.equal(dev.runtimes.has(USER_B), true);
  await prod.close();
  await dev.close();
});

test("concurrent first runtime requests for one user share a single container start", async () => {
  const fixture = await createFixture();
  const docker = new FakeDocker();
  const manager = fixture.manager(docker);
  const [first, second] = await Promise.all([
    manager.ensureRuntime(USER_A),
    manager.ensureRuntime(USER_A),
  ]);
  assert.equal(first, second);
  assert.equal(docker.calls.filter(({ args }) => args[0] === "run").length, 1);
  await manager.close();
});

test("each user gets isolated persistent state and hardened Docker argv", async () => {
  const fixture = await createFixture();
  const docker = new FakeDocker();
  const manager = fixture.manager(docker);
  await manager.ensureRuntime(USER_A);
  await manager.ensureRuntime(USER_B);
  const runs = docker.calls.filter(({ args }) => args[0] === "run");
  assert.equal(runs.length, 2);
  const first = runs[0].args;
  const second = runs[1].args;
  assert.ok(first.includes("--read-only"));
  assert.ok(first.includes("--cap-drop=ALL"));
  assert.ok(first.includes("--security-opt=no-new-privileges:true"));
  assert.ok(first.includes("systempaths=unconfined"));
  assert.ok(first.includes(`seccomp=${fixture.seccomp}`));
  assert.ok(first.includes("apparmor=brai-codex-app-server"));
  assert.ok(!first.includes("--publish") && !first.includes("-p"));
  assert.ok(!first.join(" ").includes("docker.sock"));
  assert.ok(!first.join(" ").includes("/srv/projects/brai/.codex-worktrees"));
  const firstHome = first.find((value) => value.includes("dst=/codex-home") && !value.includes("auth.json") && !value.includes("config.toml"));
  const secondHome = second.find((value) => value.includes("dst=/codex-home") && !value.includes("auth.json") && !value.includes("config.toml"));
  assert.notEqual(firstHome, secondHome);
  assert.match(first.find((value) => value.includes("dst=/workspace")), /readonly$/);
  assert.match(first.find((value) => value.includes("dst=\/codex-home\/auth\.json")), /readonly$/);
  assert.match(first.find((value) => value.includes("dst=\/etc\/codex\/requirements\.toml")), /readonly$/);
  await manager.close();
});

test("selected images are signature-checked and reject final or parent symlinks", async () => {
  const fixture = await createFixture();
  const docker = new FakeDocker();
  const source = path.join(fixture.attachments, USER_A, "Brai", "Chat", THREAD, ATTACHMENT);
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.writeFile(source, Buffer.from([0xff, 0xd8, 0xff, 0x00]));
  const manager = fixture.manager(docker);
  await manager.ensureRuntime(USER_A, [{ id: ATTACHMENT, threadId: THREAD }]);
  const args = docker.calls.find(({ args: values }) => values[0] === "run").args;
  const mount = args.find((value) => value.includes(`src=${source}`));
  assert.equal(mount, undefined);
  const selectedMount = args.find((value) => value.includes(`dst=/attachments/${ATTACHMENT}`));
  assert.match(selectedMount, new RegExp(`^type=bind,src=.*\/staging\/.*\/${ATTACHMENT},dst=\/attachments\/${ATTACHMENT},readonly$`));
  assert.ok(!args.includes(`type=bind,src=${fixture.attachments},dst=/attachments,readonly`));
  await manager.close();

  const outside = path.join(fixture.root, "outside.png");
  await fs.writeFile(outside, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  await fs.rm(source);
  await fs.symlink(outside, source);
  const symlinkManager = fixture.manager(new FakeDocker());
  await assert.rejects(
    symlinkManager.ensureRuntime(USER_A, [{ id: ATTACHMENT, threadId: THREAD }]),
    (error) => error.code === "BRAI_ATTACHMENT_INVALID",
  );
  await symlinkManager.close();

  await fs.rm(path.join(fixture.attachments, USER_A), { recursive: true, force: true });
  const outsideRoot = path.join(fixture.root, "outside-vault");
  const outsideAttachment = path.join(outsideRoot, "Brai", "Chat", THREAD, ATTACHMENT);
  await fs.mkdir(path.dirname(outsideAttachment), { recursive: true });
  await fs.writeFile(outsideAttachment, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  await fs.symlink(outsideRoot, path.join(fixture.attachments, USER_A));
  const parentSymlinkManager = fixture.manager(new FakeDocker());
  await assert.rejects(
    parentSymlinkManager.ensureRuntime(USER_A, [{ id: ATTACHMENT, threadId: THREAD }]),
    (error) => error.code === "BRAI_ATTACHMENT_INVALID",
  );
  await parentSymlinkManager.close();
});

test("large image completion stays within the app-server limit and is sanitized before broker output", async () => {
  const fixture = await createFixture();
  const docker = new FakeDocker();
  const manager = fixture.manager(docker);
  const runtime = await manager.ensureRuntime(USER_A);
  const notification = once(manager, "notification");
  runtime.child.stdout.write(`${JSON.stringify({
    method: "item/completed",
    params: {
      threadId: THREAD,
      turnId: TURN,
      item: {
        id: IMAGE_ITEM,
        type: "imageGeneration",
        status: "completed",
        result: LARGE_IMAGE_RESULT,
        savedPath: generatedPath("spring.png"),
      },
    },
  })}\n`);

  const [{ message }] = await notification;
  assert.equal(runtime.child.signalCode, null);
  assert.deepEqual(message.params.item, {
    id: IMAGE_ITEM,
    type: "imageGeneration",
    status: "completed",
    path: generatedPath("spring.png"),
  });
  assert.equal(JSON.stringify(message).includes(LARGE_IMAGE_RESULT.slice(0, 1_000)), false);
  assert.equal(runtime.generatedArtifacts.size, 1);
  await manager.close();
});

test("app-server output above its dedicated limit still fails closed", async () => {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.signalCode = null;
  child.kill = (signal) => {
    child.signalCode = signal;
    child.emit("exit", null, signal);
  };
  const appServer = new AppServerProcess(child, { maxLineBytes: 128 });
  const closed = once(appServer, "closed");
  child.stdout.write(`${JSON.stringify({
    method: "item/completed",
    params: { padding: "A".repeat(256) },
  })}\n`);

  const [error] = await closed;
  assert.match(error.message, /oversized message/);
  assert.equal(child.signalCode, "SIGKILL");
});

test("thread/read removes oversized image result and restores the generated artifact path", async () => {
  const fixture = await createFixture();
  const docker = new FakeDocker();
  docker.turnStatus = "interrupted";
  docker.turnItems = [{
    id: IMAGE_ITEM,
    type: "imageGeneration",
    status: "completed",
    result: LARGE_IMAGE_RESULT,
    savedPath: generatedPath("spring.png"),
  }];
  const manager = fixture.manager(docker);
  const runtime = await manager.ensureRuntime(USER_A);

  const snapshot = await manager.request(USER_A, "thread/read", {
    threadId: THREAD,
    includeTurns: true,
  });

  assert.equal(runtime.child.signalCode, null);
  assert.deepEqual(snapshot.thread.turns[0], {
    id: TURN,
    status: "interrupted",
    items: [{
      id: IMAGE_ITEM,
      type: "imageGeneration",
      status: "completed",
      path: generatedPath("spring.png"),
    }],
  });
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) < 1024 * 1024);
  assert.equal(runtime.generatedArtifacts.size, 1);
  await manager.close();
});

test("generated images export from an allowlisted container item into the owner Vault", async () => {
  const fixture = await createFixture();
  const docker = new FakeDocker();
  const copied = [];
  const manager = fixture.manager(docker, {
    generatedPathAccess: async ({ operation, sourcePath, destinationPath }) => {
      assert.equal(operation, "read");
      copied.push(sourcePath);
      await fs.writeFile(destinationPath, PNG_BYTES);
    },
  });
  const runtime = await manager.ensureRuntime(USER_A);
  const notification = once(manager, "notification");
  runtime.child.stdout.write(`${JSON.stringify({
    method: "item/completed",
    params: {
      threadId: THREAD,
      turnId: TURN,
      item: {
        id: IMAGE_ITEM,
        type: "imageGeneration",
        status: "completed",
        savedPath: generatedPath("spring.png"),
      },
    },
  })}\n`);
  await notification;

  await manager.ensureRuntime(USER_B);
  await assert.rejects(
    manager.exportGeneratedArtifact(USER_B, {
      threadId: THREAD,
      turnId: TURN,
      itemId: IMAGE_ITEM,
      publicThreadId: THREAD,
      attachmentId: GENERATED_ATTACHMENT,
    }),
    (error) => error.code === "BRAI_GENERATED_ARTIFACT_UNAVAILABLE",
  );

  const metadata = await manager.exportGeneratedArtifact(USER_A, {
    threadId: THREAD,
    turnId: TURN,
    itemId: IMAGE_ITEM,
    publicThreadId: THREAD,
    attachmentId: GENERATED_ATTACHMENT,
  });
  assert.deepEqual(copied, [generatedPath("spring.png")]);
  assert.equal(metadata.id, GENERATED_ATTACHMENT);
  assert.equal(metadata.original_name, "spring.png");
  assert.equal(metadata.media_type, "image/png");
  assert.equal(metadata.byte_size, PNG_BYTES.length);
  assert.equal(
    await fs.readFile(path.join(fixture.attachments, USER_A, "Brai", "Chat", THREAD, GENERATED_ATTACHMENT), "hex"),
    PNG_BYTES.toString("hex"),
  );

  assert.deepEqual(await manager.exportGeneratedArtifact(USER_A, {
    threadId: THREAD,
    turnId: TURN,
    itemId: IMAGE_ITEM,
    publicThreadId: THREAD,
    attachmentId: GENERATED_ATTACHMENT,
  }), metadata);
  assert.equal(copied.length, 1);
  assert.equal(await manager.removeExportedArtifact(USER_B, {
    threadId: THREAD,
    turnId: TURN,
    itemId: IMAGE_ITEM,
    publicThreadId: THREAD,
    attachmentId: GENERATED_ATTACHMENT,
  }), false);
  assert.equal(
    await fs.readFile(path.join(
      fixture.attachments, USER_A, "Brai", "Chat", THREAD, GENERATED_ATTACHMENT
    ), "hex"),
    PNG_BYTES.toString("hex"),
  );
  assert.equal(await manager.removeExportedArtifact(USER_A, {
    threadId: THREAD,
    turnId: TURN,
    itemId: IMAGE_ITEM,
    publicThreadId: THREAD,
    attachmentId: GENERATED_ATTACHMENT,
  }), true);
  await assert.rejects(
    fs.stat(path.join(fixture.attachments, USER_A, "Brai", "Chat", THREAD, GENERATED_ATTACHMENT)),
    (error) => error.code === "ENOENT",
  );
  await manager.exportGeneratedArtifact(USER_A, {
    threadId: THREAD,
    turnId: TURN,
    itemId: IMAGE_ITEM,
    publicThreadId: THREAD,
    attachmentId: GENERATED_ATTACHMENT,
  });
  assert.equal(copied.length, 2);
  await fs.unlink(path.join(
    fixture.attachments, USER_A, "Brai", "Chat", THREAD, GENERATED_ATTACHMENT
  ));
  assert.equal(await manager.removeExportedArtifact(USER_A, {
    threadId: THREAD,
    turnId: TURN,
    itemId: IMAGE_ITEM,
    publicThreadId: THREAD,
    attachmentId: GENERATED_ATTACHMENT,
  }), false);
  await manager.exportGeneratedArtifact(USER_A, {
    threadId: THREAD,
    turnId: TURN,
    itemId: IMAGE_ITEM,
    publicThreadId: THREAD,
    attachmentId: GENERATED_ATTACHMENT,
  });
  assert.equal(copied.length, 3);
  await manager.close();
});

test("generated image export remains idempotent after a broker restart", async () => {
  const fixture = await createFixture();
  const exportOnce = async (docker) => {
    const manager = fixture.manager(docker, {
      generatedPathAccess: async ({ operation, destinationPath }) => {
        assert.equal(operation, "read");
        await fs.writeFile(destinationPath, PNG_BYTES);
      },
    });
    const runtime = await manager.ensureRuntime(USER_A);
    const notification = once(manager, "notification");
    runtime.child.stdout.write(`${JSON.stringify({
      method: "item/completed",
      params: {
        threadId: THREAD,
        turnId: TURN,
        item: {
          id: IMAGE_ITEM,
          type: "imageGeneration",
          status: "completed",
          path: generatedPath("spring.png"),
        },
      },
    })}\n`);
    await notification;
    const metadata = await manager.exportGeneratedArtifact(USER_A, {
      threadId: THREAD,
      turnId: TURN,
      itemId: IMAGE_ITEM,
      publicThreadId: THREAD,
      attachmentId: GENERATED_ATTACHMENT,
    });
    return { manager, metadata };
  };

  const first = await exportOnce(new FakeDocker());
  await first.manager.close();
  const second = await exportOnce(new FakeDocker());
  assert.deepEqual(second.metadata, first.metadata);
  assert.equal(
    await fs.readFile(path.join(
      fixture.attachments, USER_A, "Brai", "Chat", THREAD, GENERATED_ATTACHMENT
    ), "hex"),
    PNG_BYTES.toString("hex"),
  );
  await second.manager.close();
});

test("generated image export rejects parent and final symlinks in the container source chain", async (t) => {
  for (const kind of ["parent", "final"]) {
    await t.test(kind, async () => {
      const fixture = await createFixture();
      const docker = new FakeDocker();
      docker.execLocally = true;
      docker.generatedHostRoot = path.join(fixture.root, "container-generated");
      const manager = fixture.manager(docker);
      const runtime = await manager.ensureRuntime(USER_A);
      const base = path.join(docker.generatedHostRoot, THREAD);
      const targetDirectory = path.join(fixture.root, `export-${kind}-target`);
      await fs.mkdir(base, { recursive: true });
      await fs.mkdir(targetDirectory);
      const target = path.join(targetDirectory, "image.png");
      await fs.writeFile(target, PNG_BYTES);
      let sourcePath;
      if (kind === "parent") {
        const linkedParent = path.join(base, "generated");
        await fs.symlink(targetDirectory, linkedParent);
        sourcePath = generatedPath("generated/image.png");
      } else {
        await fs.symlink(target, path.join(base, "image.png"));
        sourcePath = generatedPath("image.png");
      }

      const notification = once(manager, "notification");
      runtime.child.stdout.write(`${JSON.stringify({
        method: "item/completed",
        params: {
          threadId: THREAD,
          turnId: TURN,
          item: {
            id: IMAGE_ITEM,
            type: "imageGeneration",
            status: "completed",
            savedPath: sourcePath,
          },
        },
      })}\n`);
      await notification;
      await assert.rejects(
        manager.exportGeneratedArtifact(USER_A, {
          threadId: THREAD,
          turnId: TURN,
          itemId: IMAGE_ITEM,
          publicThreadId: THREAD,
          attachmentId: GENERATED_ATTACHMENT,
        }),
        (error) => error.code === "BRAI_GENERATED_ARTIFACT_UNAVAILABLE",
      );
      assert.equal((await fs.readFile(target)).equals(PNG_BYTES), true);
      const exec = docker.calls.find(({ args }) => args[0] === "exec");
      assert.equal(exec.args[2], "/usr/local/bin/node");
      assert.equal(exec.args.at(-2), "read");
      assert.equal(exec.args.at(-1), sourcePath);
      assert.ok(!exec.args.includes("/bin/sh"));
      assert.ok(!docker.calls.some(({ args }) => args[0] === "cp"));
      await manager.close();
    });
  }
});

test("generated source cleanup keeps parent and final symlink substitutions pending", async (t) => {
  for (const kind of ["parent", "final"]) {
    await t.test(kind, async () => {
      const fixture = await createFixture();
      const docker = new FakeDocker();
      docker.execLocally = true;
      docker.generatedHostRoot = path.join(fixture.root, "container-generated");
      const manager = fixture.manager(docker);
      const runtime = await manager.ensureRuntime(USER_A);
      const base = path.join(docker.generatedHostRoot, THREAD);
      const generated = path.join(base, "generated");
      const sourcePath = generatedPath("generated/image.png");
      await fs.mkdir(generated, { recursive: true });
      await fs.writeFile(path.join(generated, "image.png"), PNG_BYTES);

      const notification = once(manager, "notification");
      runtime.child.stdout.write(`${JSON.stringify({
        method: "item/completed",
        params: {
          threadId: THREAD,
          turnId: TURN,
          item: {
            id: IMAGE_ITEM,
            type: "imageGeneration",
            status: "completed",
            savedPath: sourcePath,
          },
        },
      })}\n`);
      await notification;
      await manager.exportGeneratedArtifact(USER_A, {
        threadId: THREAD,
        turnId: TURN,
        itemId: IMAGE_ITEM,
        publicThreadId: THREAD,
        attachmentId: GENERATED_ATTACHMENT,
      });

      let protectedTarget;
      if (kind === "parent") {
        const original = path.join(base, "original");
        await fs.rename(generated, original);
        await fs.symlink(original, generated);
        protectedTarget = path.join(original, "image.png");
      } else {
        protectedTarget = path.join(base, "protected.png");
        await fs.writeFile(protectedTarget, PNG_BYTES);
        await fs.unlink(path.join(generated, "image.png"));
        await fs.symlink(protectedTarget, path.join(generated, "image.png"));
      }

      assert.deepEqual(await manager.cleanupGeneratedArtifacts(USER_A, {
        publicThreadId: THREAD,
        attachmentIds: [GENERATED_ATTACHMENT],
      }), { cleaned: 0, pending: 1 });
      assert.equal((await fs.readFile(protectedTarget)).equals(PNG_BYTES), true);
      assert.equal(runtime.generatedArtifacts.size, 1);
      assert.equal(runtime.exportedArtifacts.size, 1);
      const cleanupExec = docker.calls.filter(({ args }) =>
        args[0] === "exec" && args.at(-2) === "remove").at(-1);
      assert.equal(cleanupExec.args.at(-1), sourcePath);
      assert.ok(!cleanupExec.args.includes("/bin/sh"));
      await manager.close();
    });
  }
});

test("generated source cleanup is bounded, retryable and idempotent across a long batch", async () => {
  const fixture = await createFixture();
  const docker = new FakeDocker();
  const removals = [];
  let failOnce = true;
  const manager = fixture.manager(docker, {
    generatedPathAccess: async ({ operation, sourcePath, destinationPath }) => {
      if (operation === "read") {
        await fs.writeFile(destinationPath, PNG_BYTES);
        return;
      }
      removals.push(sourcePath);
      if (sourcePath.endsWith("/source_13.png") && failOnce) {
        failOnce = false;
        throw new Error("temporary cleanup failure");
      }
    },
  });
  const runtime = await manager.ensureRuntime(USER_A);
  const attachmentIds = [];
  for (let index = 0; index < 32; index += 1) {
    const suffix = String(index).padStart(2, "0");
    const itemId = `image_item_${suffix}_0001`;
    const attachmentId = `generated_attach_${suffix}_0001`;
    const notification = once(manager, "notification");
    runtime.child.stdout.write(`${JSON.stringify({
      method: "item/completed",
      params: {
        threadId: THREAD,
        turnId: TURN,
        item: {
          id: itemId,
          type: "imageGeneration",
          status: "completed",
          savedPath: generatedPath(`source_${suffix}.png`),
        },
      },
    })}\n`);
    await notification;
    await manager.exportGeneratedArtifact(USER_A, {
      threadId: THREAD,
      turnId: TURN,
      itemId,
      publicThreadId: THREAD,
      attachmentId,
    });
    attachmentIds.push(attachmentId);
  }
  assert.equal(runtime.generatedArtifacts.size, 32);
  assert.equal(runtime.exportedArtifacts.size, 32);

  assert.deepEqual(await manager.cleanupGeneratedArtifacts(USER_A, {
    publicThreadId: THREAD,
    attachmentIds,
  }), { cleaned: 31, pending: 1 });
  assert.equal(runtime.generatedArtifacts.size, 1);
  assert.equal(runtime.exportedArtifacts.size, 1);
  assert.equal(removals.length, 32);

  assert.deepEqual(await manager.cleanupGeneratedArtifacts(USER_A, {
    publicThreadId: THREAD,
    attachmentIds,
  }), { cleaned: 1, pending: 0 });
  assert.equal(runtime.generatedArtifacts.size, 0);
  assert.equal(runtime.exportedArtifacts.size, 0);
  assert.equal(removals.length, 33);

  assert.deepEqual(await manager.cleanupGeneratedArtifacts(USER_A, {
    publicThreadId: THREAD,
    attachmentIds,
  }), { cleaned: 0, pending: 0 });
  assert.equal(removals.length, 33);
  await manager.close();
});

test("semantic title generation uses a private ephemeral thread without leaking its events", async () => {
  const fixture = await createFixture();
  const docker = new FakeDocker();
  const manager = fixture.manager(docker);
  const publicNotifications = [];
  manager.on("notification", (event) => publicNotifications.push(event));
  const userRuntime = await manager.ensureRuntime(USER_A);

  const result = await manager.generateTitle(USER_A, {
    userMessage: "Напиши хайку про весну",
    assistantText: "Тает последний снег",
    model: "gpt-5.4",
    reasoningEffort: "medium",
  });
  assert.deepEqual(result, { title: "Хайку о весне" });
  assert.equal(publicNotifications.length, 0);
  assert.equal(manager.notificationWatermark(USER_A).sequence, 0);
  assert.equal(docker.runtimes.length, 2);
  assert.equal(manager.runtimes.get(USER_A), userRuntime);
  const titleTurn = docker.runtimes[1].requests.find(({ method, params }) =>
    method === "turn/start"
      && params.input?.[0]?.text?.startsWith("Придумай краткий смысловой заголовок"));
  assert.equal(titleTurn.params.approvalPolicy, "never");
  assert.equal(titleTurn.params.permissions, "brai-chat");
  assert.equal(titleTurn.params.model, "gpt-5.4");
  assert.equal(titleTurn.params.effort, "medium");
  assert.match(titleTurn.params.input[0].text, /основном языке диалога пользователя/);
  await manager.close();
});

test("generated image export rejects unrecorded items and paths outside the generated thread root", async () => {
  const fixture = await createFixture();
  const docker = new FakeDocker();
  let accesses = 0;
  const manager = fixture.manager(docker, {
    generatedPathAccess: async ({ operation, destinationPath }) => {
      accesses += 1;
      assert.equal(operation, "read");
      await fs.writeFile(destinationPath, PNG_BYTES);
    },
  });
  const runtime = await manager.ensureRuntime(USER_A);
  const notification = once(manager, "notification");
  runtime.child.stdout.write(`${JSON.stringify({
    method: "item/completed",
    params: {
      threadId: THREAD,
      turnId: TURN,
      item: {
        id: IMAGE_ITEM,
        type: "imageGeneration",
        status: "completed",
        path: "/workspace/private.png",
      },
    },
  })}\n`);
  await notification;
  await assert.rejects(
    manager.exportGeneratedArtifact(USER_A, {
      threadId: THREAD,
      turnId: TURN,
      itemId: IMAGE_ITEM,
      publicThreadId: THREAD,
      attachmentId: GENERATED_ATTACHMENT,
    }),
    (error) => error.code === "BRAI_GENERATED_ARTIFACT_UNAVAILABLE",
  );

  const crossThreadItem = "cross_thread_image_item";
  const crossThreadNotification = once(manager, "notification");
  runtime.child.stdout.write(`${JSON.stringify({
    method: "item/completed",
    params: {
      threadId: THREAD,
      turnId: TURN,
      item: {
        id: crossThreadItem,
        type: "imageGeneration",
        status: "completed",
        result: LARGE_IMAGE_RESULT,
        savedPath: generatedPath("cross-thread.png", "thread_00000002"),
      },
    },
  })}\n`);
  const [{ message: crossThreadMessage }] = await crossThreadNotification;
  assert.equal(Object.hasOwn(crossThreadMessage.params.item, "result"), false);
  assert.equal(Object.hasOwn(crossThreadMessage.params.item, "path"), false);
  await assert.rejects(
    manager.exportGeneratedArtifact(USER_A, {
      threadId: THREAD,
      turnId: TURN,
      itemId: crossThreadItem,
      publicThreadId: THREAD,
      attachmentId: "cross_thread_attachment",
    }),
    (error) => error.code === "BRAI_GENERATED_ARTIFACT_UNAVAILABLE",
  );

  const failedItem = "failed_image_item";
  const failedNotification = once(manager, "notification");
  runtime.child.stdout.write(`${JSON.stringify({
    method: "item/completed",
    params: {
      threadId: THREAD,
      turnId: TURN,
      item: {
        id: failedItem,
        type: "imageGeneration",
        status: "failed",
        savedPath: generatedPath("failed.png"),
      },
    },
  })}\n`);
  await failedNotification;
  await assert.rejects(
    manager.exportGeneratedArtifact(USER_A, {
      threadId: THREAD,
      turnId: TURN,
      itemId: failedItem,
      publicThreadId: THREAD,
      attachmentId: "failed_attachment",
    }),
    (error) => error.code === "BRAI_GENERATED_ARTIFACT_UNAVAILABLE",
  );
  assert.equal(accesses, 0);
  assert.equal(runtime.generatedArtifacts.size, 0);
  await manager.close();
});

test("mounted image runtime remains usable for model, read and interrupt requests", async () => {
  const fixture = await createFixture();
  const docker = new FakeDocker();
  const source = path.join(fixture.attachments, USER_A, "Brai", "Chat", THREAD, ATTACHMENT);
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.writeFile(source, Buffer.from([0xff, 0xd8, 0xff, 0x00]));
  const manager = fixture.manager(docker);
  const runtime = await manager.ensureRuntime(USER_A, [{ id: ATTACHMENT, threadId: THREAD }]);
  runtime.activeTurns.add(TURN);

  await manager.request(USER_A, "model/list", { limit: 1 });
  await manager.request(USER_A, "thread/read", { threadId: THREAD, includeTurns: true });
  await manager.request(USER_A, "turn/interrupt", { threadId: THREAD, turnId: TURN });

  assert.equal(docker.runtimes.length, 1);
  assert.deepEqual(docker.runtimes[0].requests.slice(-3).map(({ method }) => method), [
    "model/list", "thread/read", "turn/interrupt",
  ]);
  runtime.activeTurns.clear();
  await manager.close();
});

test("attachment-driven runtime restart resumes the thread before starting its turn", async () => {
  const fixture = await createFixture();
  const docker = new FakeDocker();
  const source = path.join(fixture.attachments, USER_A, "Brai", "Chat", THREAD, ATTACHMENT);
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.writeFile(source, Buffer.from([0xff, 0xd8, 0xff, 0x00]));
  const manager = fixture.manager(docker);
  manager.ready = true;
  const socketPath = path.join(fixture.root, "resume-before-turn.sock");
  const server = new BrokerServer(manager, { socketPath });
  await server.listen();
  const client = new BraiCodexBrokerClient(socketPath);
  const { threadId } = await client.call("startThread", { userId: USER_A });
  await client.call("startTurn", {
    userId: USER_A,
    threadId,
    text: "Посмотри изображение",
    attachments: [{ id: ATTACHMENT, threadId: THREAD }],
  });
  assert.equal(docker.runtimes.length, 2);
  const methods = docker.runtimes[1].requests.map(({ method }) => method);
  assert.ok(methods.indexOf("thread/resume") < methods.indexOf("turn/start"));
  client.close();
  await server.close();
});

test("starting a thread with attachments keeps its first turn in the same runtime", async () => {
  const fixture = await createFixture();
  const docker = new FakeDocker();
  const source = path.join(fixture.attachments, USER_A, "Brai", "Chat", THREAD, ATTACHMENT);
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.writeFile(source, Buffer.from([0xff, 0xd8, 0xff, 0x00]));
  const manager = fixture.manager(docker);
  manager.ready = true;
  const socketPath = path.join(fixture.root, "attachment-first-thread.sock");
  const server = new BrokerServer(manager, { socketPath });
  await server.listen();
  const client = new BraiCodexBrokerClient(socketPath);
  const attachments = [{ id: ATTACHMENT, threadId: THREAD }];
  const { threadId } = await client.call("startThread", { userId: USER_A, attachments });
  await client.call("startTurn", {
    userId: USER_A, threadId, text: "Посмотри изображение", attachments,
  });
  assert.equal(docker.runtimes.length, 1);
  const methods = docker.runtimes[0].requests.map(({ method }) => method);
  assert.equal(methods.filter((method) => method === "thread/resume").length, 0);
  assert.ok(methods.indexOf("thread/start") < methods.indexOf("turn/start"));
  client.close();
  await server.close();
});

test("a thread already loaded in the current runtime starts without an empty-history resume", async () => {
  const fixture = await createFixture();
  const docker = new FakeDocker();
  const manager = fixture.manager(docker);
  manager.ready = true;
  const socketPath = path.join(fixture.root, "loaded-thread.sock");
  const server = new BrokerServer(manager, { socketPath });
  await server.listen();
  const client = new BraiCodexBrokerClient(socketPath);
  const { threadId } = await client.call("startThread", { userId: USER_A });
  await client.call("startTurn", { userId: USER_A, threadId, text: "Привет" });
  const methods = docker.runtimes[0].requests.map(({ method }) => method);
  assert.equal(methods.filter((method) => method === "thread/resume").length, 0);
  assert.ok(methods.indexOf("thread/start") < methods.indexOf("turn/start"));
  client.close();
  await server.close();
});

test("idle sweep preserves active turns and stops only inactive runtimes", async () => {
  const fixture = await createFixture();
  const docker = new FakeDocker();
  let now = 1_000;
  const manager = fixture.manager(docker, { now: () => now, idleMs: 100 });
  const runtime = await manager.ensureRuntime(USER_A);
  runtime.activeTurns.add(TURN);
  now = 2_000;
  assert.equal(await manager.sweepIdle(), 0);
  assert.equal(manager.runtimes.has(USER_A), true);
  runtime.activeTurns.delete(TURN);
  assert.equal(await manager.sweepIdle(), 1);
  assert.equal(manager.runtimes.has(USER_A), false);
});

test("Unix JSONL RPC rejects arbitrary input and forwards correlated safe notifications", async () => {
  const fixture = await createFixture();
  const docker = new FakeDocker();
  const manager = fixture.manager(docker);
  manager.ready = true;
  const socketPath = path.join(fixture.root, "broker.sock");
  const server = new BrokerServer(manager, { socketPath });
  await server.listen();
  const client = new BraiCodexBrokerClient(socketPath);
  await assert.rejects(
    client.call("ensureRuntime", { userId: USER_A, command: "sh" }),
    (error) => error.code === "BRAI_INVALID_REQUEST",
  );
  await assert.rejects(
    client.call("startTurn", { userId: USER_A, threadId: THREAD, text: "hi", attachments: [{ id: "../../etc", threadId: THREAD }] }),
    (error) => error.code === "BRAI_INVALID_REQUEST",
  );
  await assert.rejects(
    client.call("exportGeneratedArtifact", {
      userId: USER_A,
      threadId: THREAD,
      turnId: TURN,
      itemId: IMAGE_ITEM,
      publicThreadId: THREAD,
      attachmentId: GENERATED_ATTACHMENT,
      path: "/tmp/generated.png",
    }),
    (error) => error.code === "BRAI_INVALID_REQUEST",
  );
  await assert.rejects(
    client.call("removeExportedArtifact", {
      userId: USER_A,
      publicThreadId: THREAD,
      attachmentId: GENERATED_ATTACHMENT,
    }),
    (error) => error.code === "BRAI_INVALID_REQUEST",
  );
  await assert.rejects(
    client.call("cleanupGeneratedArtifacts", {
      userId: USER_A,
      publicThreadId: THREAD,
      attachmentIds: [GENERATED_ATTACHMENT],
      path: "/tmp/generated.png",
    }),
    (error) => error.code === "BRAI_INVALID_REQUEST",
  );
  await assert.rejects(
    client.call("cleanupGeneratedArtifacts", {
      userId: USER_A,
      publicThreadId: THREAD,
      attachmentIds: [GENERATED_ATTACHMENT, GENERATED_ATTACHMENT],
    }),
    (error) => error.code === "BRAI_INVALID_REQUEST",
  );
  await assert.rejects(
    client.call("cleanupGeneratedArtifacts", {
      userId: USER_A,
      publicThreadId: THREAD,
      attachmentIds: Array.from(
        { length: 1_001 },
        (_, index) => `generated_attach_${String(index).padStart(4, "0")}`
      ),
    }),
    (error) => error.code === "BRAI_INVALID_REQUEST",
  );
  const notification = once(client, "notification");
  const result = await client.call("startTurn", { userId: USER_A, threadId: THREAD, text: "Привет" });
  assert.deepEqual(result, { turnId: TURN });
  const [event] = await notification;
  assert.match(event.notificationEpoch, /^[0-9a-f-]{36}$/);
  assert.deepEqual({ ...event, notificationEpoch: undefined }, {
    userId: USER_A,
    threadId: THREAD,
    turnId: TURN,
    notificationSequence: 1,
    notificationEpoch: undefined,
    method: "turn/started",
    params: { threadId: THREAD, turn: { id: TURN } },
  });
  const seen = [];
  client.on("notification", (value) => seen.push(value.method));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(!seen.includes("item/reasoning/textDelta"));
  client.close();
  await server.close();
});

test("subscribe/read watermarks and steer client ids make retry idempotent", async () => {
  const fixture = await createFixture();
  const docker = new FakeDocker();
  const manager = fixture.manager(docker);
  manager.ready = true;
  const socketPath = path.join(fixture.root, "watermark.sock");
  const server = new BrokerServer(manager, { socketPath });
  await server.listen();
  const client = new BraiCodexBrokerClient(socketPath);

  const subscribed = await client.call("subscribe", { userId: USER_A, threadId: THREAD });
  assert.equal(subscribed.notificationWatermark, 0);
  await client.call("startTurn", {
    userId: USER_A, threadId: THREAD, text: "Привет", clientUserMessageId: "message_00000001",
  });
  const snapshot = await client.call("readThread", {
    userId: USER_A, threadId: THREAD, includeTurns: true,
  });
  assert.equal(snapshot.notificationWatermark, 1);

  const steer = {
    userId: USER_A, threadId: THREAD, turnId: TURN, text: "Ещё",
    clientUserMessageId: "message_00000002",
  };
  await client.call("steerTurn", steer);
  await client.call("steerTurn", steer);
  assert.equal(docker.runtimes[0].requests.filter(({ method }) => method === "turn/steer").length, 1);

  client.close();
  await server.close();
});

test("attachment selection changes fail closed during an active turn", async () => {
  const fixture = await createFixture();
  const docker = new FakeDocker();
  docker.emitTurnStarted = false;
  const manager = fixture.manager(docker);
  const result = await manager.request(USER_A, "turn/start", { threadId: THREAD, input: [] });
  const runtime = manager.runtimes.get(USER_A);
  assert.equal(result.turn.id, TURN);
  assert.equal(runtime.activeTurns.has(TURN), true);
  const source = path.join(fixture.attachments, USER_A, "Brai", "Chat", THREAD, ATTACHMENT);
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.writeFile(source, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  await assert.rejects(
    manager.ensureRuntime(USER_A, [{ id: ATTACHMENT, threadId: THREAD }]),
    (error) => error.code === "BRAI_RUNTIME_BUSY",
  );
  runtime.activeTurns.clear();
  await manager.close();
});

test("thread/read restores nonterminal turns and removes terminal turns", async () => {
  const fixture = await createFixture();
  const docker = new FakeDocker();
  const manager = fixture.manager(docker);
  const runtime = await manager.ensureRuntime(USER_A);

  await manager.request(USER_A, "thread/read", { threadId: THREAD, includeTurns: true });
  assert.equal(runtime.activeTurns.has(TURN), true);

  docker.turnStatus = "completed";
  await manager.request(USER_A, "thread/read", { threadId: THREAD, includeTurns: true });
  assert.equal(runtime.activeTurns.has(TURN), false);
  await manager.close();
});

test("docker stop fallback fails closed when docker reports failure", async () => {
  const fixture = await createFixture();
  const docker = new FakeDocker();
  docker.hangOnClose = true;
  docker.stopExitCode = 1;
  const manager = fixture.manager(docker, { stopGraceMs: 1 });
  await manager.ensureRuntime(USER_A);
  const keepAlive = setTimeout(() => {}, 1_000);

  try {
    await assert.rejects(
      manager.stopRuntime(USER_A),
      (error) => error.code === "BRAI_RUNTIME_STOP_FAILED",
    );
    assert.equal(manager.runtimes.has(USER_A), true);

    docker.stopExitCode = 0;
    assert.equal(await manager.stopRuntime(USER_A), true);
    assert.equal(manager.runtimes.has(USER_A), false);
  } finally {
    clearTimeout(keepAlive);
  }
});

test("steer reuses an active attachment-mounted runtime", async () => {
  const fixture = await createFixture();
  const docker = new FakeDocker();
  const manager = fixture.manager(docker);
  const source = path.join(fixture.attachments, USER_A, "Brai", "Chat", THREAD, ATTACHMENT);
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.writeFile(source, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const runtime = await manager.ensureRuntime(USER_A, [{ id: ATTACHMENT, threadId: THREAD }]);
  runtime.activeTurns.add(TURN);

  await manager.steer(USER_A, {
    threadId: THREAD, turnId: TURN, text: "Ещё", clientUserMessageId: "message_00000003",
  });
  assert.equal(docker.runtimes.length, 1);
  assert.equal(docker.runtimes[0].requests.filter(({ method }) => method === "turn/steer").length, 1);

  runtime.activeTurns.clear();
  await manager.close();
});

async function createFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "brai-codex-broker-"));
  const state = path.join(root, "state");
  const attachments = path.join(root, "vault");
  const workspace = path.join(root, "workspace");
  const auth = path.join(root, "auth.json");
  const config = path.join(root, "config.toml");
  const requirements = path.join(root, "requirements.toml");
  const seccomp = path.join(root, "seccomp.json");
  await Promise.all([
    fs.mkdir(state), fs.mkdir(attachments), fs.mkdir(workspace),
    fs.writeFile(auth, "{}"), fs.writeFile(config, "approval_policy = \"never\"\n"), fs.writeFile(requirements, "allowed_approval_policies = [\"never\"]\n"), fs.writeFile(seccomp, "{}"),
  ]);
  return {
    root, attachments, seccomp,
    manager(docker, extra = {}) {
      return new RuntimeManager({
        spawn: docker.spawn,
        environment: "preview-a",
        stateRoot: state,
        attachmentRoot: attachments,
        workspacePath: workspace,
        authPath: auth,
        configPath: config,
        requirementsPath: requirements,
        seccompPath: seccomp,
        apparmorProfile: "brai-codex-app-server",
        network: "brai-codex-egress",
        stopGraceMs: 10,
        ...extra,
      });
    },
  };
}

function exitedChild(code = 0, signal = null) {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  queueMicrotask(() => finish(child, code, signal));
  return child;
}

function finish(child, code, signal) {
  if (child.exitCode != null || child.signalCode != null) return;
  child.exitCode = code;
  child.signalCode = signal;
  queueMicrotask(() => child.emit("exit", code, signal));
}
