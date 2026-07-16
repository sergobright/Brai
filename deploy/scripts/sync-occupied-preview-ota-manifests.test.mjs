import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const script = path.join(import.meta.dirname, "sync-occupied-preview-ota-manifests.sh");

test("OTA sync resolves the published production version and skips failed preview slots", () => {
  const temp = mkdtempSync(path.join(tmpdir(), "brai-ota-sync-"));
  const envsRoot = path.join(temp, "envs");
  const registryPath = path.join(envsRoot, "preview-slots.json");
  const prodVersionPath = path.join(temp, "deploy", "web", "version.json");
  mkdirSync(envsRoot, { recursive: true });
  mkdirSync(path.dirname(prodVersionPath), { recursive: true });
  writeFileSync(prodVersionPath, JSON.stringify({ version: "0.0.151", otaVersion: "0.0.85" }));

  writeFileSync(registryPath, JSON.stringify({
    A: { status: "ready", branch: "codex/active-a", commit: "a".repeat(40) },
    B: { status: "deploying", branch: "codex/active-b", commit: "b".repeat(40) },
    C: { status: "free", branch: null },
    D: { status: "free", branch: null },
    E: { status: "failed", branch: "codex/failed-e" },
    queue: []
  }));

  for (const slot of ["a", "b"]) {
    const source = path.join(envsRoot, `preview-${slot}`, "source");
    const deployScripts = path.join(source, "deploy", "scripts");
    const web = path.join(envsRoot, `preview-${slot}`, "web");
    mkdirSync(deployScripts, { recursive: true });
    mkdirSync(web, { recursive: true });
    writeFileSync(path.join(source, ".brai-deploy-branch"), `codex/active-${slot}\n`);
    writeFileSync(path.join(source, ".brai-deploy-commit"), `${slot.repeat(40)}\n`);
    writeFileSync(
      path.join(web, "brai-runtime-config.js"),
      `window.__BRAI_RUNTIME_CONFIG__ = ${JSON.stringify({ productVersion: slot === "a" ? 147 : undefined })};\n`
    );
    writeFileSync(
      path.join(deployScripts, "publish-environment-web-layer.sh"),
      "#!/usr/bin/env bash\necho \"published $1 branch=$BRAI_BRANCH commit=$BRAI_COMMIT product=${BRAI_PRODUCT_VERSION:-unknown}\"\n",
      { mode: 0o755 }
    );
  }

  const result = spawnSync("bash", [script, "--local"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      BRAI_DEPLOY_REPO: path.join(temp, "deploy-repo"),
      BRAI_ENVS_ROOT: envsRoot,
      BRAI_PREVIEW_REGISTRY: registryPath,
      BRAI_PROD_DATABASE_URL: "postgres://example.invalid/brai",
      BRAI_PROD_WEB_VERSION_JSON: prodVersionPath,
      BRAI_PROD_SOURCE_ROOT: path.join(temp, "prod", "source"),
      BRAI_SKIP_DEPLOY_USER_REENTRY: "true"
    },
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Syncing Preview A OTA manifest to 0\.0\.85/);
  assert.match(result.stdout, /Syncing Preview B OTA manifest to 0\.0\.85/);
  assert.match(result.stdout, new RegExp(`published preview-a branch=codex/active-a commit=${"a".repeat(40)} product=147`));
  assert.match(result.stdout, new RegExp(`published preview-b branch=codex/active-b commit=${"b".repeat(40)} product=unknown`));
  assert.doesNotMatch(result.stdout, /Syncing Preview E OTA manifest/);
  assert.match(result.stderr, /Skipping failed Preview E OTA sync for codex\/failed-e/);
});
