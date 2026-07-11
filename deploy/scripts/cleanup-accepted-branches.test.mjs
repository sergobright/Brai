import test from "node:test";
import assert from "node:assert/strict";

import { cleanupCandidates, deleteRemoteBranch } from "./cleanup-accepted-branches.mjs";

test("accepted branch cleanup selects merged inactive codex branches", () => {
  const pulls = [
    { base: { ref: "main" }, head: { ref: "codex/done" }, merged_at: "2026-07-07T00:00:00Z" },
    { base: { ref: "main" }, head: { ref: "codex/open" }, merged_at: "2026-07-07T00:00:00Z" },
    { base: { ref: "main" }, head: { ref: "codex/active" }, merged_at: "2026-07-07T00:00:00Z" },
    { base: { ref: "main" }, head: { ref: "feature/not-codex" }, merged_at: "2026-07-07T00:00:00Z" },
    { base: { ref: "dev" }, head: { ref: "codex/wrong-base" }, merged_at: "2026-07-07T00:00:00Z" },
    { base: { ref: "main" }, head: { ref: "codex/not-merged" }, merged_at: null },
  ];
  assert.deepEqual(cleanupCandidates({
    pulls,
    openPulls: [{ head: { ref: "codex/open" } }],
    activeBranches: ["codex/active"],
  }), ["codex/done"]);
});

test("accepted branch cleanup can be scoped to one branch", () => {
  const pulls = [
    { baseRefName: "main", headRefName: "codex/one", state: "MERGED" },
    { baseRefName: "main", headRefName: "codex/two", state: "MERGED" },
  ];
  assert.deepEqual(cleanupCandidates({ pulls, branches: ["codex/two"] }), ["codex/two"]);
});

test("explicit merged branch cleanup ignores stale open PR visibility", () => {
  const pulls = [{ merged_at: "2026-07-10T00:00:00Z", base: { ref: "main" }, head: { ref: "codex/done" } }];
  const openPulls = [{ base: { ref: "main" }, head: { ref: "codex/done" } }];

  assert.deepEqual(cleanupCandidates({ pulls, openPulls, branches: ["codex/done"] }), ["codex/done"]);
  assert.deepEqual(cleanupCandidates({ pulls, openPulls }), []);
});

test("accepted branch delete treats missing refs as idempotent", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, options) => {
      calls.push({ url, options });
      return { status: 422, text: async () => '{"message":"Reference does not exist"}' };
    };
    assert.deepEqual(await deleteRemoteBranch({ repository: "owner/repo", token: "token", branch: "codex/done" }), { deleted: false });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.method, "DELETE");
    assert.match(String(calls[0].url), /\/repos\/owner\/repo\/git\/refs\/heads\/codex\/done$/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
