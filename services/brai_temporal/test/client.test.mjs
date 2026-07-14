import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

test("client wait returns terminal target before stale blockers", () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, "../src/client.mjs"), "utf8");
  const waitStart = source.indexOf("async function waitForState");
  const waitBody = source.slice(waitStart, source.indexOf("function isBlocked", waitStart));

  assert.ok(waitBody.indexOf("if (done(lastState)) return lastState") < waitBody.indexOf("if (isBlocked(lastState))"));
});

test("preview deploy dispatch and query are bound to the requested SHA", () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, "../src/client.mjs"), "utf8");
  const dispatchStart = source.indexOf("async function dispatchPreviewDeploy");
  const dispatchBody = source.slice(dispatchStart, source.indexOf("async function dispatchNoPreviewHandoff", dispatchStart));

  assert.match(dispatchBody, /previewReadyForSha\(current, sha\)/);
  assert.doesNotMatch(dispatchBody, /current\.status === "ready_for_review"/);
  assert.match(dispatchBody, /BranchPreviewDeployWorkflow/);
  assert.match(dispatchBody, /previewDeployWorkflowId\(branch, sha\)/);
  assert.match(dispatchBody, /BRAI_TEMPORAL_EXACT_SHA_PREVIEW/);
  assert.match(dispatchBody, /workflowIdConflictPolicy: "TERMINATE_EXISTING"/);
  assert.doesNotMatch(dispatchBody, /startAndSignalPreview/);
  assert.match(source, /query-preview-deploy/);
  assert.match(source, /query-preview-deploy[\s\S]*readWorkflowResult/);
  assert.match(source, /async function readWorkflowResult[\s\S]*\.result\(\)/);
  assert.match(source, /cancel-preview-deploy/);
  assert.match(source, /previewDeployWorkflowId\(required\(opts, "branch"\), required\(opts, "sha"\)\)/);
});
