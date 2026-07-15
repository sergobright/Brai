import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const helper = path.join(repoRoot, "deploy/ansible/files/brai-auth-runtime.sh");
const compose = path.join(repoRoot, "deploy/ansible/files/brai-auth-compose.yml");
const digest = `ghcr.io/sergobright/brai-auth@sha256:${"a".repeat(64)}`;
const priorDigest = `ghcr.io/sergobright/brai-auth@sha256:${"b".repeat(64)}`;
const branch = "codex/auth-service";
const commit = "c".repeat(40);
const generation = "17";
const skipRuntime = typeof process.getuid === "function" && process.getuid() === 0;
const hasCaddy = spawnSync("caddy", ["version"], { encoding: "utf8" }).status === 0;

test("auth Compose is fixed, secret-free, localhost-only, and uses the external Supabase network", () => {
  const source = fs.readFileSync(compose, "utf8");
  assert.match(source, /^services:\n  auth:/);
  assert.match(source, /image: "\$\{BRAI_AUTH_IMAGE:\?/);
  assert.match(source, /env_file:\n      - "\$\{BRAI_AUTH_ENV_FILE:\?/);
  assert.match(source, /127\.0\.0\.1:\$\{BRAI_AUTH_PORT:\?[^}]+\}:3000/);
  assert.match(source, /networks:\n  brai-supabase:\n    external: true/);
  assert.doesNotMatch(source, /container_name:/);
  assert.doesNotMatch(source, /volumes:/);
  assert.doesNotMatch(source, /(password|secret|token|postgres(?:ql)?:\/\/)/i);
});

test("helper syntax and root/test boundary stay fixed", () => {
  const syntax = spawnSync("bash", ["-n", helper], { encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
  const source = fs.readFileSync(helper, "utf8");
  assert.match(source, /if \(\( EUID == 0 \)\)/);
  assert.match(source, /BRAI_AUTH_TEST_\* overrides are forbidden for root execution/);
  assert.match(source, /Unsupported test override/);
  assert.match(source, /deploy\|route-enable\|route-disable\|rollback\|remove/);
  assert.doesNotMatch(source, /docker\.sock|groupadd|usermod|set -x/);
});

test("unsupported input and mutable images fail before Docker or Caddy", { skip: skipRuntime }, (context) => {
  const fixture = createFixture(context);
  for (const args of [
    ["deploy", "unknown", digest],
    ["start", "prod", digest],
    ["deploy", "prod", "ghcr.io/sergobright/brai-auth:latest"],
    ["deploy", "prod", digest, "/tmp/arbitrary-compose.yml"],
    ["rollback", "prod", digest, "arbitrary-route"],
  ]) {
    const result = fixture.run(...args);
    assert.notEqual(result.status, 0, `${args.join(" ")} unexpectedly succeeded`);
  }
  assert.equal(fixture.readLog(), "");

  const unknownOverride = fixture.runWithEnv(
    { BRAI_AUTH_TEST_COMPOSE: "/tmp/arbitrary-compose.yml" },
    "route-disable", "prod",
  );
  assert.notEqual(unknownOverride.status, 0);
  assert.match(unknownOverride.stderr, /Unsupported test override/);
});

test("Preview branch, commit, generation, and slot are checked before the environment lock", { skip: skipRuntime }, (context) => {
  const fixture = createFixture(context);
  fixture.writeRegistry("A", { branch, commit, lease_generation: Number(generation), status: "deploying" });
  const authLock = fixture.authLock("preview-a");
  fs.rmSync(authLock);

  const stale = fixture.run("deploy", "preview-a", digest, branch, "d".repeat(40), generation);
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /branch, commit, lease, or slot does not match/);
  assert.doesNotMatch(stale.stderr, /auth-operation\.lock/);

  const missingLock = fixture.run("deploy", "preview-a", digest, branch, commit, generation);
  assert.notEqual(missingLock.status, 0);
  assert.match(missingLock.stderr, /auth-operation\.lock/);
  fs.writeFileSync(authLock, "");

  for (const args of [
    ["deploy", "preview-a", digest, branch, commit, "18"],
    ["deploy", "preview-b", digest, branch, commit, generation],
    ["deploy", "preview-a", digest, "codex/other", commit, generation],
  ]) {
    const result = fixture.run(...args);
    assert.notEqual(result.status, 0, `${args.join(" ")} unexpectedly succeeded`);
  }
  assert.equal(fixture.readLog(), "");

  const deployed = fixture.run("deploy", "preview-a", digest, branch, commit, generation);
  assert.equal(deployed.status, 0, deployed.stderr);
  assert.deepEqual(JSON.parse(deployed.stdout), { ok: true, action: "deploy", environment: "preview-a" });
  const log = fixture.readLog();
  assert.match(log, /docker compose --project-name preview-a-brai .* pull auth/);
  assert.match(log, /docker compose --project-name preview-a-brai .* up -d --no-build auth/);
  assert.doesNotMatch(`${deployed.stdout}${deployed.stderr}${log}`, /fixture-secret/);
});

test("failed Preview leases allow only rollback and cleanup actions", { skip: skipRuntime }, (context) => {
  const fixture = createFixture(context);
  fixture.writeRegistry("A", { branch, commit, lease_generation: Number(generation), status: "failed" });

  assert.notEqual(fixture.run("deploy", "preview-a", digest, branch, commit, generation).status, 0);
  assert.notEqual(fixture.run("route-enable", "preview-a", branch, commit, generation).status, 0);
  assert.equal(fixture.run("route-disable", "preview-a", branch, commit, generation).status, 0);
  assert.equal(fixture.run("rollback", "preview-a", "absent", "disabled", branch, commit, generation).status, 0);
  assert.equal(fixture.run("remove", "preview-a", branch, commit, generation).status, 0);
});

test("all seven environments use only their fixed port, env file, and Compose project", { skip: skipRuntime }, (context) => {
  const fixture = createFixture(context);
  const previewLeases = Object.fromEntries(["A", "B", "C", "D", "E"].map((slot, index) => [slot, {
    status: "deploying",
    branch: `codex/auth-${slot.toLowerCase()}`,
    commit: slot.toLowerCase().repeat(40),
    lease_generation: index + 1,
  }]));
  fixture.writeLeases(previewLeases);

  assert.equal(fixture.run("deploy", "prod", digest).status, 0);
  assert.equal(fixture.run("deploy", "dev", digest).status, 0);
  for (const [index, slot] of ["a", "b", "c", "d", "e"].entries()) {
    const result = fixture.run(
      "deploy", `preview-${slot}`, digest, `codex/auth-${slot}`, slot.repeat(40), String(index + 1),
    );
    assert.equal(result.status, 0, result.stderr);
  }

  const log = fixture.readLog();
  const expected = [
    ["brai", 3050, path.join(fixture.root, "etc/brai/brai-auth.env")],
    ["dev-brai", 3051, path.join(fixture.root, "srv/projects/brai-envs/dev/brai-auth.env")],
    ...["a", "b", "c", "d", "e"].map((slot, index) => [
      `preview-${slot}-brai`, 3052 + index,
      path.join(fixture.root, `srv/projects/brai-envs/preview-${slot}/brai-auth.env`),
    ]),
  ];
  for (const [project, port, envFile] of expected) {
    assert.match(log, new RegExp(`runtime env=${escapeRegExp(envFile)} port=${port}\\n`));
    assert.match(log, new RegExp(`docker compose --project-name ${project} `));
  }
  assert.doesNotMatch(log, /fixture-secret/);
});

test("enabled route keeps compatibility first, preserves official path, and protects developer releases", { skip: skipRuntime }, (context) => {
  const fixture = createFixture(context);
  const enabled = fixture.run("route-enable", "prod");
  assert.equal(enabled.status, 0, enabled.stderr);
  const route = fixture.readRoute("prod");
  const compatibility = route.indexOf("@brai_auth_compatibility");
  const official = route.indexOf("@brai_auth_official");
  const releases = route.indexOf("handle {args.11}");
  assert.ok(compatibility >= 0 && compatibility < official && official < releases);
  assert.match(route, /uri strip_prefix \{args\.6\}/);
  const officialBlock = route.slice(official, releases);
  assert.doesNotMatch(officialBlock, /strip_prefix/);
  assert.match(officialBlock, /reverse_proxy 127\.0\.0\.1:\{args\.9\}/);
  assert.match(officialBlock, /header_up Host \{args\.10\}/);
  assert.match(officialBlock, /header_up X-Forwarded-Host \{args\.10\}/);
  assert.match(officialBlock, /header_up X-Forwarded-Proto https/);
  assert.match(route.slice(releases), /import brai_unified_basic_auth[\s\S]+127\.0\.0\.1:\{args\.8\}/);
  assert.match(fixture.readLog(), /caddy validate --adapter caddyfile --config .*Caddyfile\nsystemctl reload caddy/);

  fixture.clearLog();
  const disabled = fixture.run("route-disable", "prod");
  assert.equal(disabled.status, 0, disabled.stderr);
  assert.equal(fixture.readRoute("prod"), "# Brai auth route is disabled until an exact-digest runtime deployment.\n");
  const once = fixture.readLog();
  assert.match(once, /caddy validate/);
  assert.equal(fixture.run("route-disable", "prod").status, 0);
  assert.equal(fixture.readLog(), once, "idempotent disable unexpectedly reloaded Caddy");
});

test("generated enabled fragment validates with the installed Caddy import syntax", { skip: skipRuntime || !hasCaddy }, (context) => {
  const fixture = createFixture(context);
  assert.equal(fixture.run("route-enable", "prod").status, 0);
  const config = path.join(fixture.root, "Caddyfile-enabled-test");
  const fragment = path.join(fixture.root, "etc/caddy/brai-auth/prod/route.caddy");
  fs.writeFileSync(config, `(brai_unified_basic_auth) {
  respond "protected" 401
}
http://127.0.0.1 {
  import ${fragment} /api/auth/login /api/auth/session /api/auth/logout /api/auth/otp/send /api/auth/otp/verify /api/auth/test-email-login /api /api/auth/* 3020 3050 app.brai.one /dev-releases*
  respond "fallback" 200
}
`);
  const validation = spawnSync("caddy", ["validate", "--adapter", "caddyfile", "--config", config], { encoding: "utf8" });
  assert.equal(validation.status, 0, `${validation.stdout}\n${validation.stderr}`);
});

test("failed Caddy validation and reload restore the previous fragment atomically", { skip: skipRuntime }, (context) => {
  for (const failure of ["caddy", "systemctl"]) {
    const fixture = createFixture(context);
    const before = fixture.readRoute("prod");
    fixture.failOnce(failure);
    const result = fixture.run("route-enable", "prod");
    assert.notEqual(result.status, 0, `${failure} failure unexpectedly succeeded`);
    assert.equal(fixture.readRoute("prod"), before);
    assert.match(result.stderr, /previous fragment was restored/);
    const log = fixture.readLog();
    assert.ok((log.match(/caddy validate/g) ?? []).length >= 2, log);
    assert.match(log, /systemctl reload caddy/);
  }
});

test("rollback and remove use only the fixed Compose service and restore the requested route state", { skip: skipRuntime }, (context) => {
  const fixture = createFixture(context);
  assert.equal(fixture.run("route-enable", "prod").status, 0);
  fixture.clearLog();

  const rollback = fixture.run("rollback", "prod", priorDigest, "disabled");
  assert.equal(rollback.status, 0, rollback.stderr);
  assert.equal(fixture.readRoute("prod"), "# Brai auth route is disabled until an exact-digest runtime deployment.\n");
  assert.match(fixture.readLog(), /pull auth[\s\S]+up -d --no-build auth/);
  assert.doesNotMatch(fixture.readLog(), /down|--remove-orphans/);

  fixture.clearLog();
  const remove = fixture.run("remove", "prod");
  assert.equal(remove.status, 0, remove.stderr);
  assert.match(fixture.readLog(), /docker compose --project-name brai .* rm --stop --force auth/);
});

function createFixture(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "brai-auth-bootstrap-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  const authRoot = path.join(root, "srv/opt/brai-auth");
  const caddyRoot = path.join(root, "etc/caddy/brai-auth");
  const envsRoot = path.join(root, "srv/projects/brai-envs");
  const log = path.join(root, "commands.log");
  const failCaddy = path.join(root, "fail-caddy-once");
  const failSystemctl = path.join(root, "fail-systemctl-once");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(authRoot, { recursive: true });
  fs.mkdirSync(caddyRoot, { recursive: true });
  fs.mkdirSync(path.join(root, "etc/brai"), { recursive: true });
  fs.writeFileSync(path.join(authRoot, "compose.yml"), fs.readFileSync(compose));
  fs.writeFileSync(path.join(authRoot, "caddy.lock"), "");
  fs.writeFileSync(path.join(root, "etc/caddy/Caddyfile"), "# complete test Caddyfile\n");
  fs.writeFileSync(path.join(root, "etc/brai/brai-auth.env"), "BETTER_AUTH_SECRET=fixture-secret\n");
  fs.writeFileSync(log, "");

  for (const environment of ["prod", "dev", "preview-a", "preview-b", "preview-c", "preview-d", "preview-e"]) {
    const envRoot = path.join(envsRoot, environment);
    const routeRoot = path.join(caddyRoot, environment);
    fs.mkdirSync(envRoot, { recursive: true });
    fs.mkdirSync(routeRoot, { recursive: true });
    fs.writeFileSync(path.join(envRoot, ".auth-operation.lock"), "");
    fs.writeFileSync(path.join(routeRoot, "route.caddy"), "# Brai auth route is disabled until an exact-digest runtime deployment.\n");
    if (environment !== "prod") fs.writeFileSync(path.join(envRoot, "brai-auth.env"), "BETTER_AUTH_SECRET=fixture-secret\n");
  }
  fs.writeFileSync(path.join(envsRoot, "preview-slots.lock"), "");
  fs.writeFileSync(path.join(envsRoot, "preview-slots.json"), JSON.stringify(emptyRegistry()));

  writeExecutable(path.join(bin, "docker"), `#!/usr/bin/env bash\nprintf 'runtime env=%s port=%s\\n' "$BRAI_AUTH_ENV_FILE" "$BRAI_AUTH_PORT" >>"$BRAI_AUTH_FAKE_LOG"\nprintf 'docker %s\\n' "$*" >>"$BRAI_AUTH_FAKE_LOG"\n`);
  writeExecutable(path.join(bin, "caddy"), `#!/usr/bin/env bash\nprintf 'caddy %s\\n' "$*" >>"$BRAI_AUTH_FAKE_LOG"\nif [[ -f "$BRAI_AUTH_FAKE_FAIL_CADDY" ]]; then rm -f "$BRAI_AUTH_FAKE_FAIL_CADDY"; exit 1; fi\n`);
  writeExecutable(path.join(bin, "systemctl"), `#!/usr/bin/env bash\nprintf 'systemctl %s\\n' "$*" >>"$BRAI_AUTH_FAKE_LOG"\nif [[ -f "$BRAI_AUTH_FAKE_FAIL_SYSTEMCTL" ]]; then rm -f "$BRAI_AUTH_FAKE_FAIL_SYSTEMCTL"; exit 1; fi\n`);

  const env = {
    ...process.env,
    BRAI_AUTH_TEST_MODE: "1",
    BRAI_AUTH_TEST_ROOT: root,
    BRAI_AUTH_TEST_BIN: bin,
    BRAI_AUTH_TEST_NODE_BIN: process.execPath,
    BRAI_AUTH_FAKE_LOG: log,
    BRAI_AUTH_FAKE_FAIL_CADDY: failCaddy,
    BRAI_AUTH_FAKE_FAIL_SYSTEMCTL: failSystemctl,
  };
  return {
    root,
    run: (...args) => spawnSync("bash", [helper, ...args], { cwd: repoRoot, env, encoding: "utf8" }),
    runWithEnv: (extra, ...args) => spawnSync("bash", [helper, ...args], { cwd: repoRoot, env: { ...env, ...extra }, encoding: "utf8" }),
    readLog: () => fs.readFileSync(log, "utf8"),
    clearLog: () => fs.writeFileSync(log, ""),
    readRoute: (environment) => fs.readFileSync(path.join(caddyRoot, environment, "route.caddy"), "utf8"),
    authLock: (environment) => path.join(envsRoot, environment, ".auth-operation.lock"),
    failOnce: (command) => fs.writeFileSync(command === "caddy" ? failCaddy : failSystemctl, "1"),
    writeRegistry: (slot, entry) => {
      const registry = emptyRegistry();
      registry[slot] = { ...registry[slot], ...entry };
      fs.writeFileSync(path.join(envsRoot, "preview-slots.json"), JSON.stringify(registry));
    },
    writeLeases: (entries) => {
      const registry = emptyRegistry();
      for (const [slot, entry] of Object.entries(entries)) registry[slot] = { ...registry[slot], ...entry };
      fs.writeFileSync(path.join(envsRoot, "preview-slots.json"), JSON.stringify(registry));
    },
  };
}

function emptyRegistry() {
  return Object.fromEntries(["A", "B", "C", "D", "E"].map((slot) => [slot, {
    status: "free",
    branch: null,
    commit: null,
    lease_generation: null,
  }]));
}

function writeExecutable(file, source) {
  fs.writeFileSync(file, source, { mode: 0o755 });
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
