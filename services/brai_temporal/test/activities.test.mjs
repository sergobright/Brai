import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cloneSourceForRemote, commandFailureMessage, exactMergedPull, runCommand } from "../src/activities.mjs";

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

test("activity cancellation terminates the full POSIX process group", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX process groups only");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "brai-activity-cancel-"));
  const pidFile = path.join(temp, "descendant.pid");
  let descendantPid;
  t.after(() => {
    if (descendantPid && isAlive(descendantPid)) process.kill(descendantPid, "SIGKILL");
    fs.rmSync(temp, { recursive: true, force: true });
  });

  const controller = new AbortController();
  const running = runCommand("bash", ["-c", `
trap '' TERM
sleep 60 &
printf '%s\n' "$!" >"$PID_FILE"
wait
`], {
    env: { ...process.env, PID_FILE: pidFile },
    signal: controller.signal,
    killGraceMs: 50
  });
  descendantPid = Number(await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8").trim()));
  assert.equal(isAlive(descendantPid), true);

  controller.abort(new Error("activity aborted"));
  await assert.rejects(running, /activity aborted/);
  assert.equal(isAlive(descendantPid), false);
});

test("activity command heartbeats immediately and until the process closes", async () => {
  let heartbeats = 0;
  await runCommand(process.execPath, ["-e", "setTimeout(() => {}, 60)"], {
    heartbeatFn: () => { heartbeats += 1; },
    heartbeatIntervalMs: 10
  });
  assert.ok(heartbeats >= 2);
  const completedHeartbeats = heartbeats;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(heartbeats, completedHeartbeats);
});

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function waitFor(read, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for process state");
}
