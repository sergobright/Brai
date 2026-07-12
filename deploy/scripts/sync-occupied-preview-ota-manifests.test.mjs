import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const script = path.join(import.meta.dirname, "sync-occupied-preview-ota-manifests.sh");

test("OTA sync skips failed preview slots without requiring a static export", () => {
  const temp = mkdtempSync(path.join(tmpdir(), "brai-ota-sync-"));
  const envsRoot = path.join(temp, "envs");
  const registryPath = path.join(envsRoot, "preview-slots.json");
  mkdirSync(envsRoot, { recursive: true });

  writeFileSync(registryPath, JSON.stringify({
    A: { status: "ready", branch: "codex/active-a" },
    B: { status: "deploying", branch: "codex/active-b" },
    C: { status: "free", branch: null },
    D: { status: "free", branch: null },
    E: { status: "failed", branch: "codex/failed-e" },
    queue: []
  }));

  for (const slot of ["a", "b"]) {
    const source = path.join(envsRoot, `preview-${slot}`, "source");
    const deployScripts = path.join(source, "deploy", "scripts");
    mkdirSync(deployScripts, { recursive: true });
    writeFileSync(path.join(deployScripts, "publish-environment-web-layer.sh"), "#!/usr/bin/env bash\necho \"published $1\"\n", { mode: 0o755 });
  }

  const result = spawnSync("bash", [script, "--local"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      BRAI_APP_VERSION: "0.0.test",
      BRAI_DEPLOY_REPO: path.join(temp, "deploy-repo"),
      BRAI_ENVS_ROOT: envsRoot,
      BRAI_PREVIEW_REGISTRY: registryPath,
      BRAI_PROD_DATABASE_URL: "postgres://example.invalid/brai",
      BRAI_PROD_SOURCE_ROOT: path.join(temp, "prod", "source"),
      BRAI_SKIP_DEPLOY_USER_REENTRY: "true"
    },
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Syncing Preview A OTA manifest/);
  assert.match(result.stdout, /Syncing Preview B OTA manifest/);
  assert.doesNotMatch(result.stdout, /Syncing Preview E OTA manifest/);
  assert.match(result.stderr, /Skipping failed Preview E OTA sync for codex\/failed-e/);
});
