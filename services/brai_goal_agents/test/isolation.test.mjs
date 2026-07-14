import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { codexEnvironment } from "../src/llm.mjs";
import { loadManifest } from "../src/manifest.mjs";
import { agentDeploymentVersion } from "../src/versioning.mjs";
import {
  assertCredentialIsolation,
  FORBIDDEN_RUNTIME_KEYS,
  runAgentWorker,
  workerIdentity,
  workerOptionsFor
} from "../src/runner.mjs";

test("Codex subprocess receives only the explicit transport allowlist", () => {
  const childEnv = codexEnvironment({
    PATH: "/bin",
    CODEX_HOME: "/safe/codex",
    HOME: "/safe/home",
    BRAI_DATABASE_URL: "postgres://secret",
    BRAI_API_TOKEN: "secret",
    SUPABASE_SERVICE_ROLE_KEY: "secret",
    RANDOM_SECRET: "secret"
  });
  assert.deepEqual(childEnv, {
    PATH: "/bin",
    CODEX_HOME: "/safe/codex",
    HOME: "/safe/home"
  });
});

test("worker refuses Brai database and API credentials", () => {
  assert.doesNotThrow(() => assertCredentialIsolation({ TEMPORAL_ADDRESS: "127.0.0.1:7233" }));
  assert.throws(() => assertCredentialIsolation({
    BRAI_DATABASE_URL: "postgres://secret",
    BRAI_API_TOKEN: "secret"
  }), /forbidden_agent_credentials:BRAI_API_TOKEN,BRAI_DATABASE_URL/);
});

test("worker and systemd use the canonical fail-closed credential denylist", () => {
  const policy = JSON.parse(fs.readFileSync(new URL("../runtime-policy.json", import.meta.url), "utf8"));
  const unit = fs.readFileSync(
    path.resolve(import.meta.dirname, "../../../deploy/ansible/templates/brai-goal-agent.service.j2"),
    "utf8"
  );
  assert.deepEqual(FORBIDDEN_RUNTIME_KEYS, policy.forbidden_environment_keys);
  assert.match(unit, /runtime-policy\.json/);
  assert.match(unit, /forbidden_environment_keys \| join\(' '\)/);
  for (const key of policy.forbidden_environment_keys) {
    assert.throws(() => assertCredentialIsolation({ [key]: "must-not-reach-agent" }),
      new RegExp(`forbidden_agent_credentials:${key}`));
  }
});

test("systemd verifies Codex access under the isolated worker identity before polling", () => {
  const unit = fs.readFileSync(
    path.resolve(import.meta.dirname, "../../../deploy/ansible/templates/brai-goal-agent.service.j2"),
    "utf8"
  );
  const start = unit.indexOf("ExecStart={{ brai_node_bin }} src/entrypoints/");
  for (const check of [
    "ExecStartPre=/usr/bin/test -r {{ brai_goal_agent_codex_home }}/auth.json",
    "ExecStartPre=/usr/bin/test -r {{ brai_goal_agent_codex_home }}/config.toml",
    "ExecStartPre={{ brai_codex_bin }} --version"
  ]) {
    assert.ok(unit.indexOf(check) > 0 && unit.indexOf(check) < start, `${check} must fail before worker start`);
  }
  assert.doesNotMatch(unit, /^ExecStartPre=.*(?:sudo|brai-deploy)/m);
});

test("worker refuses model drift before opening a Temporal connection", async () => {
  let connected = false;
  await assert.rejects(() => runAgentWorker("goal.planner", {
    env: {
      BRAI_ENVIRONMENT: "preview-e",
      BRAI_GOAL_AGENT_TASK_QUEUE: "brai-agent-goal-planner-preview-e",
      BRAI_GOAL_PLANNER_MODEL: "silent-model-drift"
    },
    createConnection: async () => {
      connected = true;
      return { close: async () => {} };
    }
  }), /goal_agent_model_contract_mismatch/);
  assert.equal(connected, false);
});

test("one worker option set binds one manifest to one exact queue", async () => {
  const manifest = await loadManifest("goal.discovery");
  const deploymentVersion = agentDeploymentVersion(manifest, "preview-c");
  const options = workerOptionsFor({
    manifest,
    environment: "preview-c",
    taskQueue: "brai-agent-goal-discovery-preview-c",
    namespace: "default",
    identity: workerIdentity(manifest, "preview-c", "host", 42),
    connection: {},
    env: {}
  });
  assert.equal(options.taskQueue, "brai-agent-goal-discovery-preview-c");
  assert.equal(options.identity, "goal.discovery:preview-c:host:42");
  assert.equal(options.maxConcurrentActivityTaskExecutions, 1);
  assert.deepEqual(Object.keys(options.activities), ["invokeAgent"]);
  assert.deepEqual(options.workerDeploymentOptions, {
    version: {
      deploymentName: "brai-agent-goal-discovery-preview-c",
      buildId: deploymentVersion.buildId
    },
    useWorkerVersioning: true,
    defaultVersioningBehavior: "PINNED"
  });
  assert.equal("buildId" in options, false);
});

test("Goal agent package imports neither API persistence nor network listeners", () => {
  const src = path.resolve(import.meta.dirname, "../src");
  const text = fs.readdirSync(src)
    .filter((name) => name.endsWith(".mjs"))
    .map((name) => fs.readFileSync(path.join(src, name), "utf8"))
    .join("\n");
  assert.doesNotMatch(text, /services\/brai_api|from ["']pg["']|postgres|createServer|\.listen\s*\(/i);
});

test("runner performs graceful signal shutdown and closes Temporal connection", async () => {
  let finishRun;
  let shutdowns = 0;
  let closed = false;
  const logs = [];
  const running = runAgentWorker("goal.planner", {
    env: {
      BRAI_ENVIRONMENT: "preview-e",
      BRAI_GOAL_AGENT_TASK_QUEUE: "brai-agent-goal-planner-preview-e"
    },
    createConnection: async () => ({ async close() { closed = true; } }),
    createWorker: async () => ({
      run: () => new Promise((resolve) => { finishRun = resolve; }),
      shutdown() {
        shutdowns += 1;
        finishRun();
      }
    }),
    log: { info: (line) => logs.push(JSON.parse(line)) }
  });
  while (!finishRun) await new Promise((resolve) => setImmediate(resolve));
  process.emit("SIGTERM");
  await running;
  assert.equal(shutdowns, 1);
  assert.equal(closed, true);
  assert.deepEqual(logs.map((entry) => entry.event), [
    "goal_agent_started",
    "goal_agent_shutdown",
    "goal_agent_stopped"
  ]);
});
