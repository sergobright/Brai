import test from "node:test";
import assert from "node:assert/strict";

import { sandboxCheckMode } from "./brai-sandbox-check-mode.mjs";

test("sandbox helper marks Next and API commands as requiring escalation", () => {
  assert.equal(sandboxCheckMode(["npm", "run", "app:build"]).mode, "require_escalated");
  assert.equal(sandboxCheckMode(["npm", "--prefix", "services/brai_api", "test"]).mode, "require_escalated");
});

test("sandbox helper handles classify-delivery explicit files", () => {
  assert.equal(sandboxCheckMode(["node", "deploy/scripts/classify-delivery.mjs", "--file", "docs/foo.md"]).mode, "sandbox");
  assert.equal(sandboxCheckMode(["node", "deploy/scripts/classify-delivery.mjs"]).mode, "require_escalated");
  assert.equal(
    sandboxCheckMode(["node", "deploy/scripts/classify-delivery.mjs"], { BRAI_CHANGED_FILES: "docs/foo.md" }).mode,
    "sandbox",
  );
});

test("sandbox helper marks browser and Android commands", () => {
  assert.equal(sandboxCheckMode(["npm", "run", "app:e2e"]).mode, "require_escalated");
  assert.equal(sandboxCheckMode(["agent-browser", "open", "https://brightos.world"]).mode, "agent_browser");
  assert.equal(sandboxCheckMode(["apps/brai_app/android/gradlew", ":app:testProductionDebugUnitTest"]).mode, "require_escalated");
});
