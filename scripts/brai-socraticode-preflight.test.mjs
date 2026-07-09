import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  assertContextArtifactsFresh,
  assertExpectedProject,
  assertGraphFresh,
  assertLastOperationHealthy,
  assertWatcherActive,
  ensureGraphFresh,
  isGraphStale,
  parseCliArgs,
  parseCommittedProjectId,
  waitForWatcherActive,
} from "./brai-socraticode-preflight.mjs";

test("parseCommittedProjectId accepts a stable shared projectId", () => {
  assert.equal(parseCommittedProjectId('{"projectId":"brightos_brai"}'), "brightos_brai");
});

test("parseCommittedProjectId rejects missing or invalid projectId", () => {
  assert.throws(() => parseCommittedProjectId("{}"), /non-empty string projectId/);
  assert.throws(() => parseCommittedProjectId('{"projectId":"brai prod"}'), /projectId is invalid/);
});

test("parseCliArgs switches ensure mode explicitly", () => {
  assert.deepEqual(parseCliArgs([]), { mode: "preflight" });
  assert.deepEqual(parseCliArgs(["--ensure"]), { mode: "ensure" });
});

test("waitForWatcherActive polls until the watcher becomes active", async () => {
  let checks = 0;
  const active = await waitForWatcherActive(
    "/tmp/brai",
    async () => {
      checks += 1;
      return checks >= 3;
    },
    { attempts: 4, delayMs: 0 },
  );

  assert.equal(active, true);
  assert.equal(checks, 3);
});

test("preflight mode reads SocratiCode state without mutating local services", () => {
  const script = fs.readFileSync(new URL("./brai-socraticode-preflight.mjs", import.meta.url), "utf8");
  const preflightBlock = script.slice(script.indexOf("let info;"), script.indexOf("async function main()"));

  assert.doesNotMatch(preflightBlock, /ensureEmbeddingReady/);
  assert.doesNotMatch(preflightBlock, /indexProject/);
  assert.doesNotMatch(preflightBlock, /updateProjectIndex/);
  assert.doesNotMatch(preflightBlock, /startWatching/);
  assert.doesNotMatch(preflightBlock, /ensureWatcherFresh/);
});

test("ensure mode rechecks graph freshness after watcher startup catch-up", () => {
  const script = fs.readFileSync(new URL("./brai-socraticode-preflight.mjs", import.meta.url), "utf8");
  const ensureBlock = script.slice(script.indexOf('if (mode === "ensure")'), script.indexOf("let info;"));

  assert.match(ensureBlock, /await ensureGraphFresh[\s\S]+await ensureWatcherFresh[\s\S]+await ensureGraphFresh/);
});

test("preflight watcher check is read-only", async () => {
  await assertWatcherActive("/tmp/brai", async () => true);
  await assert.rejects(
    () => assertWatcherActive("/tmp/brai", async () => false),
    /SocratiCode watcher is inactive/,
  );
});

test("preflight requires the canonical shared Brai collection", () => {
  assert.doesNotThrow(() => assertExpectedProject({
    root: "/srv/projects/brai",
    committedProjectId: "brightos_brai",
    effectiveProjectId: "brightos_brai",
    collection: "codebase_brightos_brai",
  }));
  assert.throws(
    () => assertExpectedProject({
      root: "/srv/projects/brai",
      committedProjectId: "brightos_brai",
      effectiveProjectId: "4f78626dbb5e",
      collection: "codebase_4f78626dbb5e",
    }),
    /shared Brai index/,
  );
});

test("preflight fails on a remembered failed SocratiCode operation", () => {
  assert.doesNotThrow(() => assertLastOperationHealthy(null));
  assert.doesNotThrow(() => assertLastOperationHealthy({ type: "incremental-update" }));
  assert.throws(
    () => assertLastOperationHealthy({ type: "incremental-update", error: "fetch failed" }),
    /fetch failed/,
  );
});

test("preflight requires all context artifacts to be indexed", async () => {
  await assertContextArtifactsFresh("/tmp/brai", {
    getArtifactStatusSummary: async () => ({ configuredCount: 4, indexedCount: 4 }),
  });
  await assert.rejects(
    () => assertContextArtifactsFresh("/tmp/brai", {
      getArtifactStatusSummary: async () => ({ configuredCount: 4, indexedCount: 3 }),
    }),
    /3\/4 indexed/,
  );
});

test("graph freshness compares graph build time against index metadata", async () => {
  assert.equal(isGraphStale({
    metadata: { lastIndexedAt: "2026-07-09T10:00:00.000Z" },
    graph: { lastBuiltAt: "2026-07-09T10:00:01.000Z" },
  }), false);
  assert.equal(isGraphStale({
    metadata: { lastIndexedAt: "2026-07-09T10:00:01.000Z" },
    graph: { lastBuiltAt: "2026-07-09T10:00:00.000Z" },
  }), true);
  await assert.rejects(
    () => assertGraphFresh("/tmp/brai", "codebase_brightos_brai", {
      getProjectMetadata: async () => ({ lastIndexedAt: "2026-07-09T10:00:01.000Z" }),
      getGraphStatus: async () => ({ lastBuiltAt: "2026-07-09T10:00:00.000Z" }),
    }),
    /code graph is stale/,
  );
});

test("ensureGraphFresh rebuilds stale graph once", async () => {
  let rebuilt = false;
  await ensureGraphFresh("/tmp/brai", "codebase_brightos_brai", {
    getProjectMetadata: async () => ({ lastIndexedAt: "2026-07-09T10:00:01.000Z" }),
    getGraphStatus: async () => rebuilt
      ? ({ lastBuiltAt: "2026-07-09T10:00:02.000Z" })
      : ({ lastBuiltAt: "2026-07-09T10:00:00.000Z" }),
    rebuildGraph: async () => {
      rebuilt = true;
    },
  }, () => {});

  assert.equal(rebuilt, true);
});
