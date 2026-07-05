import test from "node:test";
import assert from "node:assert/strict";

import { sandboxCheckMode } from "./brai-sandbox-check-mode.mjs";

test("sandbox helper marks Next and API commands as requiring escalation", () => {
  assert.equal(sandboxCheckMode(["npm", "run", "app:build"]).mode, "require_escalated");
  assert.equal(sandboxCheckMode(["npm", "--prefix", "services/brai_api", "test"]).mode, "require_escalated");
  assert.equal(sandboxCheckMode(["npm", "run", "socraticode:preflight"]).mode, "require_escalated");
  assert.equal(sandboxCheckMode(["npm", "run", "socraticode:ensure"]).mode, "require_escalated");
});

test("sandbox helper handles classify-delivery explicit files", () => {
  assert.equal(sandboxCheckMode(["node", "deploy/scripts/classify-delivery.mjs", "--file", "docs/foo.md"]).mode, "sandbox");
  assert.equal(sandboxCheckMode(["node", "deploy/scripts/classify-delivery.mjs"]).mode, "require_escalated");
  assert.equal(
    sandboxCheckMode(["node", "deploy/scripts/classify-delivery.mjs"], { BRAI_CHANGED_FILES: "docs/foo.md" }).mode,
    "sandbox",
  );
});

test("sandbox helper marks live operation completion as requiring escalation", () => {
  assert.equal(sandboxCheckMode(["deploy/scripts/complete-operation-activities.sh", "operation:agent-task:x"]).mode, "require_escalated");
  assert.equal(
    sandboxCheckMode(["deploy/scripts/complete-operation-activities.sh", "--local", "operation:agent-task:x"], {
      BRAI_DB: "/tmp/brai-test.sqlite",
    }).mode,
    "sandbox",
  );
});

test("sandbox helper marks host access checks as requiring escalation", () => {
  assert.equal(sandboxCheckMode(["node", "scripts/brai-task.mjs", "access-contract", "--server"]).mode, "require_escalated");
  assert.equal(sandboxCheckMode(["deploy/scripts/production-sqlite-maintenance.sh", "check"]).mode, "require_escalated");
  assert.equal(
    sandboxCheckMode(["deploy/scripts/production-sqlite-maintenance.sh", "check"], {
      BRAI_DB: "/tmp/brai-test.sqlite",
    }).mode,
    "sandbox",
  );
});

test("sandbox helper marks handoff commands as requiring escalation", () => {
  assert.equal(sandboxCheckMode(["scripts/brai-preview-handoff.sh"]).mode, "require_escalated");
  assert.equal(sandboxCheckMode(["node", "scripts/brai-task.mjs", "handoff"]).mode, "require_escalated");
  assert.equal(sandboxCheckMode(["node", "scripts/brai-task.mjs", "preview", "codex/foo"]).mode, "require_escalated");
});

test("sandbox helper marks browser and Android commands", () => {
  assert.equal(sandboxCheckMode(["npm", "run", "app:e2e"]).mode, "require_escalated");
  assert.equal(sandboxCheckMode(["agent-browser", "open", "https://brightos.world"]).mode, "agent_browser");
  assert.equal(sandboxCheckMode(["apps/brai_app/android/gradlew", ":app:testProductionDebugUnitTest"]).mode, "require_escalated");
});
