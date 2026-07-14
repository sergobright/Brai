import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

test("Preview note is revision-bound and cleared by a new commit", () => {
  const root = path.resolve(import.meta.dirname, "../..");
  const envs = fs.mkdtempSync(path.join(os.tmpdir(), "brai-preview-note-"));
  const registry = path.join(envs, "preview-slots.json");
  const env = { ...process.env, BRAI_ROOT: root, BRAI_ENVS_ROOT: envs, BRAI_PREVIEW_REGISTRY: registry };
  const run = (...args) => spawnSync(process.execPath, [path.join(root, "deploy/scripts/preview-slots.mjs"), ...args], { cwd: root, env, encoding: "utf8" });
  const note = Buffer.from(JSON.stringify({
    short_changes: "Добавлена панель.",
    detailed_changes: "Контекстная панель доступна на основных страницах.",
    reason: "Нужно проверить новый способ навигации.",
    testing: "Открыть и закрыть панель, изменить ширину и перезагрузить страницу.",
  })).toString("base64");

  assert.equal(run("allocate", "codex/test-note", "commit-one").status, 0);
  assert.equal(run("ready", "codex/test-note", "commit-one").status, 0);
  assert.equal(run("note", "codex/test-note", "commit-one", note).status, 0);
  let saved = JSON.parse(fs.readFileSync(registry, "utf8"));
  assert.equal(saved.A.review_note.commit, "commit-one");
  assert.match(saved.A.review_note.testing, /изменить ширину/);

  assert.notEqual(run("note", "codex/test-note", "wrong-commit", note).status, 0);
  assert.equal(run("allocate", "codex/test-note", "commit-two").status, 0);
  saved = JSON.parse(fs.readFileSync(registry, "utf8"));
  assert.equal(saved.A.review_note, null);
});
