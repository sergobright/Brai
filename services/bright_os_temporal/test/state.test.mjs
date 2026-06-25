import test from "node:test";
import assert from "node:assert/strict";
import { applyPreviewEvent, applyPromotionEvent, createPreviewState, createPromotionState } from "../src/state.mjs";

test("preview deploy failure is retained as waiting_for_fix", () => {
  const state = createPreviewState({ branch: "codex/fake", sha: "a1" });
  applyPreviewEvent(state, { type: "checks_started", sha: "a1" });
  applyPreviewEvent(state, { type: "checks_passed", sha: "a1" });
  applyPreviewEvent(state, { type: "preview_deploy_started", sha: "a1", slot: "A" });
  applyPreviewEvent(state, { type: "preview_deploy_failed", sha: "a1" });

  assert.equal(state.status, "waiting_for_fix");
  assert.equal(state.checks, "passed");
  assert.equal(state.previewDeploy, "failed");
  assert.equal(state.slot, "A");
  assert.equal(state.tasks.preview_deploy.status, "failed");
  assert.equal(state.blocker.task, "preview_deploy");
});

test("promotion failure does not complete workflow", () => {
  const state = createPromotionState({ target: "dev", sha: "b1" });
  applyPromotionEvent(state, { type: "dev_deploy_started", sha: "b1" });
  applyPromotionEvent(state, { type: "dev_deploy_failed", sha: "b1" });

  assert.equal(state.status, "waiting_for_fix");
  assert.equal(state.deploy, "failed");
  assert.equal(state.terminal, false);
  assert.equal(state.tasks.deploy.status, "failed");
});

test("new preview push resets checks and deploy gates for the new sha", () => {
  const state = createPreviewState({ branch: "codex/fake", sha: "a1" });
  applyPreviewEvent(state, { type: "checks_passed", sha: "a1" });
  applyPreviewEvent(state, { type: "preview_deploy_passed", sha: "a1" });
  applyPreviewEvent(state, { type: "branch_pushed", sha: "a2" });

  assert.equal(state.lastSha, "a2");
  assert.equal(state.checks, "not_started");
  assert.equal(state.previewDeploy, "not_started");
  assert.equal(state.tasks.checks.status, "pending");
  assert.equal(state.tasks.preview_deploy.status, "pending");
  assert.equal(state.gates.complete, false);
});

test("slot release failure remains visible as a preview blocker", () => {
  const state = createPreviewState({ branch: "codex/fake", sha: "a1" });
  applyPreviewEvent(state, { type: "slot_release_started", sha: "a1" });
  applyPreviewEvent(state, { type: "slot_release_failed", sha: "a1" });

  assert.equal(state.status, "waiting_for_fix");
  assert.equal(state.tasks.slot_release.status, "failed");
  assert.equal(state.blocker.task, "slot_release");
});

test("preview deploy retry clears stale task blocker", () => {
  const state = createPreviewState({ branch: "codex/fake", sha: "a1" });
  applyPreviewEvent(state, { type: "preview_deploy_started", sha: "a1" });
  applyPreviewEvent(state, { type: "preview_deploy_failed", sha: "a1" });
  applyPreviewEvent(state, { type: "preview_deploy_started", sha: "a1" });
  applyPreviewEvent(state, { type: "preview_deploy_passed", sha: "a1" });

  assert.equal(state.tasks.preview_deploy.status, "passed");
  assert.equal(state.tasks.preview_deploy.blocker, undefined);
  assert.equal(state.blocker, null);
});

test("dev promotion tracks accepted preview release blocker", () => {
  const state = createPromotionState({ target: "dev", sha: "b1" });
  applyPromotionEvent(state, { type: "dev_deploy_started", sha: "b1" });
  applyPromotionEvent(state, { type: "dev_version_recorded", sha: "b1" });
  applyPromotionEvent(state, { type: "accepted_previews_started", sha: "b1" });
  applyPromotionEvent(state, { type: "accepted_previews_failed", sha: "b1" });

  assert.equal(state.status, "waiting_for_fix");
  assert.equal(state.tasks.version_recorded.status, "passed");
  assert.equal(state.tasks.accepted_previews.status, "failed");
  assert.equal(state.terminal, false);
});

test("prod promotion completes after version record and deploy pass", () => {
  const state = createPromotionState({ target: "prod", sha: "c1" });
  applyPromotionEvent(state, { type: "prod_deploy_started", sha: "c1" });
  applyPromotionEvent(state, { type: "prod_version_recorded", sha: "c1" });
  applyPromotionEvent(state, { type: "prod_deploy_passed", sha: "c1" });

  assert.equal(state.status, "prod_deploy_passed");
  assert.equal(state.tasks.deploy.status, "passed");
  assert.equal(state.tasks.version_recorded.status, "passed");
  assert.equal(state.tasks.accepted_previews.status, "not_applicable");
  assert.equal(state.terminal, true);
  assert.equal(state.gates.complete, true);
});
