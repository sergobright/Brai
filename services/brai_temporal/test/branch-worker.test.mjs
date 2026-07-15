import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { workerTaskQueues } from "../src/worker-queues.mjs";

const repo = path.resolve(import.meta.dirname, "../../..");

test("branch worker polls only its exact SHA-qualified queue", () => {
  assert.deepEqual(workerTaskQueues({
    BRAI_TEMPORAL_WORKER_TASK_QUEUES: "brai-preview-branch-0123456789abcdef0123456789abcdef01234567"
  }), ["brai-preview-branch-0123456789abcdef0123456789abcdef01234567"]);
  assert.throws(() => workerTaskQueues({
    BRAI_TEMPORAL_WORKER_TASK_QUEUES: "brai-preview,brai-preview"
  }), /invalid_temporal_worker_task_queues/);
});

test("preview dispatch boots exact branch worker before invoking the client", () => {
  const script = fs.readFileSync(path.join(repo, "deploy/scripts/ci-temporal-signal.sh"), "utf8");
  const queue = script.indexOf('task_queue="brai-preview-branch-$sha"');
  const worker = script.indexOf('BRAI_TEMPORAL_WORKER_TASK_QUEUES="$task_queue"');
  const client = script.indexOf('BRAI_TEMPORAL_PREVIEW_TASK_QUEUE="$task_queue"');
  assert.ok(queue > 0 && queue < worker && worker < client);
  assert.match(script, /dispatch-preview-deploy requires an exact 40-character --sha/);
  assert.match(script, /CLEANUP_TEMPORAL_ADDRESS="127\.0\.0\.1:\$local_port"/);
  assert.match(script, /TEMPORAL_ADDRESS="\$CLEANUP_TEMPORAL_ADDRESS"[\s\S]*?cancel-preview-deploy/);
});

test("isolated workflow separates generic deploy and Goal-agent verification", () => {
  const source = fs.readFileSync(path.join(repo, "services/brai_temporal/src/workflows.mjs"), "utf8");
  const workflow = source.indexOf("export async function BranchPreviewDeployWorkflow");
  const deploy = source.indexOf("activities.deployBranch", workflow);
  const agentStarted = source.indexOf('"goal_agents_deploy_started"', deploy);
  const verify = source.indexOf("activities.verifyGoalAgentDeployment", agentStarted);
  const agentPassed = source.indexOf('"goal_agents_deploy_passed"', verify);
  const previewPassed = source.indexOf('"preview_deploy_passed"', agentPassed);
  assert.ok(workflow > 0 && workflow < deploy && deploy < agentStarted);
  assert.ok(agentStarted < verify && verify < agentPassed && agentPassed < previewPassed);
  const activities = fs.readFileSync(path.join(repo, "services/brai_temporal/src/activities.mjs"), "utf8");
  assert.match(activities, /deploy\/scripts\/ci-ssh-deploy-goal-agents\.sh/);
  assert.doesNotMatch(activities, /ci-ssh-goal-agent-gate\.sh/);
});

test("Temporal activities heartbeat and wait for cancellation completion", () => {
  const workflows = fs.readFileSync(path.join(repo, "services/brai_temporal/src/workflows.mjs"), "utf8");
  const worker = fs.readFileSync(path.join(repo, "services/brai_temporal/src/worker.mjs"), "utf8");
  assert.match(workflows, /heartbeatTimeout: "15 seconds"/);
  assert.match(workflows, /cancellationType: ActivityCancellationType\.WAIT_CANCELLATION_COMPLETED/);
  assert.match(worker, /maxHeartbeatThrottleInterval: "1 second"/);
  assert.match(worker, /shutdownForceTime: "8 seconds"/);
});

test("signal wrapper coalesces later signals while the tracked client finishes", async (t) => {
  const fixture = await signalFixture(t, `
import fs from "node:fs";
fs.appendFileSync(process.env.EVENTS_FILE, "client:" + String(process.pid) + "\\n");
process.on("SIGINT", () => {
  fs.appendFileSync(process.env.EVENTS_FILE, "signal:SIGINT\\n");
  setTimeout(() => {
    fs.appendFileSync(process.env.EVENTS_FILE, "client:done\\n");
    process.exit(130);
  }, 100);
});
process.on("SIGTERM", () => fs.appendFileSync(process.env.EVENTS_FILE, "signal:SIGTERM\\n"));
setInterval(() => {}, 1000);
`);
  const child = fixture.spawn(["dispatch-promotion", "--target", "prod", "--sha", "a".repeat(40)]);
  await waitFor(() => fs.existsSync(fixture.events) && fs.readFileSync(fixture.events, "utf8").includes("client:"));
  assert.equal(child.kill("SIGINT"), true);
  await waitFor(() => fs.readFileSync(fixture.events, "utf8").includes("signal:SIGINT"));
  assert.equal(child.kill("SIGTERM"), true);
  const [code, signal] = await onceWithTimeout(child, 3000, fixture.events);
  assert.equal(signal, null);
  assert.ok([130, 143].includes(code), String(code));
  const output = fs.readFileSync(fixture.events, "utf8");
  assert.match(output, /client:done/);
  assert.doesNotMatch(output, /signal:SIGTERM/);
  const clientPid = Number(output.match(/client:(\d+)/)?.[1]);
  await waitFor(() => !isAlive(clientPid));
});

