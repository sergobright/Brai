import test from "node:test";
import assert from "node:assert/strict";

import {
  CODEX_BRANCH_RE,
  isSensitivePath,
  isWriteLikeCommand,
  parseHookInput,
  validatePushUpdate,
} from "./bright-task.mjs";

test("valid codex task branch names are strict", () => {
  assert.equal(CODEX_BRANCH_RE.test("codex/enforce-branch-preview-guards"), true);
  assert.equal(CODEX_BRANCH_RE.test("codex/Focus"), false);
  assert.equal(CODEX_BRANCH_RE.test("dev"), false);
  assert.equal(CODEX_BRANCH_RE.test("codex/"), false);
});

test("write-like shell commands are detected", () => {
  assert.equal(isWriteLikeCommand("git status --short"), false);
  assert.equal(isWriteLikeCommand("rg Preview docs"), false);
  assert.equal(isWriteLikeCommand("git commit -m guard"), true);
  assert.equal(isWriteLikeCommand("sed -i 's/a/b/' file"), true);
  assert.equal(isWriteLikeCommand("node -e \"fs.writeFileSync('x','y')\""), true);
});

test("sensitive paths are rejected for commits", () => {
  assert.equal(isSensitivePath("apps/bright_os_app/src/main.ts"), false);
  assert.equal(isSensitivePath("deploy/web/index.html"), true);
  assert.equal(isSensitivePath("data/bright_os.sqlite"), true);
  assert.equal(isSensitivePath(".env.local"), true);
  assert.equal(isSensitivePath("android/release.keystore"), true);
});

test("pre-push ref updates must stay on matching codex ref", () => {
  assert.doesNotThrow(() =>
    validatePushUpdate("refs/heads/codex/foo 1111111111111111111111111111111111111111 refs/heads/codex/foo 0000000000000000000000000000000000000000"),
  );
  assert.doesNotThrow(() =>
    validatePushUpdate("HEAD 1111111111111111111111111111111111111111 refs/heads/codex/foo 0000000000000000000000000000000000000000", "codex/foo"),
  );
  assert.doesNotThrow(() =>
    validatePushUpdate("(delete) 0000000000000000000000000000000000000000 refs/heads/codex/foo 1111111111111111111111111111111111111111"),
  );
  assert.throws(
    () =>
      validatePushUpdate("refs/heads/codex/foo 1111111111111111111111111111111111111111 refs/heads/dev 0000000000000000000000000000000000000000"),
    /Direct push/,
  );
  assert.throws(
    () =>
      validatePushUpdate("refs/heads/dev 1111111111111111111111111111111111111111 refs/heads/dev 0000000000000000000000000000000000000000"),
    /Direct push/,
  );
  assert.throws(
    () =>
      validatePushUpdate("refs/heads/codex/foo 1111111111111111111111111111111111111111 refs/heads/codex/bar 0000000000000000000000000000000000000000"),
    /ref mismatch/,
  );
});

test("hook input parser is tolerant", () => {
  assert.deepEqual(parseHookInput("{\"tool_name\":\"exec_command\"}"), { tool_name: "exec_command" });
  assert.deepEqual(parseHookInput("not-json"), {});
});
