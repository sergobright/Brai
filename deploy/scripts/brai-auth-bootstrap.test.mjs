import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const helper = path.join(repoRoot, "deploy/ansible/files/brai-auth-runtime.sh");
const prodApiEnvHelper = path.join(repoRoot, "deploy/ansible/files/brai-prod-api-env.sh");
const compose = path.join(repoRoot, "deploy/ansible/files/brai-auth-compose.yml");
const authSudoers = path.join(repoRoot, "deploy/ansible/templates/brai-auth-sudoers.j2");
const deploySudoers = path.join(repoRoot, "deploy/ansible/templates/brai-deploy-sudoers.j2");
const authTasks = path.join(repoRoot, "deploy/ansible/tasks/brai-auth-bootstrap.yml");
const playbook = path.join(repoRoot, "deploy/ansible/brai.yml");
const apiService = path.join(repoRoot, "deploy/ansible/templates/brai-api.service.j2");
const groupVars = path.join(repoRoot, "deploy/ansible/group_vars/brai.yml");
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

test("auth sudoers grants are isolated from the shared deploy boundary", () => {
  const isolated = fs.readFileSync(authSudoers, "utf8");
  const shared = fs.readFileSync(deploySudoers, "utf8");
  const tasks = fs.readFileSync(authTasks, "utf8");
  assert.match(isolated, /brai_auth_runtime_helper \}\} pull-only \*/);
  assert.match(isolated, /brai_auth_runtime_helper \}\} deploy \*/);
  assert.match(isolated, /brai_auth_runtime_helper \}\} preflight-rollback \*/);
  assert.match(isolated, /brai_prod_api_env_helper \}\} stage \*/);
  assert.match(isolated, /brai_prod_api_env_helper \}\} rollback \*/);
  assert.match(isolated, /brai_prod_api_env_helper \}\} commit \*/);
  assert.doesNotMatch(isolated, /brai_prod_api_env_helper \}\} \*/);
  assert.match(isolated, /apply-main-infra\.sh --check brai-auth-bootstrap/);
  assert.match(isolated, /apply-main-infra\.sh --apply brai-auth-bootstrap/);
  assert.match(isolated, /brai_operation_maintainers/);
  assert.doesNotMatch(shared, /brai_auth_runtime_helper|brai-auth-bootstrap/);
  assert.match(tasks, /name: Install isolated Brai auth sudoers boundary[\s\S]*?dest: \/etc\/sudoers\.d\/brai-auth[\s\S]*?validate: "visudo -cf %s"/);
});

test("auth bootstrap isolates database administration and installs the fixed production API env helper", () => {
  const tasks = fs.readFileSync(authTasks, "utf8");
  const variables = fs.readFileSync(groupVars, "utf8");
  const playbookSource = fs.readFileSync(playbook, "utf8");
  const helperSource = fs.readFileSync(prodApiEnvHelper, "utf8");

  assert.match(variables, /^brai_db_admin_group: brai-db-admin$/m);
  assert.match(variables, /^brai_prod_api_env_helper: \/srv\/opt\/brai-prod-api-env\.sh$/m);
  assert.match(variables, /^brai_prod_api_env_state_root: "\{\{ brai_protected_env_dir \}\}\/\.brai-prod-api-env"$/m);
  assert.match(tasks, /name: Create isolated Brai database administrator group[\s\S]*?name: "\{\{ brai_db_admin_group \}\}"[\s\S]*?system: true/);
  assert.match(tasks, /name: Grant production database administration only to deploy and maintainers[\s\S]*?loop: "\{\{ \[brai_deploy_user\] \+ brai_operation_maintainers \}\}"/);
  assert.match(tasks, /name: Read Brai service identity group memberships[\s\S]*?brai_service_user[\s\S]*?brai_goal_agent_user/);
  assert.match(tasks, /name: Remove Brai service identities from production database administration[\s\S]*?\/usr\/bin\/gpasswd[\s\S]*?brai_db_admin_group in item\.stdout\.split\(\)/);
  assert.match(tasks, /name: Isolate protected Supabase deploy environment from runtime identities[\s\S]*?owner: root[\s\S]*?group: "\{\{ brai_db_admin_group \}\}"[\s\S]*?mode: "0640"/);
  assert.match(tasks, /name: Assert Brai service identities cannot read Supabase deploy credentials[\s\S]*?\/usr\/bin\/test[\s\S]*?- "!"[\s\S]*?- -r/);
  assert.match(tasks, /name: Assert production database administrators can read Supabase deploy credentials/);
  assert.match(tasks, /name: Install fixed production API environment transaction helper[\s\S]*?src: "\{\{ playbook_dir \}\}\/files\/brai-prod-api-env\.sh"[\s\S]*?dest: "\{\{ brai_prod_api_env_helper \}\}"[\s\S]*?mode: "0755"/);
  assert.match(tasks, /name: Provision root-only production API environment transaction state[\s\S]*?mode: "0700"/);
  assert.match(tasks, /name: Provision root-only production API environment transaction lock[\s\S]*?mode: "0600"/);
  assert.equal((playbookSource.match(/brai_supabase_deploy_env_source/g) ?? []).length, 0);
  assert.match(helperSource, /TARGET=".*\/etc\/brai\/brai-api\.env"/);
  assert.match(helperSource, /STATE_ROOT=".*\/etc\/brai\/\.brai-prod-api-env"/);
  assert.doesNotMatch(helperSource, /brai-auth-runtime\.sh/);
});