test("failed exact preview waits for cancellation result before stopping its worker", async (t) => {
  const fixture = await signalFixture(t, `
import fs from "node:fs";
const command = process.argv[2];
if (command === "cancel-preview-deploy") {
  fs.appendFileSync(process.env.EVENTS_FILE, "cancel:start\\n");
  setTimeout(() => {
    fs.appendFileSync(process.env.EVENTS_FILE, "cancel:result\\n");
    process.exit(0);
  }, 80);
} else {
  fs.appendFileSync(process.env.EVENTS_FILE, "dispatch:failed\\n");
  process.exit(1);
}
`, `
import fs from "node:fs";
fs.appendFileSync(process.env.EVENTS_FILE, "worker:start\\n");
console.log("Brai Temporal worker connected");
process.on("SIGTERM", () => {
  fs.appendFileSync(process.env.EVENTS_FILE, "worker:stopped\\n");
  process.exit(0);
});
setInterval(() => {}, 1000);
`);
  const child = fixture.spawn([
    "dispatch-preview-deploy",
    "--branch", "codex/test",
    "--sha", "a".repeat(40)
  ]);
  const [code] = await onceWithTimeout(child, 5000, fixture.events);
  assert.equal(code, 1);
  const events = fs.readFileSync(fixture.events, "utf8").trim().split("\n");
  assert.ok(events.indexOf("cancel:result") < events.indexOf("worker:stopped"), events.join(", "));
});

