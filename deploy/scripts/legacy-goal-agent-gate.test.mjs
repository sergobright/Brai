import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../..");
const script = path.join(root, "deploy/scripts/ci-ssh-deploy-goal-agents.sh");
const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();

function run(env = {}) {
  return spawnSync("bash", [script], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, BRAI_BRANCH: "codex/legacy-preview", BRAI_COMMIT: head, ...env },
  });
}

test("legacy Preview commits skip only a gate introduced after their ancestry", () => {
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /gate is not applicable/);
});

test("the compatibility shim fails closed when the gate commit is present", () => {
  const result = run({ BRAI_GOAL_AGENT_GATE_COMMIT: head });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /gate is required/);
});

test("the compatibility shim cannot run for production", () => {
  const result = run({ BRAI_BRANCH: "main" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Preview-only/);
});
