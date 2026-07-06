import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  assertWatcherActive,
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

test("preflight watcher check is read-only", async () => {
  await assertWatcherActive("/tmp/brai", async () => true);
  await assert.rejects(
    () => assertWatcherActive("/tmp/brai", async () => false),
    /SocratiCode watcher is inactive/,
  );
});
