import assert from "node:assert/strict";
import test from "node:test";

import { classifyVersionWorkState } from "./version-work-state.mjs";

test("partially promoted native work stays eligible without duplicating its Product build", () => {
  const state = classifyVersionWorkState({
    latestBuildVersion: 157,
    works: [
      { workKey: "work_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", status: "finalized", hasBuild: true, nativeBoundary: false, hasApk: false, pulls: [{ repository: "HexaFox-Labs/Brai", pullNumber: 315 }] },
      { workKey: "work_bbbbbbbb-cccc-4ddd-8eee-ffffffffffff", status: "finalized", hasBuild: true, nativeBoundary: true, hasApk: false, pulls: [{ repository: "HexaFox-Labs/Brai", pullNumber: 318 }] },
      { workKey: "work_cccccccc-dddd-4eee-8fff-000000000000", status: "finalized", hasBuild: true, nativeBoundary: true, hasApk: true, pulls: [{ repository: "HexaFox-Labs/Brai", pullNumber: 314 }] },
    ],
  });

  assert.equal(state.latestBuildVersion, 157);
  assert.deepEqual(state.finalizedBuildWorkKeys, [
    "work_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    "work_bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
    "work_cccccccc-dddd-4eee-8fff-000000000000",
  ]);
  assert.deepEqual(state.finalizedWorkKeys, [
    "work_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    "work_cccccccc-dddd-4eee-8fff-000000000000",
  ]);
  assert.deepEqual(state.finalizedPulls, [
    { repository: "HexaFox-Labs/Brai", pullNumber: 314 },
    { repository: "HexaFox-Labs/Brai", pullNumber: 315 },
  ]);
  assert.deepEqual(state.pendingNativeWorkKeys, ["work_bbbbbbbb-cccc-4ddd-8eee-ffffffffffff"]);
});

test("an APK-owned native work is fully finalized", () => {
  assert.deepEqual(
    classifyVersionWorkState({ works: [
      { workKey: "work_dddddddd-eeee-4fff-8aaa-bbbbbbbbbbbb", status: "finalized", hasBuild: true, nativeBoundary: true, hasApk: true },
    ] }),
    {
      latestBuildVersion: 0,
      finalizedBuildWorkKeys: ["work_dddddddd-eeee-4fff-8aaa-bbbbbbbbbbbb"],
      finalizedWorkKeys: ["work_dddddddd-eeee-4fff-8aaa-bbbbbbbbbbbb"],
      finalizedPulls: [],
      pendingNativeWorkKeys: [],
    },
  );
});