test("auth bootstrap target installs API and verified-backup cutover prerequisites", () => {
  const tasks = fs.readFileSync(playbook, "utf8");
  const service = fs.readFileSync(apiService, "utf8");
  const sudoers = fs.readFileSync(deploySudoers, "utf8");
  assert.equal((service.match(/BRAI_AUTH_INTERNAL_URL=http:\/\/127\.0\.0\.1:\{\{ item\.value\.auth_port \}\}/g) ?? []).length, 2);
  assert.match(tasks, /name: Check Brai API source directories before active-service restart[\s\S]*?tags:\n\s+- brai-auth-bootstrap\n\s+- brai-goal-agents/);
  assert.match(tasks, /name: Install Brai API systemd units[\s\S]*?tags:\n\s+- brai-auth-bootstrap\n\s+- brai-goal-agents/);
  assert.match(tasks, /name: Install Brai DB Telegram backup script[\s\S]*?tags:\n\s+- brai-db-backup\n\s+- brai-auth-bootstrap\n\s+- targeted-infra-apply/);
  assert.match(tasks, /name: Install Brai DB Telegram backup systemd units[\s\S]*?tags:\n\s+- brai-db-backup\n\s+- brai-auth-bootstrap\n\s+- targeted-infra-apply/);
  for (const name of [
    "Check Brai DB Telegram backup env file exists",
    "Refuse to create Brai DB Telegram backup secrets from source",
    "Ensure Brai DB Telegram backup env file permissions",
    "Check Brai DB Telegram backup encryption key exists",
    "Refuse to create Brai DB Telegram backup encryption key from source",
    "Ensure Brai DB Telegram backup encryption key permissions",
  ]) {
    const block = tasks.match(new RegExp(`- name: ${name}\\n[\\s\\S]*?(?=\\n    - name:)`))?.[0] ?? "";
    assert.match(block, /\n\s+- brai-auth-bootstrap\n/, `${name} is unreachable from brai-auth-bootstrap`);
  }
  assert.match(tasks, /name: Install deploy user sudoers boundary[\s\S]*?tags:\n\s+- brai-caddy\n\s+- brai-auth-bootstrap/);
  assert.match(sudoers, /^\{\{ brai_deploy_user \}\} ALL=\(root\) NOPASSWD: \/bin\/systemctl start brai-db-telegram-backup\.service$/m);
});

