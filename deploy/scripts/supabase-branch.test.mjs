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
  assert.match(contents, /^BRAI_TEST_AUTO_LOGIN='true'$/m);
});

test("dev env setup enables test auto-login", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brai-supabase-dev-env-"));
  const envFile = path.join(dir, "brai-api.env");
  const result = spawnSync("node", [
    path.join(repoRoot, "deploy/scripts/supabase-branch.mjs"),
    "dev-env",
    "--runtime-env",
    envFile
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      BRAI_SUPABASE_DRY_RUN: "true",
      SUPABASE_SELF_HOSTED: "true",
      SUPABASE_SELF_HOSTED_DATABASE_URL: "postgres://brai:brai@127.0.0.1:5432/brai"
    }
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const contents = fs.readFileSync(envFile, "utf8");
  assert.match(contents, /^BRAI_SUPABASE_BRANCH='brai_dev'$/m);
  assert.match(contents, /^BRAI_TEST_AUTO_LOGIN='true'$/m);
});

test("branch database URL override requires explicit preview marker", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brai-supabase-override-"));
  const envFile = path.join(dir, "brai-api.env");
  const baseEnv = {
    ...process.env,
    BRAI_SUPABASE_DRY_RUN: "true",
    BRAI_ENVS_ROOT: dir,
    BRAI_PREVIEW_REGISTRY: path.join(dir, "preview-slots.json"),
    BRAI_PREVIEW_LOCK: path.join(dir, "preview-slots.lock"),
    NODE_BIN: process.execPath,
    SUPABASE_PROJECT_REF: "dry-run-project",
    SUPABASE_BRANCH_DATABASE_URL: "postgres://brai:brai@127.0.0.1:5432/brai"
  };

  const denied = spawnSync("node", [
    path.join(repoRoot, "deploy/scripts/supabase-branch.mjs"),
    "preview-env",
    "--branch",
    "codex/supabase-only-runtime",
    "--runtime-env",
    envFile
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    env: baseEnv
  });
  assert.notEqual(denied.status, 0);
  assert.match(denied.stderr, /BRAI_ALLOW_SUPABASE_BRANCH_DATABASE_URL_OVERRIDE=true/);

  const wrongMarker = spawnSync("node", [
    path.join(repoRoot, "deploy/scripts/supabase-branch.mjs"),
    "preview-env",
    "--branch",
    "codex/supabase-only-runtime",
    "--runtime-env",
    envFile
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...baseEnv,
      BRAI_ALLOW_SUPABASE_BRANCH_DATABASE_URL_OVERRIDE: "true"
    }
  });
  assert.notEqual(wrongMarker.status, 0);
  assert.match(wrongMarker.stderr, /expected branch\/schema marker/);

  const allocation = spawnSync("bash", [
    path.join(repoRoot, "deploy/scripts/preview-slots.sh"),
    "allocate",
    "codex/supabase-only-runtime",
    "test-commit"
  ], { cwd: repoRoot, encoding: "utf8", env: baseEnv });
  assert.equal(allocation.status, 0, allocation.stderr || allocation.stdout);

  const allowed = spawnSync("node", [
    path.join(repoRoot, "deploy/scripts/supabase-branch.mjs"),
    "preview-env",
    "--branch",
    "codex/supabase-only-runtime",
    "--runtime-env",
    envFile
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...baseEnv,
      BRAI_ALLOW_SUPABASE_BRANCH_DATABASE_URL_OVERRIDE: "true",
      SUPABASE_BRANCH_DATABASE_URL: "postgres://brai:brai@127.0.0.1:5432/brai?options=-c%20search_path%3Dbrai-preview-supabase-only-runtime-e3117d5f"
    }
  });
  assert.equal(allowed.status, 0, allowed.stderr || allowed.stdout);
});
