import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { invokeCodex } from "../src/llm.mjs";

test("Codex adapter pins strict schema mode and disables tools", async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "brai-goal-agent-cli-test-"));
  const fakeCodex = path.join(fixture, "fake-codex.mjs");
  const capturePath = path.join(fixture, "capture.json");
  fs.writeFileSync(fakeCodex, `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => prompt += chunk);
process.stdin.on("end", () => {
  fs.writeFileSync(value("--output-last-message"), JSON.stringify({ ok: true }));
  fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({ args, env: Object.keys(process.env), prompt }));
});
`, { mode: 0o700 });
  const previous = process.env.BRAI_DATABASE_URL;
  process.env.BRAI_DATABASE_URL = "postgres://must-not-cross";
  try {
    const output = await invokeCodex({
      prompt: "untrusted payload",
      outputSchema: {
        type: "object",
        required: ["ok"],
        additionalProperties: false,
        properties: { ok: { type: "boolean" } }
      },
      model: "test-model",
      timeoutMs: 5_000,
      codexBin: fakeCodex
    });
    assert.deepEqual(JSON.parse(output), { ok: true });
    const capture = JSON.parse(fs.readFileSync(capturePath, "utf8"));
    assert.equal(capture.prompt, "untrusted payload");
    assert.ok(capture.args.includes("--output-schema"));
    assert.ok(capture.args.includes("--ignore-user-config"));
    assert.ok(capture.args.includes("--ephemeral"));
    assert.ok(capture.args.includes("--skip-git-repo-check"));
    assert.ok(capture.args.includes("features.apps=false"));
    assert.ok(capture.args.includes("features.shell_tool=false"));
    assert.ok(capture.args.includes("features.multi_agent=false"));
    assert.ok(capture.args.includes('web_search="disabled"'));
    assert.equal(capture.args[capture.args.indexOf("--sandbox") + 1], "read-only");
    assert.equal(capture.args[capture.args.indexOf("--ask-for-approval") + 1], "never");
    assert.ok(!capture.env.includes("BRAI_DATABASE_URL"));
  } finally {
    if (previous === undefined) delete process.env.BRAI_DATABASE_URL;
    else process.env.BRAI_DATABASE_URL = previous;
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
