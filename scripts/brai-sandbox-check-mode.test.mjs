import test from "node:test";
import assert from "node:assert/strict";

import { sandboxCheckMode } from "./brai-sandbox-check-mode.mjs";

test("sandbox helper marks Next and API commands as requiring escalation", () => {
  assert.equal(sandboxCheckMode(["npm", "run", "app:build"]).mode, "require_escalated");
  assert.equal(sandboxCheckMode(["npm", "run", "app:dev"]).mode, "require_escalated");
  assert.equal(sandboxCheckMode(["npm", "--prefix", "apps/brai_app", "run", "build"]).mode, "require_escalated");
  assert.equal(sandboxCheckMode(["npm", "--prefix", "apps/brai_app", "run", "dev"]).mode, "require_escalated");
  assert.equal(sandboxCheckMode(["npm", "--prefix", "admin", "run", "build"]).mode, "require_escalated");
  assert.equal(sandboxCheckMode(["npm", "--prefix", "admin", "run", "dev"]).mode, "require_escalated");
  assert.equal(sandboxCheckMode(["npm", "--prefix", "admin", "run", "start"]).mode, "require_escalated");
  assert.equal(sandboxCheckMode(["npm", "--prefix", "services/brai_api", "test"]).mode, "require_escalated");
  assert.equal(sandboxCheckMode(["npm", "--prefix", "services/brai_api", "run", "test"]).mode, "require_escalated");
  assert.equal(sandboxCheckMode(["scripts/brai-api-test.sh"]).mode, "require_escalated");
  assert.equal(sandboxCheckMode(["ansible-playbook", "--syntax-check", "deploy/ansible/brai.yml"]).mode, "require_escalated");
  assert.equal(sandboxCheckMode(["ansible", "localhost", "-m", "template"]).mode, "require_escalated");
  assert.equal(sandboxCheckMode(["npm", "run", "socraticode:preflight"]).mode, "require_escalated");
  assert.equal(sandboxCheckMode(["npm", "run", "socraticode:ensure"]).mode, "require_escalated");
});

test("sandbox helper handles classify-delivery explicit files and git writes", () => {
  assert.equal(sandboxCheckMode(["node", "deploy/scripts/classify-delivery.mjs", "--file", "docs/foo.md"]).mode, "sandbox");
  assert.equal(sandboxCheckMode(["node", "deploy/scripts/classify-delivery.mjs"]).mode, "require_escalated");
  assert.equal(
    sandboxCheckMode(["node", "deploy/scripts/classify-delivery.mjs"], { BRAI_CHANGED_FILES: "docs/foo.md" }).mode,
    "sandbox",
  );
  assert.equal(sandboxCheckMode(["git", "add", "AGENTS.md"]).mode, "require_escalated");
  assert.equal(sandboxCheckMode(["git", "commit", "-m", "guard"]).mode, "require_escalated");
});

test("sandbox helper marks live operation completion as requiring escalation", () => {
  assert.equal(sandboxCheckMode(["deploy/scripts/complete-operation-activities.sh", "operation:agent-task:x"]).mode, "require_escalated");
  assert.equal(sandboxCheckMode(["deploy/scripts/complete-operation-activities.sh", "--local", "operation:agent-task:x"]).mode, "require_escalated");
  assert.equal(sandboxCheckMode(["deploy/scripts/complete-inbox-operations.sh", "operation:agent-task:x"]).mode, "require_escalated");
  assert.equal(sandboxCheckMode(["deploy/scripts/create-operation-activity.sh", "--id", "operation:agent-task:x"]).mode, "require_escalated");
  assert.equal(sandboxCheckMode(["deploy/scripts/list-operation-activities.sh", "--limit", "5"]).mode, "require_escalated");
  assert.equal(sandboxCheckMode(["deploy/scripts/postgres-diagnostics.mjs"]).mode, "require_escalated");
  assert.equal(sandboxCheckMode(["deploy/scripts/supavisor-auth-diagnostics.sh"]).mode, "require_escalated");
});

test("sandbox helper marks host access checks as requiring escalation", () => {
  assert.equal(sandboxCheckMode(["node", "scripts/brai-task.mjs", "access-contract", "--server"]).mode, "require_escalated");
  assert.equal(sandboxCheckMode(["deploy/scripts/apply-main-infra.sh", "--check", "brai-vault"]).mode, "require_escalated");
});

test("sandbox helper marks handoff commands as requiring escalation", () => {
  assert.equal(sandboxCheckMode(["scripts/brai-preview-handoff.sh"]).mode, "require_escalated");
  assert.equal(sandboxCheckMode(["node", "scripts/brai-task.mjs", "handoff"]).mode, "require_escalated");
  assert.equal(sandboxCheckMode(["node", "scripts/brai-task.mjs", "preview", "codex/foo"]).mode, "require_escalated");
  assert.equal(sandboxCheckMode(["node", "scripts/brai-task.mjs", "acceptance-reconcile", "codex/foo"]).mode, "require_escalated");
  assert.equal(sandboxCheckMode(["deploy/scripts/accept-preview.sh", "codex/foo"]).mode, "require_escalated");
});

test("sandbox helper marks browser and Android commands", () => {
  assert.equal(sandboxCheckMode(["npm", "run", "app:e2e"]).mode, "require_escalated");
  assert.equal(sandboxCheckMode(["playwright", "test"]).mode, "require_escalated");
  assert.equal(sandboxCheckMode(["agent-browser", "open", "https://brightos.world"]).mode, "agent_browser");
  assert.equal(sandboxCheckMode(["npm", "run", "app:cap:sync"]).mode, "require_escalated");
  assert.equal(sandboxCheckMode(["npm", "run", "android:build:release"]).mode, "require_escalated");
  assert.equal(sandboxCheckMode(["deploy/scripts/build-android-env-apk.sh", "production"]).mode, "require_escalated");
  assert.equal(sandboxCheckMode(["apps/brai_app/android/gradlew", ":app:testProductionDebugUnitTest"]).mode, "require_escalated");
  assert.equal(sandboxCheckMode(["adb", "devices"]).mode, "require_escalated");
  assert.equal(sandboxCheckMode(["emulator", "-list-avds"]).mode, "require_escalated");
  assert.equal(sandboxCheckMode(["scripts/brai-task-start.sh", "sample-task"]).mode, "require_escalated");
});
