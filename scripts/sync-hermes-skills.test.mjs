import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EXCLUDED_SKILL_PATHS, normalizeRepoUrl, syncHermesSkills } from "./sync-hermes-skills.mjs";

test("normalizeRepoUrl converts GitHub SSH remotes to https", () => {
  assert.equal(
    normalizeRepoUrl("git@github.com:NousResearch/hermes-agent.git"),
    "https://github.com/NousResearch/hermes-agent"
  );
  assert.equal(
    normalizeRepoUrl("https://github.com/NousResearch/hermes-agent.git"),
    "https://github.com/NousResearch/hermes-agent"
  );
});

test("syncHermesSkills mirrors both Hermes skill trees and writes manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "sync-hermes-skills-test-"));
  const source = join(root, "source");
  const destination = join(root, "destination");
  const githubTokenExample = `ghp_${"x".repeat(20)}`;
  const llmKeyExample = `sk-${"x".repeat(20)}`;

  await mkdir(join(source, "skills", "github", "github-auth"), { recursive: true });
  await mkdir(join(source, "skills", "apple", "apple-notes"), { recursive: true });
  await mkdir(join(source, "optional-skills", "security", "1password"), { recursive: true });
  await mkdir(join(source, "skills", "github", "github-auth", "references"), { recursive: true });
  await writeFile(
    join(source, "skills", "github", "github-auth", "SKILL.md"),
    "---\nname: github-auth\ndescription: Auth.\n---\n",
    "utf8"
  );
  await writeFile(
    join(source, "skills", "apple", "apple-notes", "SKILL.md"),
    "---\nname: apple-notes\ndescription: Apple Notes.\n---\n",
    "utf8"
  );
  await writeFile(
    join(source, "skills", "github", "github-auth", "references", "native-mcp.md"),
    `token: "${githubTokenExample}"\nheader: "Bearer ${llmKeyExample}"\n`,
    "utf8"
  );
  await writeFile(
    join(source, "optional-skills", "security", "1password", "SKILL.md"),
    "---\nname: 1password\ndescription: Secrets.\n---\n",
    "utf8"
  );

  const manifest = await syncHermesSkills({
    source,
    destination,
    repo: "https://github.com/NousResearch/hermes-agent.git",
    syncedAtUtc: "2026-07-10T00:00:00.000Z"
  });

  assert.equal(manifest.trees.length, 2);
  assert.equal(manifest.trees[0].skill_count, 1);
  assert.equal(manifest.trees[1].skill_count, 1);
  assert.equal(manifest.trees[0].sanitized_replacement_count, 2);
  assert.deepEqual(manifest.excluded_skill_paths, ["skills/apple"]);
  assert.ok(EXCLUDED_SKILL_PATHS.includes("skills/apple"));

  const bundledSkill = await readFile(join(destination, "skills", "github", "github-auth", "SKILL.md"), "utf8");
  const bundledReference = await readFile(
    join(destination, "skills", "github", "github-auth", "references", "native-mcp.md"),
    "utf8"
  );
  const optionalSkill = await readFile(join(destination, "optional-skills", "security", "1password", "SKILL.md"), "utf8");
  const manifestText = await readFile(join(destination, "manifest.json"), "utf8");

  assert.match(bundledSkill, /github-auth/);
  assert.doesNotMatch(bundledReference, /ghp_[A-Za-z0-9_]{20,}/);
  assert.doesNotMatch(bundledReference, /sk-[A-Za-z0-9]{20,}/);
  assert.match(bundledReference, /<github-pat>/);
  assert.match(bundledReference, /<llm-api-key>/);
  assert.match(optionalSkill, /1password/);
  assert.match(manifestText, /"mirror": "hermes-agent-skills"/);
  assert.match(manifestText, /"destination_dir": ".+destination\/skills"/);
});
