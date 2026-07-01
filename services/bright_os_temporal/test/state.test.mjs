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
  applyPreviewEvent(state, { type: "delivery_classified", sha: "a1", deliveryClass: "infra-docs" });
  applyPreviewEvent(state, { type: "delivery_handoff_passed", sha: "a1" });
  applyPreviewEvent(state, { type: "auto_merge_enabled", sha: "a1" });
  applyPreviewEvent(state, { type: "branch_pushed", sha: "a2" });

  assert.equal(state.lastSha, "a2");
  assert.equal(state.deliveryClass, "preview");
  assert.equal(state.handoff, "not_started");
  assert.equal(state.autoMerge, "not_started");
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

test("infra docs delivery completes without preview slot release", () => {
  const state = createPreviewState({ branch: "codex/infra-docs", sha: "d1" });
  applyPreviewEvent(state, { type: "delivery_classified", sha: "d1", deliveryClass: "infra-docs" });
  applyPreviewEvent(state, { type: "no_preview_required", sha: "d1" });
  applyPreviewEvent(state, { type: "checks_started", sha: "d1" });
  applyPreviewEvent(state, { type: "checks_passed", sha: "d1" });
  applyPreviewEvent(state, { type: "delivery_handoff_started", sha: "d1" });
  applyPreviewEvent(state, { type: "auto_merge_started", sha: "d1" });
  applyPreviewEvent(state, { type: "auto_merge_enabled", sha: "d1" });

  assert.equal(state.handoff, "running");
  assert.equal(state.tasks.delivery_handoff.status, "running");
  assert.equal(state.terminal, false);
  assert.equal(state.gates.complete, false);

  applyPreviewEvent(state, { type: "delivery_handoff_passed", sha: "d1", mergedAt: "2026-07-01T00:00:00Z" });

  assert.equal(state.handoff, "passed");
  assert.equal(state.tasks.delivery_handoff.status, "passed");
  assert.equal(state.terminal, false);
  assert.equal(state.tasks.accepted_for_target.status, "pending");

  applyPreviewEvent(state, { type: "pr_merged", sha: "d1", mergedAt: "2026-07-01T00:00:00Z" });

  assert.equal(state.deliveryClass, "infra-docs");
  assert.equal(state.handoff, "passed");
  assert.equal(state.autoMerge, "enabled");
  assert.equal(state.previewDeploy, "not_applicable");
  assert.equal(state.slot, "");
  assert.equal(state.tasks.preview_deploy.status, "not_applicable");
  assert.equal(state.tasks.accepted_preview_promotion.status, "not_applicable");
  assert.equal(state.tasks.slot_release.status, "not_applicable");
  assert.equal(state.tasks.delivery_handoff.status, "passed");
  assert.equal(state.tasks.delivery_handoff.lastEvent, "delivery_handoff_passed");
  assert.equal(state.tasks.accepted_for_target.status, "passed");
  assert.equal(state.status, "accepted_for_target");
  assert.equal(state.terminal, true);
  assert.equal(state.gates.complete, true);
});

test("infra docs PR merge does not complete without handoff passed", () => {
  const state = createPreviewState({ branch: "codex/infra-docs", sha: "d2" });
  applyPreviewEvent(state, { type: "delivery_classified", sha: "d2", deliveryClass: "infra-docs" });
  applyPreviewEvent(state, { type: "no_preview_required", sha: "d2" });
  applyPreviewEvent(state, { type: "checks_passed", sha: "d2" });
  applyPreviewEvent(state, { type: "auto_merge_enabled", sha: "d2" });
  applyPreviewEvent(state, { type: "pr_merged", sha: "d2", mergedAt: "2026-07-01T00:00:00Z" });

  assert.equal(state.tasks.accepted_for_target.status, "passed");
  assert.equal(state.tasks.delivery_handoff.status, "pending");
  assert.equal(state.terminal, false);
  assert.equal(state.gates.complete, false);
});

test("delivery classification, handoff, and auto merge failures block preview state", () => {
  const classification = createPreviewState({ branch: "codex/fake", sha: "e1" });
  applyPreviewEvent(classification, { type: "delivery_classification_failed", sha: "e1" });
  assert.equal(classification.status, "waiting_for_fix");
  assert.equal(classification.blocker.task, "delivery_classification");

  const handoff = createPreviewState({ branch: "codex/fake", sha: "e2" });
  applyPreviewEvent(handoff, { type: "delivery_handoff_started", sha: "e2" });
  applyPreviewEvent(handoff, { type: "delivery_handoff_failed", sha: "e2" });
  assert.equal(handoff.handoff, "failed");
  assert.equal(handoff.status, "waiting_for_fix");
  assert.equal(handoff.blocker.task, "delivery_handoff");

  const autoMerge = createPreviewState({ branch: "codex/fake", sha: "e3" });
  applyPreviewEvent(autoMerge, { type: "auto_merge_started", sha: "e3" });
  applyPreviewEvent(autoMerge, { type: "auto_merge_failed", sha: "e3" });
  assert.equal(autoMerge.autoMerge, "failed");
  assert.equal(autoMerge.status, "waiting_for_fix");
  assert.equal(autoMerge.blocker.task, "auto_merge");
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

test("prod promotion completes after accepted previews, version record, and deploy pass", () => {
  const state = createPromotionState({ target: "prod", sha: "c1" });
  applyPromotionEvent(state, { type: "prod_deploy_started", sha: "c1" });
  applyPromotionEvent(state, { type: "accepted_previews_started", sha: "c1" });
  applyPromotionEvent(state, { type: "prod_version_recorded", sha: "c1" });
  applyPromotionEvent(state, { type: "accepted_previews_passed", sha: "c1" });
  applyPromotionEvent(state, { type: "prod_deploy_passed", sha: "c1" });

  assert.equal(state.status, "prod_deploy_passed");
  assert.equal(state.tasks.deploy.status, "passed");
  assert.equal(state.tasks.version_recorded.status, "passed");
  assert.equal(state.tasks.accepted_previews.status, "passed");
  assert.equal(state.terminal, true);
  assert.equal(state.gates.complete, true);
});

test("prod promotion tracks accepted preview release blocker", () => {
  const state = createPromotionState({ target: "prod", sha: "c2" });
  applyPromotionEvent(state, { type: "prod_deploy_started", sha: "c2" });
  applyPromotionEvent(state, { type: "prod_version_recorded", sha: "c2" });
  applyPromotionEvent(state, { type: "accepted_previews_started", sha: "c2" });
  applyPromotionEvent(state, { type: "accepted_previews_failed", sha: "c2" });

  assert.equal(state.status, "waiting_for_fix");
  assert.equal(state.tasks.version_recorded.status, "passed");
  assert.equal(state.tasks.accepted_previews.status, "failed");
  assert.equal(state.terminal, false);
});
