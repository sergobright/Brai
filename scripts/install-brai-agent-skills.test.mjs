import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { installSkills, SKILLS } from "./install-brai-agent-skills.mjs";

test("installs the curated Brai skill set with Codex paths", async () => {
  const destination = await mkdtemp(join(tmpdir(), "brai-skills-test-"));
  const installed = await installSkills(destination);

  assert.equal(installed.length, SKILLS.length);
  assert.match(await readFile(join(destination, "brai-debugging", "SKILL.md"), "utf8"), /name: brai-debugging/);
  assert.match(
    await readFile(join(destination, "fastmcp", "SKILL.md"), "utf8"),
    /CODEX_HOME:-\$HOME\/.codex/
  );
  assert.match(await readFile(join(destination, ".brai-installed.json"), "utf8"), /qdrant-vector-search/);
  assert.match(await readFile(join(destination, "grill-me", "SKILL.md"), "utf8"), /Invoke the `grilling` skill/);
  assert.match(await readFile(join(destination, "grilling", "SKILL.md"), "utf8"), /one at a time/);
});
