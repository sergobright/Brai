import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const nodeCliEnv = { ...process.env, NODE_OPTIONS: "" };

describe("mobile OTA publish scripts", () => {
  it("publishes browser web and Android OTA from one web-layer command", async () => {
    const root = await fixtureRoot("brai-client-web-layer-");
    await writeStaticExport(root, "unified");
    const previousVersion = "9.9.8";
    const previousBundle = path.join(root, "deploy/mobile-update/bundles", previousVersion);
    await mkdir(previousBundle, { recursive: true });
    await writeFile(path.join(previousBundle, "bundle.zip"), "previous");
    await mkdir(path.join(root, "deploy/mobile-update"), { recursive: true });
    await writeFile(
      path.join(root, "deploy/mobile-update/manifest.json"),
      JSON.stringify({ otaVersion: previousVersion }),
    );

    await execFileAsync("bash", [path.join(workspaceRoot, "deploy/scripts/publish-client-web-layer.sh")], {
      env: {
        ...process.env,
        BRAI_ROOT: root,
        BRAI_BUILD_CLIENT: "false",
        BRAI_APP_VERSION: "9.9.9",
        BRAI_TARGET_APK_VERSION: "2999",
        BRAI_PUBLISHED_AT: "2026-06-15T00:00:00Z",
      },
    });

    const bundleVersion = "9.9.9";
    const manifest = JSON.parse(
      await readFile(path.join(root, "deploy/mobile-update/manifest.json"), "utf8"),
    );

    await expect(readFile(path.join(root, "deploy/web/index.html"), "utf8")).resolves.toContain(
      "unified",
    );
    await expect(
      readFile(path.join(root, "deploy/mobile-update/bundles", bundleVersion, "bundle.zip")),
    ).resolves.toBeInstanceOf(Buffer);
    const webVersion = JSON.parse(await readFile(path.join(root, "deploy/web/version.json"), "utf8"));
    expect(webVersion).toMatchObject({
      version: "9.9.9",
      versionParts: { major: 9, release: 9, build: 9 },
    });
    expect(manifest.otaVersion).toBe(bundleVersion);
    expect(manifest.targetApkVersion).toBe(2999);
  });

  it("publishes browser web and Android OTA into environment-specific roots", async () => {
    const root = await fixtureRoot("brai-env-publish-");
    await writeStaticExport(root, "env");
    await mkdir(path.join(root, "deploy"), { recursive: true });
    await copyFile(
      path.join(workspaceRoot, "deploy/environments.json"),
      path.join(root, "deploy/environments.json"),
    );
    const envRoot = path.join(root, "envs/preview-a");

    await execFileAsync("bash", [path.join(workspaceRoot, "deploy/scripts/publish-client-web-layer.sh")], {
      env: {
        ...process.env,
        BRAI_ROOT: root,
        BRAI_BUILD_CLIENT: "false",
        BRAI_APP_VERSION: "9.9.9",
        BRAI_WEB_TARGET: path.join(envRoot, "web"),
        BRAI_MOBILE_TARGET: path.join(envRoot, "mobile-update"),
        BRAI_UPDATE_BASE_URL: "https://a.test.brightos.world/mobile-update",
        BRAI_MOBILE_BUNDLE_VERSION: "9.9.9-preview.42",
        BRAI_ENVIRONMENT: "preview-a",
        BRAI_TARGET_APK_VERSION: "2999",
        BRAI_PUBLISHED_AT: "2026-06-15T00:00:00Z",
      },
    });

    const manifest = JSON.parse(await readFile(path.join(envRoot, "mobile-update/manifest.json"), "utf8"));
    await expect(readFile(path.join(envRoot, "web/index.html"), "utf8")).resolves.toContain("env");
    expect(manifest.otaVersion).toBe("9.9.9");
    expect(manifest.targetApkVersion).toBe(2999);
    expect(manifest.archiveUrl).toBe("https://a.test.brightos.world/mobile-update/bundles/9.9.9-preview.42/bundle.zip");
  });

  it("publishes a baseline web layer for a selected non-production environment", async () => {
    const root = await fixtureRoot("brai-env-baseline-");
    await writeStaticExport(root, "baseline");
    await mkdir(path.join(root, "deploy"), { recursive: true });
    await copyFile(
      path.join(workspaceRoot, "deploy/environments.json"),
      path.join(root, "deploy/environments.json"),
    );

    await execFileAsync("bash", [path.join(workspaceRoot, "deploy/scripts/publish-environment-web-layer.sh"), "preview-b"], {
      env: {
        ...process.env,
        BRAI_ROOT: root,
        BRAI_BUILD_CLIENT: "false",
        BRAI_ENVS_ROOT: path.join(root, "envs"),
        BRAI_APP_VERSION: "9.9.9",
        BRAI_TARGET_APK_VERSION: "2999",
        BRAI_PUBLISHED_AT: "2026-06-15T00:00:00Z",
      },
    });

    const target = path.join(root, "envs/preview-b");
    const manifest = JSON.parse(await readFile(path.join(target, "mobile-update/manifest.json"), "utf8"));
    await expect(readFile(path.join(target, "web/index.html"), "utf8")).resolves.toContain("baseline");
    expect(manifest.otaVersion).toBe("9.9.9");
    expect(manifest.targetApkVersion).toBe(2999);
    expect(manifest.archiveUrl).toBe("https://b.test.brightos.world/mobile-update/bundles/9.9.9/bundle.zip");
  });

  it("does not force a new Preview APK for web-only OTA bundles", async () => {
    const root = await fixtureRoot("brai-web-only-apk-");
    await writeStaticExport(root, "web-only-apk");
    await mkdir(path.join(root, "deploy"), { recursive: true });
    await copyFile(
      path.join(workspaceRoot, "deploy/environments.json"),
      path.join(root, "deploy/environments.json"),
    );
    const releaseDir = path.join(root, "releases");
    await mkdir(releaseDir, { recursive: true });
    await writeFile(
      path.join(releaseDir, "releases.json"),
      JSON.stringify({ schemaVersion: 2, sections: { a: { apkVersion: 20, versionCode: 20 } } }),
    );
    const envRoot = path.join(root, "envs/preview-a");

    await execFileAsync("bash", [path.join(workspaceRoot, "deploy/scripts/publish-client-web-layer.sh")], {
      env: {
        ...process.env,
        BRAI_ROOT: root,
        BRAI_BUILD_CLIENT: "false",
        BRAI_APP_VERSION: "9.9.9",
        BRAI_WEB_TARGET: path.join(envRoot, "web"),
        BRAI_MOBILE_TARGET: path.join(envRoot, "mobile-update"),
        BRAI_UPDATE_BASE_URL: "https://a.test.brightos.world/mobile-update",
        BRAI_MOBILE_BUNDLE_VERSION: "9.9.9-preview.42",
        BRAI_RELEASE_TARGET: releaseDir,
        BRAI_ENVIRONMENT: "preview-a",
        BRAI_PUBLISHED_AT: "2026-06-15T00:00:00Z",
      },
    });

    const manifest = JSON.parse(await readFile(path.join(envRoot, "mobile-update/manifest.json"), "utf8"));
    expect(manifest.targetApkVersion).toBe(20);
  });

  it("resolves native non-production OTA APK compatibility from the release index", async () => {
    const root = await fixtureRoot("brai-required-apk-");
    await writeStaticExport(root, "required-apk");
    await mkdir(path.join(root, "deploy"), { recursive: true });
    await copyFile(
      path.join(workspaceRoot, "deploy/environments.json"),
      path.join(root, "deploy/environments.json"),
    );
    const releaseDir = path.join(root, "releases");
    await mkdir(releaseDir, { recursive: true });
    await writeFile(
      path.join(releaseDir, "releases.json"),
      JSON.stringify({ schemaVersion: 2, sections: { production: { apkVersion: 7 }, a: { apkVersion: 8 } } }),
    );
    const envRoot = path.join(root, "envs/preview-a");

    await execFileAsync("bash", [path.join(workspaceRoot, "deploy/scripts/publish-client-web-layer.sh")], {
      env: {
        ...process.env,
        BRAI_ROOT: root,
        BRAI_BUILD_CLIENT: "false",
        BRAI_APP_VERSION: "9.9.9",
        BRAI_WEB_TARGET: path.join(envRoot, "web"),
        BRAI_MOBILE_TARGET: path.join(envRoot, "mobile-update"),
        BRAI_UPDATE_BASE_URL: "https://a.test.brightos.world/mobile-update",
        BRAI_MOBILE_BUNDLE_VERSION: "9.9.9-preview.42",
        BRAI_RELEASE_TARGET: releaseDir,
        BRAI_ENVIRONMENT: "preview-a",
        BRAI_NATIVE_APK_CHANGE: "true",
        BRAI_PUBLISHED_AT: "2026-06-15T00:00:00Z",
      },
    });

    const manifest = JSON.parse(await readFile(path.join(envRoot, "mobile-update/manifest.json"), "utf8"));
    expect(manifest.targetApkVersion).toBe(8);
  });

  it("keeps production app public and protects only preview web shells in Caddy", async () => {
    const template = await readFile(path.join(workspaceRoot, "deploy/ansible/templates/Caddyfile.j2"), "utf8");
    const nonProductionStart = template.indexOf("{% for name, env in brai_envs.items() if name != 'prod' %}");
    expect(nonProductionStart).toBeGreaterThanOrEqual(0);
    const productionTemplate = template.slice(template.indexOf("{{ brai_envs.prod.domain }} {"), nonProductionStart);
    const nonProductionTemplate = template.slice(nonProductionStart);
    const productionApiBlock = productionTemplate.slice(
      productionTemplate.indexOf("handle_path /api/*"),
      productionTemplate.indexOf("handle /releases*"),
    );
    const productionShellBlock = productionTemplate.slice(
      productionTemplate.indexOf("handle {"),
      productionTemplate.indexOf("try_files"),
    );
    const apiBlock = nonProductionTemplate.slice(
      nonProductionTemplate.indexOf("handle_path /api/*"),
      nonProductionTemplate.indexOf("handle /releases*"),
    );
    const mobileIndex = nonProductionTemplate.indexOf("handle_path /mobile-update/*");
    const mobileBlock = nonProductionTemplate.slice(mobileIndex, nonProductionTemplate.indexOf("handle {"));
    const webShellBlock = nonProductionTemplate.slice(
      nonProductionTemplate.indexOf("handle {"),
      nonProductionTemplate.indexOf("try_files"),
    );

    expect(productionTemplate).toContain("{{ brai_envs.prod.domain }}");
    expect(productionApiBlock).not.toContain("brai_basic_auth_directive");
    expect(productionApiBlock).not.toContain("header_up Authorization");
    expect(productionShellBlock).not.toContain("brai_basic_auth_directive");
    expect(nonProductionTemplate).not.toMatch(/\{\{ env\.domain \}\} \{\n\s+\{\{ brai_basic_auth_directive \}\}/);
    expect(apiBlock).not.toContain("brai_basic_auth_directive");
    expect(apiBlock).not.toContain("header_up Authorization");
    expect(mobileIndex).toBeGreaterThan(nonProductionTemplate.indexOf("handle /releases*"));
    expect(mobileIndex).toBeLessThan(nonProductionTemplate.indexOf("handle {"));
    expect(mobileBlock).toContain('header /manifest.json Cache-Control "no-store"');
    expect(webShellBlock).toContain("brai_basic_auth_directive");
  });

  it("uses the public API endpoint for production Android bundles", async () => {
    const deployBranch = await readFile(path.join(workspaceRoot, "deploy/scripts/deploy-branch.sh"), "utf8");
    const buildApk = await readFile(path.join(workspaceRoot, "deploy/scripts/build-android-env-apk.sh"), "utf8");

    expect(deployBranch).toContain('ANDROID_API="https://api.brightos.world"');
    expect(deployBranch).toContain('export NEXT_PUBLIC_BRAI_ANDROID_API="$ANDROID_API"');
    expect(buildApk).toContain('ANDROID_API="https://api.brightos.world"');
    expect(buildApk).toContain('export NEXT_PUBLIC_BRAI_ANDROID_API="$ANDROID_API"');
    expect(buildApk).toContain('export JAVA_HOME="/srv/opt/jdk-21"');
    expect(buildApk).toContain('SIGNING_ENV="${BRAI_ANDROID_SIGNING_ENV:-/srv/projects/brai-envs/android-signing/signing.env}"');
    expect(buildApk).toContain('/srv/opt/android-build-env/build-android.sh "$ROOT/apps/brai_app/android" "$GRADLE_TASK"');
  });

  it("resolves OTA app versions from the build ledger before deployed files", async () => {
    const root = await fixtureRoot("brai-apk-version-resolve-");
    await writeStaticExport(root, "stale-public-version");
    const dbPath = path.join(root, "brai.sqlite");
    await execFileAsync("node", ["--input-type=module", "-e", `
const { pathToFileURL } = await import("node:url");
const { BraiStore } = await import(pathToFileURL(process.argv[1]));
const store = new BraiStore(process.argv[2]);
try {
  store.upsertBuildVersion({
    versionTypeId: "apk",
    version: 1,
    includedInVersionId: null,
    shortChanges: "Production APK-сборка",
    detailedChanges: "Production APK-сборка",
    reason: "Нужно для теста",
    releasedAtUtc: "2026-06-28T17:29:00.000Z",
  });
} finally {
  store.close();
}
`, path.join(workspaceRoot, "services/brai_api/src/store.js"), dbPath], { env: nodeCliEnv });

    await mkdir(path.join(root, "deploy/web"), { recursive: true });
    await writeFile(path.join(root, "deploy/web/version.json"), JSON.stringify({ version: "0.0.38" }));
    const mobileTarget = path.join(root, "envs/preview-a/mobile-update");
    await mkdir(path.join(mobileTarget, "bundles/0.11.52.20260629202736"), { recursive: true });
    await writeFile(
      path.join(mobileTarget, "bundles/0.11.52.20260629202736/metadata.json"),
      JSON.stringify({ otaVersion: "0.11.52" }),
    );
    const resolver = path.join(workspaceRoot, "deploy/scripts/resolve-app-version.mjs");
    const outputPath = path.join(root, "resolved-versions.json");
    await execFileAsync("node", ["--input-type=module", "-e", `
const fs = await import("node:fs/promises");
const { pathToFileURL } = await import("node:url");
const [, resolver, root, db, prodWebVersionJson, mobileTarget, outputPath] = process.argv.slice(1);
const { resolveAppVersion } = await import(pathToFileURL(resolver));
await fs.writeFile(outputPath, JSON.stringify({
  production: resolveAppVersion({ environment: "prod", root, db, explicit: "" }),
  nextProductionApk: resolveAppVersion({ kind: "apk", environment: "prod", root, db, explicit: "", nextApk: true, targetBranch: "main", targetCommit: "abc" }),
  preview: resolveAppVersion({ environment: "preview-a", root, prodDb: db, prodWebVersionJson, mobileTarget, explicit: "" }),
}));
`, "import-helper", resolver, root, dbPath, path.join(root, "deploy/web/version.json"), mobileTarget, outputPath], { env: nodeCliEnv });
    const versions = JSON.parse(await readFile(outputPath, "utf8"));
    const deployBranch = await readFile(path.join(workspaceRoot, "deploy/scripts/deploy-branch.sh"), "utf8");
    const ciDeploy = await readFile(path.join(workspaceRoot, "deploy/scripts/ci-ssh-deploy.sh"), "utf8");

    expect(versions.production).toBe("0.0.1");
    expect(versions.nextProductionApk).toBe("2");
    expect(versions.preview).toBe("0.0.1");
    expect(deployBranch).toContain('--prod-db "${BRAI_PROD_DB:-}"');
    expect(deployBranch).toContain('--mobile-target "$MOBILE_TARGET"');
    expect(deployBranch).toContain('BRAI_RECORD_PROD_BRANCH_DEPLOYMENT');
    const buildApk = await readFile(path.join(workspaceRoot, "deploy/scripts/build-android-env-apk.sh"), "utf8");
    expect(buildApk).toContain('MOBILE_TARGET="${BRAI_MOBILE_TARGET:-}"');
    expect(buildApk).toContain('if [[ -z "$MOBILE_TARGET" && -n "$ENV_PATH" ]]; then');
    expect(buildApk).toContain('--mobile-target "$MOBILE_TARGET"');
    expect(ciDeploy).toContain('export BRAI_PROD_DB="$DEPLOY_REPO/data/brai.sqlite"');
  });

  it("records shipped APK ledger rows idempotently by target commit", async () => {
    const root = await fixtureRoot("brai-apk-ledger-");
    await writeStaticExport(root, "stale-public-version");
    const dbPath = path.join(root, "brai.sqlite");
    await execFileAsync("node", ["--input-type=module", "-e", `
const { pathToFileURL } = await import("node:url");
const { BraiStore } = await import(pathToFileURL(process.argv[1]));
const store = new BraiStore(process.argv[2]);
try {
  store.upsertBuildVersion({
    versionTypeId: "apk",
    version: 1,
    includedInVersionId: null,
    shortChanges: "Production APK",
    detailedChanges: "Production APK",
    reason: "Needed for test",
    releasedAtUtc: "2026-06-28T17:29:00.000Z",
  });
} finally {
  store.close();
}
`, path.join(workspaceRoot, "services/brai_api/src/store.js"), dbPath], { env: nodeCliEnv });

    const recordScript = path.join(workspaceRoot, "deploy/scripts/record-shipped-apk-version.mjs");
    const recordArgs = [
      recordScript,
      "--db", dbPath,
      "--version", "2",
      "--version-code", "3000",
      "--target-branch", "main",
      "--target-commit", "abc",
      "--released-at", "2026-06-28T17:30:00.000Z",
    ];
    await execFileAsync("node", recordArgs, { env: nodeCliEnv });
    await execFileAsync("node", recordArgs, { env: nodeCliEnv });

    const resolver = path.join(workspaceRoot, "deploy/scripts/resolve-app-version.mjs");
    const outputPath = path.join(root, "apk-ledger.json");
    await execFileAsync("node", ["--input-type=module", "-e", `
const fs = await import("node:fs/promises");
const { pathToFileURL } = await import("node:url");
const [, storeModule, resolver, db, outputPath] = process.argv.slice(1);
const { BraiStore } = await import(pathToFileURL(storeModule));
const { resolveAppVersion } = await import(pathToFileURL(resolver));
const store = new BraiStore(db);
try {
  await fs.writeFile(outputPath, JSON.stringify({
    apkRows: store.db.prepare("SELECT version FROM build_versions WHERE version_type_id = 'apk' ORDER BY version").all(),
    sameCommit: resolveAppVersion({ kind: "apk", environment: "prod", db, explicit: "", nextApk: true, targetBranch: "main", targetCommit: "abc" }),
    nextCommit: resolveAppVersion({ kind: "apk", environment: "prod", db, explicit: "", nextApk: true, targetBranch: "main", targetCommit: "def" }),
  }));
} finally {
  store.close();
}
`, "import-helper", path.join(workspaceRoot, "services/brai_api/src/store.js"), resolver, dbPath, outputPath], { env: nodeCliEnv });
    const ledger = JSON.parse(await readFile(outputPath, "utf8"));

    expect(ledger.apkRows).toEqual([{ version: 1 }, { version: 2 }]);
    expect(ledger.sameCommit).toBe("2");
    expect(ledger.nextCommit).toBe("3");
  });

  it("promotes production deployment metadata into the production database path", async () => {
    const script = await readFile(path.join(workspaceRoot, "deploy/scripts/ci-ssh-promote-deployment.sh"), "utf8");
    expect(script).toContain('export BRAI_DB="$DEPLOY_REPO/data/brai.sqlite"');
  });

  it("restores stale preview source permissions before deploy cleanup", async () => {
    const script = await readFile(path.join(workspaceRoot, "deploy/scripts/ci-ssh-deploy.sh"), "utf8");

    expect(script).toContain('find "$SOURCE_ROOT" -user "$(id -u)" -exec chmod u+rwX,g+rwX {} + || true');
    expect(script).toContain('rm -rf "$SOURCE_ROOT" || { sleep 2; rm -rf "$SOURCE_ROOT"; }');
    expect(script.indexOf('find "$SOURCE_ROOT" -user "$(id -u)"')).toBeLessThan(script.indexOf('rm -rf "$SOURCE_ROOT"'));
  });

  it("keeps preview runtime SQLite writable by the deploy group", async () => {
    const deploy = await readFile(path.join(workspaceRoot, "deploy/scripts/deploy-branch.sh"), "utf8");
    const playbook = await readFile(path.join(workspaceRoot, "deploy/ansible/brai.yml"), "utf8");
    const service = await readFile(path.join(workspaceRoot, "deploy/ansible/templates/brai-api.service.j2"), "utf8");
    const resetBlock = deploy.slice(deploy.indexOf('if [[ "$ENVIRONMENT" == preview-*'));

    expect(service).toContain('Group={{ brai_deploy_user }}');
    expect(service).toContain('UMask=0002');
    expect(playbook).toContain("Ensure non-production data directories keep deploy setgid");
    expect(playbook).toContain('group: "{{ brai_deploy_user }}"');
    expect(playbook).toContain('mode: "2775"');
    expect(resetBlock).toContain("Preview SQLite reset failed");
    expect(resetBlock).toContain("brai-deploy:brai-deploy 2775");
    expect(resetBlock).toContain("find \"$TARGET_ROOT/data\" -type d -exec chmod 2775 {} +");
    expect(resetBlock.indexOf("Preview SQLite reset failed")).toBeLessThan(deploy.indexOf("record-deployment.mjs"));
  });

  it("rebuilds APK release rows without recording ledger rows by default", async () => {
    const deploy = await readFile(path.join(workspaceRoot, "deploy/scripts/ci-ssh-deploy.sh"), "utf8");
    const buildApk = await readFile(path.join(workspaceRoot, "deploy/scripts/build-android-env-apk.sh"), "utf8");
    const buildNonproduction = await readFile(path.join(workspaceRoot, "deploy/scripts/build-nonproduction-apks.sh"), "utf8");
    const releaseSlot = await readFile(path.join(workspaceRoot, "deploy/scripts/ci-ssh-release-slot.sh"), "utf8");
    const prodBlock = deploy.slice(deploy.indexOf('elif [[ "$ENVIRONMENT" == "prod" ]]'));

    expect(prodBlock).toContain('deploy/scripts/build-android-env-apk.sh production');
    expect(prodBlock).toContain('node deploy/scripts/resolve-app-version.mjs --environment prod --root "$SOURCE_ROOT" --db "${BRAI_DB:-}"');
    expect(prodBlock).toContain('deploy/scripts/build-nonproduction-apks.sh');
    expect(prodBlock.indexOf('deploy/scripts/build-android-env-apk.sh production')).toBeLessThan(prodBlock.indexOf('deploy/scripts/build-nonproduction-apks.sh'));
    expect(buildApk).toContain('"${BRAI_RECORD_APK_LEDGER:-false}" == "true"');
    expect(buildApk).toContain('--next-apk true --target-branch "$BRAI_BRANCH" --target-commit "$BRAI_COMMIT"');
    expect(buildApk).toContain('record-shipped-apk-version.mjs');
    expect(buildNonproduction).toContain('for flavor in dev previewA previewB previewC previewD previewE; do');
    expect(releaseSlot).toContain('deploy/scripts/build-android-env-apk.sh "preview${SLOT_META[0]}" >&2');
  });

  it("publishes a versioned bundle and atomic manifest from a static export", async () => {
    const root = await fixtureRoot("brai-mobile-publish-");
    await writeStaticExport(root, "ota");

    await execFileAsync("bash", [path.join(workspaceRoot, "deploy/scripts/publish-mobile-bundle.sh")], {
      env: {
        ...process.env,
        BRAI_ROOT: root,
        BRAI_TARGET_APK_VERSION: "2999",
        BRAI_PUBLISHED_AT: "2026-06-15T00:00:00Z",
      },
    });

    const bundleVersion = "9.9.9";
    const archivePath = path.join(root, "deploy/mobile-update/bundles", bundleVersion, "bundle.zip");
    const manifestPath = path.join(root, "deploy/mobile-update/manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const archive = await readFile(archivePath);

    expect(manifest).toMatchObject({
      schemaVersion: 2,
      otaVersion: bundleVersion,
      archiveUrl: `https://app.brightos.world/mobile-update/bundles/${bundleVersion}/bundle.zip`,
      entrypoint: "index.html",
      targetApkVersion: 2999,
      mandatory: false,
    });
    expect(manifest.sizeBytes).toBe((await stat(archivePath)).size);
    expect(manifest.sha256).toBe(createHash("sha256").update(archive).digest("hex"));
  });

  it("publishes an APK using app version metadata when env version is unset", async () => {
    const root = await fixtureRoot("brai-apk-publish-");
    await writeStaticExport(root, "apk");
    await mkdir(path.join(root, "deploy"), { recursive: true });
    await copyFile(
      path.join(workspaceRoot, "deploy/environments.json"),
      path.join(root, "deploy/environments.json"),
    );
    const apkPath = path.join(root, "app-release.apk");
    await writeFile(apkPath, "apk");

    await execFileAsync("bash", [path.join(workspaceRoot, "deploy/scripts/publish-capacitor-apk.sh")], {
      env: {
        ...process.env,
        BRAI_ROOT: root,
        BRAI_APK_SOURCE: apkPath,
        BRAI_ANDROID_VERSION_CODE: "2999",
        BRAI_PUBLISHED_AT: "2026-06-15T00:00:00Z",
      },
    });

    await expect(readFile(path.join(root, "deploy/releases/brai-v1.apk"), "utf8")).resolves.toBe("apk");
  });

  it("publishes a Dev APK card without restoring a Dev server path", async () => {
    const root = await fixtureRoot("bright-dev-apk-publish-");
    await writeStaticExport(root, "dev-apk");
    await mkdir(path.join(root, "deploy"), { recursive: true });
    await copyFile(
      path.join(workspaceRoot, "deploy/environments.json"),
      path.join(root, "deploy/environments.json"),
    );
    const devApk = path.join(root, "apps/brai_app/android/app/build/outputs/apk/dev/release/app-dev-release.apk");
    await mkdir(path.dirname(devApk), { recursive: true });
    await writeFile(devApk, "dev-apk");

    await execFileAsync("bash", [path.join(workspaceRoot, "deploy/scripts/publish-capacitor-apk.sh")], {
      env: {
        ...process.env,
        BRAI_ROOT: root,
        BRAI_RELEASE_ENV: "dev",
        BRAI_ANDROID_VERSION_CODE: "3001",
        BRAI_PUBLISHED_AT: "2026-06-15T00:00:00Z",
      },
    });
    const index = JSON.parse(await readFile(path.join(root, "deploy/releases/releases.json"), "utf8"));
    const buildApk = await readFile(path.join(workspaceRoot, "deploy/scripts/build-android-env-apk.sh"), "utf8");
    expect(index.sections.dev).toMatchObject({
      title: "Brai Dev",
      androidApp: "Brai Dev",
      applicationId: "world.brightos.brai.dev",
      file: "brai-dev-v1.apk",
      apkVersion: 1,
      versionCode: 3001,
    });
    await expect(readFile(path.join(root, "deploy/releases/brai-dev-v1.apk"), "utf8")).resolves.toBe("dev-apk");
    expect(buildApk).toContain('if [[ -z "$MOBILE_TARGET" && -n "$ENV_PATH" ]]; then');
    expect(buildApk).not.toContain("/dev/mobile-update");
  });

  it("replaces an existing APK instead of rewriting it in place", async () => {
    const root = await fixtureRoot("brai-apk-replace-");
    await writeStaticExport(root, "apk-replace");
    await mkdir(path.join(root, "deploy"), { recursive: true });
    await copyFile(
      path.join(workspaceRoot, "deploy/environments.json"),
      path.join(root, "deploy/environments.json"),
    );
    const apkPath = path.join(root, "app-release.apk");
    await writeFile(apkPath, "new-apk");
    const releaseDir = path.join(root, "deploy/releases");
    const releasePath = path.join(releaseDir, "brai-a-v1.apk");
    await mkdir(releaseDir, { recursive: true });
    await writeFile(releasePath, "old-apk");
    await chmod(releasePath, 0o444);
    const previousInode = (await stat(releasePath)).ino;

    try {
      await execFileAsync("bash", [path.join(workspaceRoot, "deploy/scripts/publish-capacitor-apk.sh")], {
        env: {
          ...process.env,
          BRAI_ROOT: root,
          BRAI_APK_SOURCE: apkPath,
          BRAI_RELEASE_ENV: "a",
          BRAI_ANDROID_VERSION_CODE: "2999",
          BRAI_PUBLISHED_AT: "2026-06-15T00:00:00Z",
        },
      });
    } finally {
      await chmod(releasePath, 0o600).catch(() => {});
    }

    expect((await stat(releasePath)).ino).not.toBe(previousInode);
    await expect(readFile(releasePath, "utf8")).resolves.toBe("new-apk");
  });

  it("replaces an existing OTA bundle instead of rewriting it in place", async () => {
    const root = await fixtureRoot("brai-mobile-replace-");
    await writeStaticExport(root, "ota-replace");
    const bundleVersion = "9.9.9";
    const bundleDir = path.join(root, "deploy/mobile-update/bundles", bundleVersion);
    const archivePath = path.join(bundleDir, "bundle.zip");
    await mkdir(bundleDir, { recursive: true });
    await writeFile(archivePath, "old");
    const previousInode = (await stat(archivePath)).ino;

    await execFileAsync("bash", [path.join(workspaceRoot, "deploy/scripts/publish-mobile-bundle.sh")], {
      env: {
        ...process.env,
        BRAI_ROOT: root,
        BRAI_APP_VERSION: bundleVersion,
        BRAI_TARGET_APK_VERSION: "2999",
        BRAI_PUBLISHED_AT: "2026-06-15T00:00:00Z",
      },
    });

    const nextInode = (await stat(archivePath)).ino;
    expect(nextInode).not.toBe(previousInode);
  });

  it("keeps mobile OTA bundles outside browser web publication cleanup", async () => {
    const root = await fixtureRoot("brai-web-publish-");
    await writeStaticExport(root, "web");
    const marker = path.join(root, "deploy/mobile-update/bundles/old.web.1/keep.txt");
    await mkdir(path.dirname(marker), { recursive: true });
    await writeFile(marker, "keep");
    await mkdir(path.join(root, "deploy/web"), { recursive: true });
    await writeFile(path.join(root, "deploy/web/old.txt"), "old");

    await execFileAsync("bash", [path.join(workspaceRoot, "deploy/scripts/publish-web.sh")], {
      env: { ...process.env, BRAI_ROOT: root },
    });

    await expect(readFile(marker, "utf8")).resolves.toBe("keep");
    await expect(readFile(path.join(root, "deploy/web/index.html"), "utf8")).resolves.toContain("web");
    expect((await stat(path.join(root, "deploy/web/index.html"))).mode & 0o020).toBe(0o020);
    await expect(readFile(path.join(root, "deploy/web/old.txt"), "utf8")).rejects.toThrow();
  });

  it("syncs occupied preview OTA manifests from each preview source", async () => {
    const root = await fixtureRoot("brai-preview-ota-sync-");
    const envsRoot = path.join(root, "envs");
    const sourceRoot = path.join(envsRoot, "preview-b/source");
    const dbPath = path.join(root, "brai.sqlite");
    await writeStaticExport(sourceRoot, "preview-b-content");
    await mkdir(path.join(sourceRoot, "deploy"), { recursive: true });
    await copyFile(
      path.join(workspaceRoot, "deploy/environments.json"),
      path.join(sourceRoot, "deploy/environments.json"),
    );
    await mkdir(path.join(sourceRoot, "deploy/scripts"), { recursive: true });
    for (const file of [
      "permissions.sh",
      "publish-client-web-layer.sh",
      "publish-environment-web-layer.sh",
      "publish-mobile-bundle.sh",
      "publish-web.sh",
      "resolve-required-apk-version.mjs",
    ]) {
      await copyFile(path.join(workspaceRoot, "deploy/scripts", file), path.join(sourceRoot, "deploy/scripts", file));
      if (file.endsWith(".sh")) await chmod(path.join(sourceRoot, "deploy/scripts", file), 0o755);
    }
    await mkdir(path.join(envsRoot, "preview-b/mobile-update"), { recursive: true });
    await writeFile(
      path.join(envsRoot, "preview-slots.json"),
      JSON.stringify({ B: { status: "ready", branch: "codex/preview-b", commit: "abc" }, queue: [] }),
    );
    await writeFile(
      path.join(envsRoot, "preview-b/mobile-update/manifest.json"),
      JSON.stringify({
        otaVersion: "0.0.67",
        archiveUrl: "https://b.test.brightos.world/mobile-update/bundles/0.0.67/bundle.zip",
      }),
    );
    await execFileAsync("node", ["--input-type=module", "-e", `
const { pathToFileURL } = await import("node:url");
const { BraiStore } = await import(pathToFileURL(process.argv[1]));
const store = new BraiStore(process.argv[2]);
try {
  store.upsertBuildVersion({
    versionTypeId: "build",
    version: 68,
    includedInVersionId: null,
    shortChanges: "Production build",
    detailedChanges: "Production build",
    reason: "Test",
    releasedAtUtc: "2026-07-03T00:00:00.000Z",
  });
} finally {
  store.close();
}
`, path.join(workspaceRoot, "services/brai_api/src/store.js"), dbPath], { env: nodeCliEnv });

    await execFileAsync("bash", [path.join(workspaceRoot, "deploy/scripts/sync-occupied-preview-ota-manifests.sh"), "--local"], {
      env: {
        ...process.env,
        BRAI_ROOT: workspaceRoot,
        BRAI_ENVS_ROOT: envsRoot,
        BRAI_PROD_DB: dbPath,
        BRAI_BUILD_CLIENT: "false",
        BRAI_TARGET_APK_VERSION: "2999",
        BRAI_PUBLISHED_AT: "2026-07-03T00:00:00Z",
      },
    });

    const manifest = JSON.parse(await readFile(path.join(envsRoot, "preview-b/mobile-update/manifest.json"), "utf8"));
    await expect(readFile(path.join(envsRoot, "preview-b/web/index.html"), "utf8")).resolves.toContain("preview-b-content");
    expect(manifest.otaVersion).toBe("0.0.68");
    expect(manifest.archiveUrl).toBe("https://b.test.brightos.world/mobile-update/bundles/0.0.68/bundle.zip");
  });

  it("allocates, reuses, and releases preview slots with the lock wrapper", async () => {
    const root = await fixtureRoot("brai-slots-");
    const envsRoot = path.join(root, "envs");
    const env = {
      ...process.env,
      BRAI_ROOT: workspaceRoot,
      BRAI_ENVS_ROOT: envsRoot,
    };

    const slotScript = path.join(workspaceRoot, "deploy/scripts/preview-slots.mjs");
    await execFileAsync("node", [slotScript, "allocate", "codex/one", "abc"], { env });
    await execFileAsync("node", [slotScript, "apk", "codex/one", "abc", "12", "brai-a.apk", "1"], { env });
    let registry = JSON.parse(await readFile(path.join(envsRoot, "preview-slots.json"), "utf8"));
    expect(registry.A.branch).toBe("codex/one");
    expect(registry.A.commit).toBe("abc");
    expect(registry.A.apk_version_code).toBe(12);

    await execFileAsync("node", [slotScript, "allocate", "codex/one", "def"], { env });
    registry = JSON.parse(await readFile(path.join(envsRoot, "preview-slots.json"), "utf8"));
    expect(registry.A.branch).toBe("codex/one");
    expect(registry.A.commit).toBe("def");

    await execFileAsync("node", [slotScript, "allocate", "codex/two", "123"], { env });
    registry = JSON.parse(await readFile(path.join(envsRoot, "preview-slots.json"), "utf8"));
    expect(registry.B.branch).toBe("codex/two");

    await execFileAsync("node", [slotScript, "release", "codex/one"], { env });
    registry = JSON.parse(await readFile(path.join(envsRoot, "preview-slots.json"), "utf8"));
    expect(registry.A.status).toBe("free");
    expect(registry.A.branch).toBeNull();
    const statusHtml = await readFile(path.join(envsRoot, "preview-status/index.html"), "utf8");
    expect(statusHtml).toContain("Brai Preview Slots");
    expect(statusHtml).toContain("APK versionCode");
  });

  it("queues preview branches when every slot is occupied", async () => {
    const root = await fixtureRoot("brai-slots-queue-");
    const envsRoot = path.join(root, "envs");
    const env = {
      ...process.env,
      BRAI_ROOT: workspaceRoot,
      BRAI_ENVS_ROOT: envsRoot,
    };
    const slotScript = path.join(workspaceRoot, "deploy/scripts/preview-slots.mjs");

    for (const branch of ["codex/one", "codex/two", "codex/three", "codex/four", "codex/five"]) {
      await execFileAsync("node", [slotScript, "allocate", branch, branch.split("/")[1]], { env });
    }

    await execFileAsync("node", [slotScript, "allocate", "codex/six", "006"], { env });
    let registry = JSON.parse(await readFile(path.join(envsRoot, "preview-slots.json"), "utf8"));
    expect(registry.queue.map((entry: { branch: string }) => entry.branch)).toEqual(["codex/six"]);

    await execFileAsync("node", [slotScript, "release", "codex/one"], { env });
    await execFileAsync("node", [slotScript, "allocate", "codex/seven", "007"], { env });
    registry = JSON.parse(await readFile(path.join(envsRoot, "preview-slots.json"), "utf8"));
    expect(registry.queue.map((entry: { branch: string }) => entry.branch)).toEqual(["codex/six", "codex/seven"]);

    await execFileAsync("node", [slotScript, "allocate", "codex/six", "006"], { env });

    registry = JSON.parse(await readFile(path.join(envsRoot, "preview-slots.json"), "utf8"));
    expect(registry.A.branch).toBe("codex/six");
    expect(registry.queue.map((entry: { branch: string }) => entry.branch)).toEqual(["codex/seven"]);

    await execFileAsync("node", [slotScript, "dequeue", "codex/seven"], { env });
    registry = JSON.parse(await readFile(path.join(envsRoot, "preview-slots.json"), "utf8"));
    expect(registry.queue).toEqual([]);
  });

  it("renders compact APK release cards", async () => {
    const root = await fixtureRoot("brai-release-page-");
    const releaseDir = path.join(root, "deploy/releases");
    await mkdir(releaseDir, { recursive: true });
    await mkdir(path.join(root, "deploy"), { recursive: true });
    await copyFile(
      path.join(workspaceRoot, "deploy/environments.json"),
      path.join(root, "deploy/environments.json"),
    );
    await writeFile(path.join(releaseDir, "brai-v1.apk"), "apk");

    await execFileAsync("node", [path.join(workspaceRoot, "deploy/scripts/update-release-index.mjs"), "--release", "production", "--file", "brai-v1.apk", "--apk-version", "1", "--version-code", "1", "--published-at", "2026-06-23T09:13:50Z"], {
      env: { ...process.env, BRAI_ROOT: root },
    });

    const html = await readFile(path.join(releaseDir, "index.html"), "utf8");
    const index = JSON.parse(await readFile(path.join(releaseDir, "releases.json"), "utf8"));
    expect(Object.keys(index.sections)).toEqual(["production", "dev", "a", "b", "c", "d", "e"]);
    expect(html.match(/<section>/g)?.length).toBe(7);
    expect(html).toContain("<h2>Brai</h2>");
    expect(html).toContain("<h2>Brai Dev</h2>");
    expect(html).toContain("Brai E");
    expect(html).toContain('<p class="version">v1</p>');
    expect(html).toContain("23 июня 2026, 12:13 МСК");
    expect(html).toContain('<a class="download" href="./brai-v1.apk">Скачать</a>');
    expect(html).toContain('<span class="download" aria-disabled="true">Скачать</span>');
    expect(html).not.toContain("versionCode");
    expect(html).not.toContain("applicationId");
    expect(html).not.toContain("AccessibilityService");
  });
});

async function fixtureRoot(prefix: string) {
  return await mkdtemp(path.join(tmpdir(), prefix));
}

async function writeStaticExport(root: string, marker: string) {
  const out = path.join(root, "apps/brai_app/out");
  await mkdir(path.join(out, "_next"), { recursive: true });
  await mkdir(path.join(root, "apps/brai_app/public"), { recursive: true });
  await writeFile(path.join(out, "index.html"), `<main>${marker}</main>`);
  await writeFile(path.join(out, "_next/app.js"), "console.log('ok')");
  await writeFile(path.join(out, "version.json"), JSON.stringify({ marker }));
  await writeFile(path.join(root, "apps/brai_app/public/version.json"), JSON.stringify({ version: "9.9.9" }));
}
