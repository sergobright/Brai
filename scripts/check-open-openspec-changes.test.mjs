import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { completedActiveOpenSpecChanges } from "./check-open-openspec-changes.mjs";

test("OpenSpec guard treats archive-only open task as completed active change", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openspec-guard-"));
  const changes = path.join(root, "openspec", "changes");
  fs.mkdirSync(path.join(changes, "ready"), { recursive: true });
  fs.writeFileSync(
    path.join(changes, "ready", "tasks.md"),
    "- [x] Implement the change.\n- [ ] Archive this OpenSpec change after review.\n",
  );

  assert.deepEqual(completedActiveOpenSpecChanges(changes), ["ready"]);
});

test("OpenSpec guard leaves active change alone when non-archive work remains", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openspec-guard-"));
  const changes = path.join(root, "openspec", "changes");
  fs.mkdirSync(path.join(changes, "active"), { recursive: true });
  fs.writeFileSync(
    path.join(changes, "active", "tasks.md"),
    "- [x] Draft spec.\n- [ ] Implement runtime behavior.\n",
  );

  assert.deepEqual(completedActiveOpenSpecChanges(changes), []);
});
