import assert from "node:assert/strict";
import test from "node:test";

import {
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
