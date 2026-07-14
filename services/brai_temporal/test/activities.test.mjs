import test from "node:test";
import assert from "node:assert/strict";
import {
  acceptedBaseRefspecs,
  cloneSourceForRemote,
  commandFailureMessage,
  exactMergedPull
} from "../src/activities.mjs";

test("source checkout clones GitHub remote when auth env is available", () => {
  assert.equal(
    cloneSourceForRemote({
      url: "https://x-access-token@github.com/sergobright/Brai.git",
      env: { GIT_ASKPASS: "/tmp/askpass" }
    }),
    "https://x-access-token@github.com/sergobright/Brai.git"
  );
});

test("source checkout keeps local clone fallback without auth env", () => {
  assert.notEqual(cloneSourceForRemote({ url: "git@github.com:sergobright/Brai.git", env: {} }), "git@github.com:sergobright/Brai.git");
});

test("local source checkout carries the accepted base into the nested clone", () => {
  assert.deepEqual(acceptedBaseRefspecs("main"), [
    "+refs/remotes/origin/main:refs/remotes/origin/main",
    "+refs/heads/main:refs/remotes/origin/main"
  ]);
  assert.throws(() => acceptedBaseRefspecs("../main"), /Unsupported accepted base branch/);
});

test("activity failures retain both stderr and stdout tails", () => {
  const message = commandFailureMessage("deploy", 1, "build details", "ssh wrapper warning");
  assert.match(message, /stderr:\nssh wrapper warning/);
  assert.match(message, /stdout:\nbuild details/);
});

test("no-preview handoff recognizes only an exact merged PR head", () => {
  const pulls = [
    { number: 7, url: "https://example.test/7", headRefOid: "abc1234", mergedAt: "2026-07-11T00:00:00Z" },
    { number: 8, url: "https://example.test/8", headRefOid: "def5678", mergedAt: null }
  ];
  assert.equal(exactMergedPull(pulls, "abc1234")?.number, 7);
  assert.equal(exactMergedPull(pulls, "def5678"), null);
  assert.equal(exactMergedPull(pulls, "missing"), null);
});
