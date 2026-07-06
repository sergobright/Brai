import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "../..");

test("preview env setup rewrites existing shell-unsafe values safely", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brai-supabase-env-"));
  const envFile = path.join(dir, "brai-api.env");
  fs.writeFileSync(envFile, [
    "BRAI_AUTH_FROM=Brai <auth@mail.brightos.world>",
    "BRAI_DATA_STORE=sqlite",
    "BRAI_LEGACY_SQLITE_PATH=/srv/projects/brai/data/brai.sqlite",
    "BROKEN NON ASSIGNMENT",
    ""
  ].join("\n"));
  const env = {
    ...process.env,
    BRAI_SUPABASE_DRY_RUN: "true",
    BRAI_ENVS_ROOT: dir,
    BRAI_PREVIEW_REGISTRY: path.join(dir, "preview-slots.json"),
    BRAI_PREVIEW_LOCK: path.join(dir, "preview-slots.lock"),
    NODE_BIN: process.execPath,
    SUPABASE_SELF_HOSTED: "true",
    SUPABASE_SELF_HOSTED_DATABASE_URL: "postgres://brai:brai@127.0.0.1:5432/brai"
  };

  const allocation = spawnSync("bash", [
    path.join(repoRoot, "deploy/scripts/preview-slots.sh"),
    "allocate",
    "codex/supabase-only-runtime",
    "test-commit"
  ], { cwd: repoRoot, encoding: "utf8", env });
  assert.equal(allocation.status, 0, allocation.stderr || allocation.stdout);

  const result = spawnSync("node", [
    path.join(repoRoot, "deploy/scripts/supabase-branch.mjs"),
    "preview-env",
    "--branch",
    "codex/supabase-only-runtime",
    "--runtime-env",
    envFile
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    env
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const source = spawnSync("bash", ["-n", envFile], { encoding: "utf8" });
  assert.equal(source.status, 0, source.stderr || source.stdout);
  const contents = fs.readFileSync(envFile, "utf8");
  assert.match(contents, /^BRAI_AUTH_FROM='Brai <auth@mail\.brightos\.world>'$/m);
  assert.doesNotMatch(contents, /BRAI_DATA_STORE|BRAI_LEGACY_SQLITE_PATH|BROKEN NON ASSIGNMENT/);
  assert.match(contents, /^BRAI_DATABASE_URL='postgres:\/\/brai:brai@127\.0\.0\.1:5432\/brai\?options=-c\+search_path%3Dbrai_preview_supabase_only_runtime_e3117d5f%2Cpublic'$/m);
  assert.match(contents, /^BRAI_SUPABASE_BRANCH='brai_preview_supabase_only_runtime_e3117d5f'$/m);
});
