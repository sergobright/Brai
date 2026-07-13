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
