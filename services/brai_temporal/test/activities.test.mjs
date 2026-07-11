import test from "node:test";
import assert from "node:assert/strict";
import { cloneSourceForRemote } from "../src/activities.mjs";

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
