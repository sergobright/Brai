import assert from "node:assert/strict";
import test from "node:test";
import { scopeHash, selectTestSchemas } from "./cleanup-test-schemas.mjs";

test("test schema cleanup isolates branches and concurrent runs", () => {
  const branch = "codex/cleanup";
  const run = "run-one";
  const branchPrefix = `brai_test_${scopeHash(branch)}_`;
  const runPrefix = `${branchPrefix}${scopeHash(run)}_`;
  const names = [
    `${runPrefix}a_b_c`,
    `${branchPrefix}${scopeHash("run-two")}_a_b_c`,
    `brai_test_${scopeHash("codex/other")}_${scopeHash(run)}_a_b_c`
  ];

  assert.deepEqual(selectTestSchemas(names, { branch, runId: run }), [names[0]]);
  assert.deepEqual(selectTestSchemas(names, { branch }), names.slice(0, 2).sort());
});

test("legacy cleanup only selects unscoped schemas older than the safety window", () => {
  const now = Date.UTC(2026, 6, 10, 12);
  const oldLegacy = `brai_test_123_${now - 25 * 60 * 60 * 1000}_abcdef`;
  const recentLegacy = `brai_test_123_${now - 23 * 60 * 60 * 1000}_abcdef`;
  const scoped = `brai_test_${scopeHash("codex/other")}_${scopeHash("run")}_a_b_c`;

  assert.deepEqual(selectTestSchemas([recentLegacy, scoped, oldLegacy], {
    branch: "codex/cleanup",
    legacyBeforeMs: 24 * 60 * 60 * 1000,
    now
  }), [oldLegacy]);
});
