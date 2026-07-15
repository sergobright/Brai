import assert from "node:assert/strict";
import test from "node:test";

import { runWatcherCheck } from "./brai-socraticode-watcher.mjs";

test("SocratiCode watcher ensures once at startup", async () => {
  const modes = [];
  const result = await runWatcherCheck({
    reason: "startup",
    root: "/srv/projects/brai",
    report: () => {},
    runCheck: async ({ mode }) => modes.push(mode),
  });

  assert.deepEqual(modes, ["ensure"]);
  assert.deepEqual(result, { mode: "ensure" });
});

test("SocratiCode watcher timer is read-only while preflight is healthy", async () => {
  const modes = [];
  const result = await runWatcherCheck({
    reason: "timer",
    root: "/srv/projects/brai",
    report: () => {},
    runCheck: async ({ mode }) => modes.push(mode),
  });

  assert.deepEqual(modes, ["preflight"]);
  assert.deepEqual(result, { mode: "preflight" });
});

test("SocratiCode watcher never starts a mutating repair from the timer", async () => {
  const modes = [];
  await assert.rejects(
    runWatcherCheck({
      reason: "timer",
      root: "/srv/projects/brai",
      report: () => {},
      runCheck: async ({ mode }) => {
        modes.push(mode);
        throw new Error("stale graph");
      },
    }),
    /stale graph/,
  );

  assert.deepEqual(modes, ["preflight"]);
});