test("exact preview waits for terminal cancellation before stopping a real detached descendant", async (t) => {
  const fixture = await signalFixture(t, `
import fs from "node:fs";
const command = process.argv[2];
if (command === "cancel-preview-deploy") {
  fs.appendFileSync(process.env.EVENTS_FILE, "cancel:" + String(process.pid) + "\\n");
  setTimeout(() => {
    fs.appendFileSync(process.env.EVENTS_FILE, "cancel:terminal\\n");
    process.exit(0);
  }, 150);
} else {
  fs.appendFileSync(process.env.EVENTS_FILE, "dispatch:" + String(process.pid) + "\\n");
  process.on("SIGINT", () => {
    fs.appendFileSync(process.env.EVENTS_FILE, "dispatch:SIGINT\\n");
    process.exit(130);
  });
  setInterval(() => {}, 1000);
}
`, `
import { spawn } from "node:child_process";
import fs from "node:fs";
const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  detached: true,
  stdio: "ignore"
});
descendant.unref();
fs.appendFileSync(process.env.EVENTS_FILE, "worker:" + String(process.pid) + "\\n");
fs.appendFileSync(process.env.EVENTS_FILE, "descendant:" + String(descendant.pid) + "\\n");
console.log("Brai Temporal worker connected");
process.once("SIGTERM", () => {
  fs.appendFileSync(process.env.EVENTS_FILE, "worker:TERM\\n");
  try {
    process.kill(-descendant.pid, "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
  const deadline = Date.now() + 1000;
  const waitForDescendant = () => {
    try {
      process.kill(descendant.pid, 0);
      if (Date.now() >= deadline) process.kill(-descendant.pid, "SIGKILL");
      setTimeout(waitForDescendant, 10);
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
      fs.appendFileSync(process.env.EVENTS_FILE, "worker:stopped\\n");
      process.exit(0);
    }
  };
  waitForDescendant();
});
setInterval(() => {}, 1000);
`);
  const child = fixture.spawn([
    "dispatch-preview-deploy",
    "--branch", "codex/test",
    "--sha", "a".repeat(40)
  ]);
  await waitFor(() => fs.existsSync(fixture.events) && fs.readFileSync(fixture.events, "utf8").includes("dispatch:"));
  assert.equal(child.kill("SIGINT"), true);
  await waitFor(() => fs.readFileSync(fixture.events, "utf8").includes("cancel:"));
  assert.equal(child.kill("SIGTERM"), true);
  const [code] = await onceWithTimeout(child, 5000, fixture.events);
  assert.ok([130, 143].includes(code), String(code));
  const output = fs.readFileSync(fixture.events, "utf8");
  const events = output.trim().split("\n");
  const clientPid = Number(output.match(/cancel:(\d+)/)?.[1]);
  const workerPid = Number(output.match(/worker:(\d+)/)?.[1]);
  const descendantPid = Number(output.match(/descendant:(\d+)/)?.[1]);
  const tunnelPid = Number(output.match(/tunnel:(\d+)/)?.[1]);
  t.after(() => {
    if (!isAlive(descendantPid)) return;
    try {
      process.kill(-descendantPid, "SIGKILL");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  });
  assert.ok(events.indexOf("cancel:terminal") < events.indexOf("worker:TERM"), events.join(", "));
  await waitFor(() => !isAlive(clientPid));
  await waitFor(() => !isAlive(workerPid));
  await waitFor(() => !isAlive(descendantPid));
  await waitFor(() => !isAlive(tunnelPid));
  assert.throws(
    () => process.kill(descendantPid, 0),
    (error) => error?.code === "ESRCH"
  );
});

test("exact preview cleanup reports cancellation failure without replacing the deploy exit", async (t) => {
  const fixture = await signalFixture(t, `
const command = process.argv[2];
if (command === "cancel-preview-deploy") {
  console.error("simulated terminal cancellation failure");
  process.exit(17);
}
process.exit(1);
`, `
console.log("Brai Temporal worker connected");
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`);
  const child = fixture.spawn([
    "dispatch-preview-deploy",
    "--branch", "codex/test",
    "--sha", "a".repeat(40)
  ]);
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const [code] = await onceWithTimeout(child, 5000, fixture.events);
  assert.equal(code, 1);
  assert.match(stderr, /simulated terminal cancellation failure/);
  assert.match(stderr, /BLOCKER: Temporal cancellation .* did not reach a terminal result/);
});

async function signalFixture(t, clientSource, workerSource = "setInterval(() => {}, 1000);\n") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "brai-temporal-signal-"));
  const scripts = path.join(root, "deploy/scripts");
  const service = path.join(root, "services/brai_temporal");
  const bin = path.join(root, "bin");
  const events = path.join(root, "events.log");
  fs.mkdirSync(scripts, { recursive: true });
  fs.mkdirSync(path.join(service, "src"), { recursive: true });
  fs.mkdirSync(path.join(service, "node_modules/@temporalio/client"), { recursive: true });
  fs.mkdirSync(bin);
  fs.copyFileSync(path.join(repo, "deploy/scripts/ci-temporal-signal.sh"), path.join(scripts, "ci-temporal-signal.sh"));
  fs.chmodSync(path.join(scripts, "ci-temporal-signal.sh"), 0o755);
  fs.writeFileSync(path.join(service, "src/client.mjs"), clientSource);
  fs.writeFileSync(path.join(service, "src/worker.mjs"), workerSource);
  fs.writeFileSync(path.join(bin, "ssh"), `#!/usr/bin/env bash
printf 'tunnel:%s\\n' "$$" >>"$EVENTS_FILE"
exec /usr/bin/node -e 'setInterval(() => {}, 1000)'
`);
  fs.chmodSync(path.join(bin, "ssh"), 0o755);
  const tunnelSockets = new Set();
  const tunnelServer = net.createServer((socket) => {
    tunnelSockets.add(socket);
    socket.on("close", () => tunnelSockets.delete(socket));
    socket.destroy();
  });
  tunnelServer.listen(0, "127.0.0.1");
  await once(tunnelServer, "listening");
  const { port } = tunnelServer.address();
  const children = new Set();
  t.after(() => {
    if (fs.existsSync(events)) {
      for (const match of fs.readFileSync(events, "utf8").matchAll(/descendant:(\d+)/g)) {
        try {
          process.kill(-Number(match[1]), "SIGKILL");
        } catch (error) {
          if (error?.code !== "ESRCH") throw error;
        }
      }
    }
    for (const child of children) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
    }
    for (const socket of tunnelSockets) socket.destroy();
    tunnelServer.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    events,
    spawn(args) {
      const child = spawn(path.join(scripts, "ci-temporal-signal.sh"), args, {
        cwd: root,
        detached: true,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          BRAI_DEPLOY_HOST: "example.invalid",
          BRAI_DEPLOY_USER: "test",
          BRAI_DEPLOY_SSH_KEY: "test-key",
          BRAI_TEMPORAL_LOCAL_PORT: String(port),
          BRAI_TEMPORAL_REQUIRED: "true",
          EVENTS_FILE: events
        },
        stdio: ["ignore", "pipe", "pipe"]
      });
      children.add(child);
      return child;
    }
  };
}

async function waitFor(read, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (read()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for signal wrapper state");
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function onceWithTimeout(child, timeoutMs, events) {
  let timer;
  try {
    return await Promise.race([
      once(child, "exit"),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`wrapper exit timed out; events=${fs.existsSync(events) ? fs.readFileSync(events, "utf8").trim() : "<none>"}`)), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}