test("helper syntax and root/test boundary stay fixed", () => {
  const syntax = spawnSync("bash", ["-n", helper], { encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
  const source = fs.readFileSync(helper, "utf8");
  assert.match(source, /if \(\( EUID == 0 \)\)/);
  assert.match(source, /BRAI_AUTH_TEST_\* overrides are forbidden for root execution/);
  assert.match(source, /Unsupported test override/);
  assert.match(source, /pull-only/);
  assert.match(source, /deploy <environment> <digest> <source-sha>/);
  assert.match(source, /A short-lived GHCR token is required on stdin for pull-only/);
  assert.match(source, /DOCKER_CONFIG=.*login ghcr\.io --username sergobright --password-stdin/);
  assert.match(source, /org\.opencontainers\.image\.revision/);
  assert.match(source, /org\.opencontainers\.image\.source/);
  assert.match(source, /Auth image is not local; trusted CI must run pull-only before deploy/);
  assert.doesNotMatch(source, /docker\.sock|groupadd|usermod|set -x/);
});

test("unsupported input and mutable images fail before Docker or Caddy", { skip: skipRuntime }, (context) => {
  const fixture = createFixture(context);
  for (const args of [
    ["deploy", "unknown", digest, commit],
    ["start", "prod", digest],
    ["deploy", "prod", "ghcr.io/sergobright/brai-auth:latest", commit],
    ["deploy", "prod", digest, "/tmp/arbitrary-compose.yml"],
    ["deploy", "prod", digest, "C".repeat(40)],
    ["pull-only", digest, "C".repeat(40)],
    ["rollback", "prod", digest, "arbitrary-route"],
    ["rollback", "prod", "absent", "enabled"],
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

  const stale = fixture.run("deploy", "preview-a", digest, "d".repeat(40), branch, "d".repeat(40), generation);
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /branch, commit, lease, or slot does not match/);
  assert.doesNotMatch(stale.stderr, /auth-operation\.lock/);

  const missingLock = fixture.run("deploy", "preview-a", digest, commit, branch, commit, generation);
  assert.notEqual(missingLock.status, 0);
  assert.match(missingLock.stderr, /auth-operation\.lock/);
  fs.writeFileSync(authLock, "");

  for (const args of [
    ["deploy", "preview-a", digest, commit, branch, commit, "18"],
    ["deploy", "preview-b", digest, commit, branch, commit, generation],
    ["deploy", "preview-a", digest, commit, "codex/other", commit, generation],
  ]) {
    const result = fixture.run(...args);
    assert.notEqual(result.status, 0, `${args.join(" ")} unexpectedly succeeded`);
  }
  assert.equal(fixture.readLog(), "");

  fixture.markImageLocal();
  const deployed = fixture.run("deploy", "preview-a", digest, commit, branch, commit, generation);
  assert.equal(deployed.status, 0, deployed.stderr);
  assert.deepEqual(JSON.parse(deployed.stdout), { ok: true, action: "deploy", environment: "preview-a" });
  const log = fixture.readLog();
  assert.match(log, /docker image inspect ghcr\.io\/sergobright\/brai-auth@sha256:/);
  assert.doesNotMatch(log, /docker login ghcr\.io|docker pull/);
  assert.match(log, /org\.opencontainers\.image\.revision/);
  assert.match(log, /org\.opencontainers\.image\.source/);
  assert.match(log, /docker compose --project-name preview-a-brai .* up -d --no-build auth/);
  assert.doesNotMatch(`${deployed.stdout}${deployed.stderr}${log}`, /fixture-secret/);
});

test("pull-only consumes the token in an ephemeral Docker config while deploy is tokenless and local-only", { skip: skipRuntime }, (context) => {
  const fixture = createFixture(context);

  const missingToken = fixture.runWithoutToken("pull-only", digest, commit);
  assert.notEqual(missingToken.status, 0);
  assert.match(missingToken.stderr, /short-lived GHCR token is required on stdin for pull-only/);
  assert.doesNotMatch(fixture.readLog(), /login ghcr\.io|docker pull|up -d/);

  fixture.clearLog();
  const rejectedToken = fixture.runWithInput("wrong-token\n", "pull-only", digest, commit);
  assert.notEqual(rejectedToken.status, 0);
  assert.match(rejectedToken.stderr, /Short-lived GHCR authentication failed/);
  assert.deepEqual(
    fs.readdirSync(path.join(fixture.root, "srv/opt/brai-auth")).filter((entry) => entry.startsWith(".registry-login.")),
    [],
  );

  fixture.clearLog();
  const pulled = fixture.runWithInput("fixture-token\n", "pull-only", digest, commit);
  assert.equal(pulled.status, 0, pulled.stderr);
  assert.match(fixture.readLog(), /docker login ghcr\.io --username sergobright --password-stdin/);
  assert.match(fixture.readLog(), /docker pull ghcr\.io\/sergobright\/brai-auth@sha256:/);
  assert.doesNotMatch(`${pulled.stdout}${pulled.stderr}${fixture.readLog()}`, /fixture-token/);
  assert.deepEqual(
    fs.readdirSync(path.join(fixture.root, "srv/opt/brai-auth")).filter((entry) => entry.startsWith(".registry-login.")),
    [],
  );

  fixture.clearLog();
  const local = fixture.runWithoutToken("deploy", "prod", digest, commit);
  assert.equal(local.status, 0, local.stderr);
  assert.match(fixture.readLog(), /docker image inspect/);
  assert.match(fixture.readLog(), /up -d --no-build auth/);
  assert.doesNotMatch(fixture.readLog(), /login ghcr\.io|docker pull/);
  assert.deepEqual(
    fs.readdirSync(path.join(fixture.root, "srv/opt/brai-auth")).filter((entry) => entry.startsWith(".registry-login.")),
    [],
  );
});

test("failed Preview leases allow only rollback and cleanup actions", { skip: skipRuntime }, (context) => {
  const fixture = createFixture(context);
  fixture.writeRegistry("A", { branch, commit, lease_generation: Number(generation), status: "failed" });

  assert.notEqual(fixture.run("deploy", "preview-a", digest, commit, branch, commit, generation).status, 0);
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

  fixture.markImageLocal();
  assert.equal(fixture.run("deploy", "prod", digest, commit).status, 0);
  assert.equal(fixture.run("deploy", "dev", digest, commit).status, 0);
  for (const [index, slot] of ["a", "b", "c", "d", "e"].entries()) {
    fixture.markImageLocal({ revision: slot.repeat(40) });
    const result = fixture.run(
      "deploy", `preview-${slot}`, digest, slot.repeat(40), `codex/auth-${slot}`, slot.repeat(40), String(index + 1),
    );
    assert.equal(result.status, 0, result.stderr);
  }

  const log = fixture.readLog();
  const expected = [
    ["brai", 3050, path.join(fixture.root, "srv/projects/brai-envs/prod/brai-auth.env")],
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

test("deploy rejects missing or mismatched OCI identity before Compose up", { skip: skipRuntime }, (context) => {
  const fixture = createFixture(context);
  for (const identity of [
    { revision: "d".repeat(40), source: "https://github.com/sergobright/Brai", error: /revision label/ },
    { revision: commit, source: "https://github.com/attacker/repo", error: /source label/ },
    { revision: "", source: "https://github.com/sergobright/Brai", error: /revision label/ },
    { revision: commit, source: "", error: /source label/ },
  ]) {
    fixture.markImageLocal(identity);
    fixture.clearLog();
    const result = fixture.runWithoutToken("deploy", "prod", digest, commit);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, identity.error);
    assert.doesNotMatch(fixture.readLog(), /up -d --no-build/);
  }
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
  fixture.markImageLocal();
  const prodEnv = path.join(fixture.root, "srv/projects/brai-envs/prod/brai-auth.env");
  fs.chmodSync(prodEnv, 0o640);
  const unsafeEnv = fixture.runWithoutToken("preflight-rollback", "prod", priorDigest, "disabled");
  assert.notEqual(unsafeEnv.status, 0);
  assert.match(unsafeEnv.stderr, /exact mode 600/);
  fs.chmodSync(prodEnv, 0o600);
  fixture.clearLog();

  const rollback = fixture.runWithoutToken("rollback", "prod", priorDigest, "disabled");
  assert.equal(rollback.status, 0, rollback.stderr);
  assert.equal(fixture.readRoute("prod"), "# Brai auth route is disabled until an exact-digest runtime deployment.\n");
  assert.match(fixture.readLog(), /image inspect[\s\S]+up -d --no-build auth/);
  assert.doesNotMatch(fixture.readLog(), /login ghcr\.io|pull auth/);
  assert.doesNotMatch(fixture.readLog(), /down|--remove-orphans/);

  fixture.clearLog();
  const remove = fixture.run("remove", "prod");
  assert.equal(remove.status, 0, remove.stderr);
  assert.match(fixture.readLog(), /docker compose --project-name brai .* rm --stop --force auth/);
});

test("rollback preflight is read-only and requires a local prior image", { skip: skipRuntime }, (context) => {
  const fixture = createFixture(context);
  const missing = fixture.runWithoutToken("preflight-rollback", "prod", priorDigest, "disabled");
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /Prior auth image is not local/);
  assert.doesNotMatch(fixture.readLog(), /up -d|rm --stop|systemctl reload/);

  fixture.markImageLocal();
  fixture.clearLog();
  const ready = fixture.runWithoutToken("preflight-rollback", "prod", priorDigest, "disabled");
  assert.equal(ready.status, 0, ready.stderr);
  assert.match(fixture.readLog(), /caddy validate[\s\S]*image inspect/);
  assert.doesNotMatch(fixture.readLog(), /up -d|rm --stop|systemctl reload/);
});

test("rollback recovers the runtime but still fails when Caddy disable fails", { skip: skipRuntime }, (context) => {
  const restored = createFixture(context);
  assert.equal(restored.run("route-enable", "prod").status, 0);
  restored.markImageLocal();
  restored.clearLog();
  restored.failOnce("systemctl");
  const prior = restored.runWithoutToken("rollback", "prod", priorDigest, "enabled");
  assert.notEqual(prior.status, 0);
  assert.match(prior.stderr, /runtime recovery completed but rollback did not succeed/);
  assert.match(restored.readLog(), /image inspect[\s\S]+up -d --no-build auth/);
  assert.doesNotMatch(restored.readLog(), /login ghcr\.io|pull auth/);
  assert.match(restored.readRoute("prod"), /@brai_auth_official/);
  assert.equal(prior.stdout, "");

  const disabledPrior = createFixture(context);
  assert.equal(disabledPrior.run("route-enable", "prod").status, 0);
  disabledPrior.markImageLocal();
  disabledPrior.clearLog();
  disabledPrior.failOnce("systemctl");
  const disabled = disabledPrior.runWithoutToken("rollback", "prod", priorDigest, "disabled");
  assert.notEqual(disabled.status, 0);
  assert.match(disabledPrior.readLog(), /image inspect[\s\S]+up -d --no-build auth/);
  assert.doesNotMatch(disabledPrior.readLog(), /rm --stop --force auth/);
  assert.equal(disabled.stdout, "");

  const removed = createFixture(context);
  assert.equal(removed.run("route-enable", "prod").status, 0);
  removed.clearLog();
  removed.failOnce("systemctl");
  const absent = removed.run("rollback", "prod", "absent", "disabled");
  assert.notEqual(absent.status, 0);
  assert.match(removed.readLog(), /rm --stop --force auth/);
  assert.equal(absent.stdout, "");
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
  const localImage = path.join(root, "local-auth-image");
  const imageRevision = path.join(root, "local-auth-image.revision");
  const imageSource = path.join(root, "local-auth-image.source");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(authRoot, { recursive: true });
  fs.mkdirSync(caddyRoot, { recursive: true });
  fs.writeFileSync(path.join(authRoot, "compose.yml"), fs.readFileSync(compose));
  fs.writeFileSync(path.join(authRoot, "caddy.lock"), "");
  fs.writeFileSync(path.join(root, "etc/caddy/Caddyfile"), "# complete test Caddyfile\n");
  fs.writeFileSync(log, "");

  for (const environment of ["prod", "dev", "preview-a", "preview-b", "preview-c", "preview-d", "preview-e"]) {
    const envRoot = path.join(envsRoot, environment);
    const routeRoot = path.join(caddyRoot, environment);
    fs.mkdirSync(envRoot, { recursive: true });
    fs.mkdirSync(routeRoot, { recursive: true });
    fs.writeFileSync(path.join(envRoot, ".auth-operation.lock"), "");
    fs.writeFileSync(path.join(routeRoot, "route.caddy"), "# Brai auth route is disabled until an exact-digest runtime deployment.\n");
    fs.writeFileSync(path.join(envRoot, "brai-auth.env"), "BETTER_AUTH_SECRET=fixture-secret\n", { mode: 0o600 });
  }
  fs.writeFileSync(path.join(envsRoot, "preview-slots.lock"), "");
  fs.writeFileSync(path.join(envsRoot, "preview-slots.json"), JSON.stringify(emptyRegistry()));

  writeExecutable(path.join(bin, "docker"), `#!/usr/bin/env bash\nprintf 'runtime env=%s port=%s\\n' "\${BRAI_AUTH_ENV_FILE:-}" "\${BRAI_AUTH_PORT:-}" >>"$BRAI_AUTH_FAKE_LOG"\nprintf 'docker %s\\n' "$*" >>"$BRAI_AUTH_FAKE_LOG"\nif [[ "$1 $2" == "image inspect" ]]; then\n  [[ -f "$BRAI_AUTH_FAKE_LOCAL_IMAGE" ]] || exit 1\n  if [[ "\${3:-}" == "--format" ]]; then\n    case "\${4:-}" in\n      *org.opencontainers.image.revision*) [[ ! -f "$BRAI_AUTH_FAKE_IMAGE_REVISION" ]] || cat "$BRAI_AUTH_FAKE_IMAGE_REVISION" ;;\n      *org.opencontainers.image.source*) [[ ! -f "$BRAI_AUTH_FAKE_IMAGE_SOURCE" ]] || cat "$BRAI_AUTH_FAKE_IMAGE_SOURCE" ;;\n      *) exit 2 ;;\n    esac\n  fi\n  exit 0\nfi\nif [[ "$1" == "login" ]]; then IFS= read -r token; [[ "$token" == "fixture-token" ]]; exit; fi\nif [[ "$1" == "pull" ]]; then\n  touch "$BRAI_AUTH_FAKE_LOCAL_IMAGE"\n  printf '%s' "$BRAI_AUTH_FAKE_DEFAULT_REVISION" >"$BRAI_AUTH_FAKE_IMAGE_REVISION"\n  printf '%s' "$BRAI_AUTH_FAKE_DEFAULT_SOURCE" >"$BRAI_AUTH_FAKE_IMAGE_SOURCE"\nfi\n`);
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
    BRAI_AUTH_FAKE_LOCAL_IMAGE: localImage,
    BRAI_AUTH_FAKE_IMAGE_REVISION: imageRevision,
    BRAI_AUTH_FAKE_IMAGE_SOURCE: imageSource,
    BRAI_AUTH_FAKE_DEFAULT_REVISION: commit,
    BRAI_AUTH_FAKE_DEFAULT_SOURCE: "https://github.com/sergobright/Brai",
  };
  return {
    root,
    run: (...args) => spawnSync("bash", [helper, ...args], { cwd: repoRoot, env, encoding: "utf8", input: "fixture-token\n" }),
    runWithoutToken: (...args) => spawnSync("bash", [helper, ...args], { cwd: repoRoot, env, encoding: "utf8" }),
    runWithInput: (input, ...args) => spawnSync("bash", [helper, ...args], { cwd: repoRoot, env, encoding: "utf8", input }),
    runWithEnv: (extra, ...args) => spawnSync("bash", [helper, ...args], { cwd: repoRoot, env: { ...env, ...extra }, encoding: "utf8", input: "fixture-token\n" }),
    readLog: () => fs.readFileSync(log, "utf8"),
    clearLog: () => fs.writeFileSync(log, ""),
    readRoute: (environment) => fs.readFileSync(path.join(caddyRoot, environment, "route.caddy"), "utf8"),
    authLock: (environment) => path.join(envsRoot, environment, ".auth-operation.lock"),
    markImageLocal: ({ revision = commit, source = "https://github.com/sergobright/Brai" } = {}) => {
      fs.writeFileSync(localImage, "1");
      fs.writeFileSync(imageRevision, revision);
      fs.writeFileSync(imageSource, source);
    },
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
