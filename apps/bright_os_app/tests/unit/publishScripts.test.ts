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
    const root = await fixtureRoot("bright-client-web-layer-");
    await writeStaticExport(root, "unified");
    const previousVersion = "9.9.9.98";
    const previousBundle = path.join(root, "deploy/mobile-update/bundles", previousVersion);
    await mkdir(previousBundle, { recursive: true });
    await writeFile(path.join(previousBundle, "bundle.zip"), "previous");
    await mkdir(path.join(root, "deploy/mobile-update"), { recursive: true });
    await writeFile(
      path.join(root, "deploy/mobile-update/manifest.json"),
      JSON.stringify({ bundleVersion: previousVersion }),
    );

    await execFileAsync("bash", [path.join(workspaceRoot, "deploy/scripts/publish-client-web-layer.sh")], {
      env: {
        ...process.env,
        BRIGHT_OS_ROOT: root,
        BRIGHT_OS_BUILD_CLIENT: "false",
        BRIGHT_OS_APP_VERSION: "9.9.9.99",
        BRIGHT_OS_MIN_APK_VERSION_CODE: "2999",
        BRIGHT_OS_PUBLISHED_AT: "2026-06-15T00:00:00Z",
      },
    });

    const bundleVersion = "9.9.9.99";
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
      version: "9.9.9.99",
      versionParts: { major: 9, release: 9, build: 9, apk: 99 },
    });
    expect(manifest.bundleVersion).toBe(bundleVersion);
  });

  it("publishes browser web and Android OTA into environment-specific roots", async () => {
    const root = await fixtureRoot("bright-env-publish-");
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
        BRIGHT_OS_ROOT: root,
        BRIGHT_OS_BUILD_CLIENT: "false",
        BRIGHT_OS_APP_VERSION: "9.9.9.99",
        BRIGHT_OS_WEB_TARGET: path.join(envRoot, "web"),
        BRIGHT_OS_MOBILE_TARGET: path.join(envRoot, "mobile-update"),
        BRIGHT_OS_UPDATE_BASE_URL: "https://a.test.brightos.world/mobile-update",
        BRIGHT_OS_MOBILE_BUNDLE_VERSION: "9.9.9.99.42",
        BRIGHT_OS_ENVIRONMENT: "preview-a",
        BRIGHT_OS_REQUIRED_APK_VERSION_CODE: "2999",
        BRIGHT_OS_PUBLISHED_AT: "2026-06-15T00:00:00Z",
      },
    });

    const manifest = JSON.parse(await readFile(path.join(envRoot, "mobile-update/manifest.json"), "utf8"));
    await expect(readFile(path.join(envRoot, "web/index.html"), "utf8")).resolves.toContain("env");
    expect(manifest.bundleVersion).toBe("9.9.9.99.42");
    expect(manifest.minApkVersionCode).toBe(2999);
    expect(manifest.maxApkVersionCode).toBe(2999);
    expect(manifest.archiveUrl).toBe("https://a.test.brightos.world/mobile-update/bundles/9.9.9.99.42/bundle.zip");
  });

  it("publishes a baseline web layer for a selected non-production environment", async () => {
    const root = await fixtureRoot("bright-env-baseline-");
    await writeStaticExport(root, "baseline");
    await mkdir(path.join(root, "deploy"), { recursive: true });
    await copyFile(
      path.join(workspaceRoot, "deploy/environments.json"),
      path.join(root, "deploy/environments.json"),
    );

    await execFileAsync("bash", [path.join(workspaceRoot, "deploy/scripts/publish-environment-web-layer.sh"), "preview-b"], {
      env: {
        ...process.env,
        BRIGHT_OS_ROOT: root,
        BRIGHT_OS_BUILD_CLIENT: "false",
        BRIGHT_OS_ENVS_ROOT: path.join(root, "envs"),
        BRIGHT_OS_APP_VERSION: "9.9.9.99",
        BRIGHT_OS_REQUIRED_APK_VERSION_CODE: "2999",
        BRIGHT_OS_PUBLISHED_AT: "2026-06-15T00:00:00Z",
      },
    });

    const target = path.join(root, "envs/preview-b");
    const manifest = JSON.parse(await readFile(path.join(target, "mobile-update/manifest.json"), "utf8"));
    await expect(readFile(path.join(target, "web/index.html"), "utf8")).resolves.toContain("baseline");
    expect(manifest.bundleVersion).toBe("9.9.9.99.0");
    expect(manifest.minApkVersionCode).toBe(2999);
    expect(manifest.maxApkVersionCode).toBe(2999);
    expect(manifest.archiveUrl).toBe("https://b.test.brightos.world/mobile-update/bundles/9.9.9.99.0/bundle.zip");
  });

  it("does not force a new Preview APK for web-only OTA bundles", async () => {
    const root = await fixtureRoot("bright-web-only-apk-");
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
      JSON.stringify({ schemaVersion: 1, sections: { a: { versionCode: 20 } } }),
    );
    const envRoot = path.join(root, "envs/preview-a");

    await execFileAsync("bash", [path.join(workspaceRoot, "deploy/scripts/publish-client-web-layer.sh")], {
      env: {
        ...process.env,
        BRIGHT_OS_ROOT: root,
        BRIGHT_OS_BUILD_CLIENT: "false",
        BRIGHT_OS_APP_VERSION: "9.9.9.99",
        BRIGHT_OS_WEB_TARGET: path.join(envRoot, "web"),
        BRIGHT_OS_MOBILE_TARGET: path.join(envRoot, "mobile-update"),
        BRIGHT_OS_UPDATE_BASE_URL: "https://a.test.brightos.world/mobile-update",
        BRIGHT_OS_MOBILE_BUNDLE_VERSION: "9.9.9.99.42",
        BRIGHT_OS_RELEASE_TARGET: releaseDir,
        BRIGHT_OS_ENVIRONMENT: "preview-a",
        BRIGHT_OS_PUBLISHED_AT: "2026-06-15T00:00:00Z",
      },
    });

    const manifest = JSON.parse(await readFile(path.join(envRoot, "mobile-update/manifest.json"), "utf8"));
    expect(manifest.minApkVersionCode).toBe(1);
    expect(manifest.maxApkVersionCode).toBeNull();
  });

  it("resolves native non-production OTA APK compatibility from the release index", async () => {
    const root = await fixtureRoot("bright-required-apk-");
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
      JSON.stringify({ schemaVersion: 1, sections: { dev: { versionCode: 7 }, a: { versionCode: 8 } } }),
    );
    const envRoot = path.join(root, "envs/preview-a");

    await execFileAsync("bash", [path.join(workspaceRoot, "deploy/scripts/publish-client-web-layer.sh")], {
      env: {
        ...process.env,
        BRIGHT_OS_ROOT: root,
        BRIGHT_OS_BUILD_CLIENT: "false",
        BRIGHT_OS_APP_VERSION: "9.9.9.99",
        BRIGHT_OS_WEB_TARGET: path.join(envRoot, "web"),
        BRIGHT_OS_MOBILE_TARGET: path.join(envRoot, "mobile-update"),
        BRIGHT_OS_UPDATE_BASE_URL: "https://a.test.brightos.world/mobile-update",
        BRIGHT_OS_MOBILE_BUNDLE_VERSION: "9.9.9.99.42",
        BRIGHT_OS_RELEASE_TARGET: releaseDir,
        BRIGHT_OS_ENVIRONMENT: "preview-a",
        BRIGHT_OS_NATIVE_APK_CHANGE: "true",
        BRIGHT_OS_PUBLISHED_AT: "2026-06-15T00:00:00Z",
      },
    });

    const manifest = JSON.parse(await readFile(path.join(envRoot, "mobile-update/manifest.json"), "utf8"));
    expect(manifest.minApkVersionCode).toBe(8);
    expect(manifest.maxApkVersionCode).toBe(8);
  });

  it("keeps non-production OTA public while protecting only the web shell in Caddy", async () => {
    const template = await readFile(path.join(workspaceRoot, "deploy/ansible/templates/Caddyfile.j2"), "utf8");
    const nonProductionStart = template.indexOf("{% for name, env in bright_os_envs.items() if name != 'prod' %}");
    expect(nonProductionStart).toBeGreaterThanOrEqual(0);
    const nonProductionTemplate = template.slice(nonProductionStart);
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

    expect(nonProductionTemplate).not.toMatch(/\{\{ env\.domain \}\} \{\n\s+\{\{ bright_os_basic_auth_directive \}\}/);
    expect(apiBlock).not.toContain("bright_os_basic_auth_directive");
    expect(apiBlock).not.toContain("header_up Authorization");
    expect(mobileIndex).toBeGreaterThan(nonProductionTemplate.indexOf("handle /releases*"));
    expect(mobileIndex).toBeLessThan(nonProductionTemplate.indexOf("handle {"));
    expect(mobileBlock).toContain('header /manifest.json Cache-Control "no-store"');
    expect(webShellBlock).toContain("bright_os_basic_auth_directive");
  });

  it("uses the public API endpoint for production Android bundles", async () => {
    const deployBranch = await readFile(path.join(workspaceRoot, "deploy/scripts/deploy-branch.sh"), "utf8");
    const buildApk = await readFile(path.join(workspaceRoot, "deploy/scripts/build-android-env-apk.sh"), "utf8");

    expect(deployBranch).toContain('ANDROID_API="https://api.brightos.world"');
    expect(deployBranch).toContain('export NEXT_PUBLIC_BRIGHT_OS_ANDROID_API="$ANDROID_API"');
    expect(buildApk).toContain('ANDROID_API="https://api.brightos.world"');
    expect(buildApk).toContain('export NEXT_PUBLIC_BRIGHT_OS_ANDROID_API="$ANDROID_API"');
    expect(buildApk).toContain('export JAVA_HOME="/srv/opt/jdk-21"');
    expect(buildApk).toContain('SIGNING_ENV="${BRIGHT_OS_ANDROID_SIGNING_ENV:-/srv/projects/bright-os-envs/android-signing/signing.env}"');
    expect(buildApk).toContain('/srv/opt/android-build-env/build-android.sh "$ROOT/apps/bright_os_app/android" "$GRADLE_TASK"');
  });

  it("resolves Android APK app versions from deployment sources", async () => {
    const root = await fixtureRoot("bright-apk-version-resolve-");
    await writeStaticExport(root, "stale-public-version");
    const dbPath = path.join(root, "bright.sqlite");
    await execFileAsync("node", ["--input-type=module", "-e", `
const { pathToFileURL } = await import("node:url");
const { BrightOsStore } = await import(pathToFileURL(process.argv[1]));
const store = new BrightOsStore(process.argv[2]);
try {
  store.upsertBuildVersion({
    majorVersion: 0,
    releaseVersion: 5,
    buildVersion: 43,
    apkVersion: 1,
    version: "0.5.43.1",
    shortChanges: "Production release",
    detailedChanges: "Production release",
    reason: "Needed for test",
    releasedAtUtc: "2026-06-28T17:29:00.000Z",
  });
} finally {
  store.close();
}
`, path.join(workspaceRoot, "services/bright_os_api/src/store.js"), dbPath], { env: nodeCliEnv });

    await mkdir(path.join(root, "deploy/web"), { recursive: true });
    await writeFile(path.join(root, "deploy/web/version.json"), JSON.stringify({ version: "0.5.43.1" }));
    const resolver = path.join(workspaceRoot, "deploy/scripts/resolve-app-version.mjs");
    const outputPath = path.join(root, "resolved-versions.json");
    await execFileAsync("node", ["--input-type=module", "-e", `
const fs = await import("node:fs/promises");
const { pathToFileURL } = await import("node:url");
const [, resolver, root, db, prodWebVersionJson, outputPath] = process.argv.slice(1);
const { resolveAppVersion } = await import(pathToFileURL(resolver));
await fs.writeFile(outputPath, JSON.stringify({
  production: resolveAppVersion({ environment: "prod", root, db, explicit: "" }),
  preview: resolveAppVersion({ environment: "preview-a", root, prodWebVersionJson, explicit: "" }),
}));
`, "import-helper", resolver, root, dbPath, path.join(root, "deploy/web/version.json"), outputPath], { env: nodeCliEnv });
    const versions = JSON.parse(await readFile(outputPath, "utf8"));

    expect(versions.production).toBe("0.5.43.1");
    expect(versions.preview).toBe("0.5.43.1");
  });

  it("promotes production deployment metadata into the production database path", async () => {
    const script = await readFile(path.join(workspaceRoot, "deploy/scripts/ci-ssh-promote-deployment.sh"), "utf8");
    expect(script).toContain('export BRIGHT_OS_DB="$DEPLOY_REPO/data/bright_os.sqlite"');
  });

  it("restores stale preview source permissions before deploy cleanup", async () => {
    const script = await readFile(path.join(workspaceRoot, "deploy/scripts/ci-ssh-deploy.sh"), "utf8");

    expect(script).toContain('find "$SOURCE_ROOT" -user "$(id -u)" -exec chmod u+rwX,g+rwX {} + || true');
    expect(script.indexOf('find "$SOURCE_ROOT" -user "$(id -u)"')).toBeLessThan(script.indexOf('rm -rf "$SOURCE_ROOT"'));
  });

  it("rebuilds all APK release rows from production native deploys", async () => {
    const deploy = await readFile(path.join(workspaceRoot, "deploy/scripts/ci-ssh-deploy.sh"), "utf8");
    const releaseSlot = await readFile(path.join(workspaceRoot, "deploy/scripts/ci-ssh-release-slot.sh"), "utf8");
    const prodBlock = deploy.slice(deploy.indexOf('elif [[ "$ENVIRONMENT" == "prod" ]]'));

    expect(prodBlock).toContain('deploy/scripts/build-android-env-apk.sh production');
    expect(prodBlock).toContain('node deploy/scripts/resolve-app-version.mjs --environment prod --root "$SOURCE_ROOT" --db "${BRIGHT_OS_DB:-}"');
    expect(prodBlock).toContain('deploy/scripts/build-nonproduction-apks.sh');
    expect(prodBlock.indexOf('deploy/scripts/build-android-env-apk.sh production')).toBeLessThan(prodBlock.indexOf('deploy/scripts/build-nonproduction-apks.sh'));
    expect(releaseSlot).toContain('deploy/scripts/build-android-env-apk.sh "preview${SLOT_META[0]}" >&2');
  });

  it("publishes a versioned bundle and atomic manifest from a static export", async () => {
    const root = await fixtureRoot("bright-mobile-publish-");
    await writeStaticExport(root, "ota");

    await execFileAsync("bash", [path.join(workspaceRoot, "deploy/scripts/publish-mobile-bundle.sh")], {
      env: {
        ...process.env,
        BRIGHT_OS_ROOT: root,
        BRIGHT_OS_MIN_APK_VERSION_CODE: "2999",
        BRIGHT_OS_PUBLISHED_AT: "2026-06-15T00:00:00Z",
      },
    });

    const bundleVersion = "9.9.9.99";
    const archivePath = path.join(root, "deploy/mobile-update/bundles", bundleVersion, "bundle.zip");
    const manifestPath = path.join(root, "deploy/mobile-update/manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const archive = await readFile(archivePath);

    expect(manifest).toMatchObject({
      schemaVersion: 1,
      channel: "stable",
      bundleVersion,
      archiveUrl: `https://app.brightos.world/mobile-update/bundles/${bundleVersion}/bundle.zip`,
      entrypoint: "index.html",
      minApkVersionCode: 2999,
      maxApkVersionCode: null,
      mandatory: false,
    });
    expect(manifest.sizeBytes).toBe((await stat(archivePath)).size);
    expect(manifest.sha256).toBe(createHash("sha256").update(archive).digest("hex"));
  });

  it("publishes an APK using app version metadata when env version is unset", async () => {
    const root = await fixtureRoot("bright-apk-publish-");
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
        BRIGHT_OS_ROOT: root,
        BRIGHT_OS_APK_SOURCE: apkPath,
        BRIGHT_OS_ANDROID_VERSION_CODE: "2999",
        BRIGHT_OS_PUBLISHED_AT: "2026-06-15T00:00:00Z",
      },
    });

    await expect(readFile(path.join(root, "deploy/releases/bright-os-9.9.9.99-capacitor.apk"), "utf8")).resolves.toBe("apk");
  });

  it("replaces an existing APK instead of rewriting it in place", async () => {
    const root = await fixtureRoot("bright-apk-replace-");
    await writeStaticExport(root, "apk-replace");
    await mkdir(path.join(root, "deploy"), { recursive: true });
    await copyFile(
      path.join(workspaceRoot, "deploy/environments.json"),
      path.join(root, "deploy/environments.json"),
    );
    const apkPath = path.join(root, "app-release.apk");
    await writeFile(apkPath, "new-apk");
    const releaseDir = path.join(root, "deploy/releases");
    const releasePath = path.join(releaseDir, "bright-os-a-9.9.9.99-capacitor.apk");
    await mkdir(releaseDir, { recursive: true });
    await writeFile(releasePath, "old-apk");
    await chmod(releasePath, 0o444);
    const previousInode = (await stat(releasePath)).ino;

    try {
      await execFileAsync("bash", [path.join(workspaceRoot, "deploy/scripts/publish-capacitor-apk.sh")], {
        env: {
          ...process.env,
          BRIGHT_OS_ROOT: root,
          BRIGHT_OS_APK_SOURCE: apkPath,
          BRIGHT_OS_RELEASE_ENV: "a",
          BRIGHT_OS_ANDROID_VERSION_CODE: "2999",
          BRIGHT_OS_PUBLISHED_AT: "2026-06-15T00:00:00Z",
        },
      });
    } finally {
      await chmod(releasePath, 0o600).catch(() => {});
    }

    expect((await stat(releasePath)).ino).not.toBe(previousInode);
    await expect(readFile(releasePath, "utf8")).resolves.toBe("new-apk");
  });

  it("allocates APK versionCode above existing release metadata", async () => {
    const root = await fixtureRoot("bright-apk-code-");
    const envsRoot = path.join(root, "envs");
    const releaseDir = path.join(root, "releases");
    await mkdir(releaseDir, { recursive: true });
    await writeFile(
      path.join(releaseDir, "releases.json"),
      JSON.stringify({ schemaVersion: 1, sections: { production: { versionCode: 9 } } }),
    );

    await execFileAsync("node", [path.join(workspaceRoot, "deploy/scripts/apk-version-code.mjs"), "next", "test"], {
      env: {
        ...process.env,
        BRIGHT_OS_ROOT: root,
        BRIGHT_OS_ENVS_ROOT: envsRoot,
        BRIGHT_OS_RELEASE_TARGET: releaseDir,
      },
    });
    let state = JSON.parse(await readFile(path.join(envsRoot, "apk-version-code.json"), "utf8"));
    expect(state.lastVersionCode).toBe(10);

    await execFileAsync("node", [path.join(workspaceRoot, "deploy/scripts/apk-version-code.mjs"), "next", "test"], {
      env: {
        ...process.env,
        BRIGHT_OS_ROOT: root,
        BRIGHT_OS_ENVS_ROOT: envsRoot,
        BRIGHT_OS_RELEASE_TARGET: releaseDir,
      },
    });
    state = JSON.parse(await readFile(path.join(envsRoot, "apk-version-code.json"), "utf8"));
    expect(state.lastVersionCode).toBe(11);
  });

  it("does not scan the production checkout when an APK release target is configured", async () => {
    const root = await fixtureRoot("bright-apk-code-target-");
    const envsRoot = path.join(root, "envs");
    const releaseDir = path.join(root, "runtime-releases");
    const blockedDir = path.join(root, "deploy/releases");
    await mkdir(releaseDir, { recursive: true });
    await mkdir(blockedDir, { recursive: true });
    await writeFile(
      path.join(releaseDir, "releases.json"),
      JSON.stringify({ schemaVersion: 1, sections: { a: { versionCode: 41 } } }),
    );
    await writeFile(
      path.join(blockedDir, "releases.json"),
      JSON.stringify({ schemaVersion: 1, sections: { production: { versionCode: 9999 } } }),
    );
    await chmod(path.join(blockedDir, "releases.json"), 0);
    try {
      await execFileAsync("node", [path.join(workspaceRoot, "deploy/scripts/apk-version-code.mjs"), "next", "test"], {
        env: {
          ...process.env,
          BRIGHT_OS_ROOT: root,
          BRIGHT_OS_ENVS_ROOT: envsRoot,
          BRIGHT_OS_RELEASE_TARGET: releaseDir,
        },
      });
    } finally {
      await chmod(path.join(blockedDir, "releases.json"), 0o600);
    }
    const state = JSON.parse(await readFile(path.join(envsRoot, "apk-version-code.json"), "utf8"));
    expect(state.lastVersionCode).toBe(42);
  });

  it("replaces an existing OTA bundle instead of rewriting it in place", async () => {
    const root = await fixtureRoot("bright-mobile-replace-");
    await writeStaticExport(root, "ota-replace");
    const bundleVersion = "9.9.9.99";
    const bundleDir = path.join(root, "deploy/mobile-update/bundles", bundleVersion);
    const archivePath = path.join(bundleDir, "bundle.zip");
    await mkdir(bundleDir, { recursive: true });
    await writeFile(archivePath, "old");
    const previousInode = (await stat(archivePath)).ino;

    await execFileAsync("bash", [path.join(workspaceRoot, "deploy/scripts/publish-mobile-bundle.sh")], {
      env: {
        ...process.env,
        BRIGHT_OS_ROOT: root,
        BRIGHT_OS_APP_VERSION: bundleVersion,
        BRIGHT_OS_MIN_APK_VERSION_CODE: "2999",
        BRIGHT_OS_PUBLISHED_AT: "2026-06-15T00:00:00Z",
      },
    });

    const nextInode = (await stat(archivePath)).ino;
    expect(nextInode).not.toBe(previousInode);
  });

  it("keeps mobile OTA bundles outside browser web publication cleanup", async () => {
    const root = await fixtureRoot("bright-web-publish-");
    await writeStaticExport(root, "web");
    const marker = path.join(root, "deploy/mobile-update/bundles/old.web.1/keep.txt");
    await mkdir(path.dirname(marker), { recursive: true });
    await writeFile(marker, "keep");
    await mkdir(path.join(root, "deploy/web"), { recursive: true });
    await writeFile(path.join(root, "deploy/web/old.txt"), "old");

    await execFileAsync("bash", [path.join(workspaceRoot, "deploy/scripts/publish-web.sh")], {
      env: { ...process.env, BRIGHT_OS_ROOT: root },
    });

    await expect(readFile(marker, "utf8")).resolves.toBe("keep");
    await expect(readFile(path.join(root, "deploy/web/index.html"), "utf8")).resolves.toContain("web");
    await expect(readFile(path.join(root, "deploy/web/old.txt"), "utf8")).rejects.toThrow();
  });

  it("allocates, reuses, and releases preview slots with the lock wrapper", async () => {
    const root = await fixtureRoot("bright-slots-");
    const envsRoot = path.join(root, "envs");
    const env = {
      ...process.env,
      BRIGHT_OS_ROOT: workspaceRoot,
      BRIGHT_OS_ENVS_ROOT: envsRoot,
    };

    const slotScript = path.join(workspaceRoot, "deploy/scripts/preview-slots.mjs");
    await execFileAsync("node", [slotScript, "allocate", "codex/one", "abc"], { env });
    await execFileAsync("node", [slotScript, "apk", "codex/one", "abc", "12", "bright-os-a.apk", "9.9.9.99"], { env });
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
    expect(statusHtml).toContain("Bright OS Preview Slots");
    expect(statusHtml).toContain("APK versionCode");
  });

  it("queues preview branches when every slot is occupied", async () => {
    const root = await fixtureRoot("bright-slots-queue-");
    const envsRoot = path.join(root, "envs");
    const env = {
      ...process.env,
      BRIGHT_OS_ROOT: workspaceRoot,
      BRIGHT_OS_ENVS_ROOT: envsRoot,
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

  it("renders exactly seven APK release sections without stale missing links", async () => {
    const root = await fixtureRoot("bright-release-page-");
    const releaseDir = path.join(root, "deploy/releases");
    await mkdir(releaseDir, { recursive: true });
    await mkdir(path.join(root, "deploy"), { recursive: true });
    await copyFile(
      path.join(workspaceRoot, "deploy/environments.json"),
      path.join(root, "deploy/environments.json"),
    );
    await writeFile(path.join(releaseDir, "bright-os-0.0.1.1-capacitor.apk"), "apk");

    await execFileAsync("node", [path.join(workspaceRoot, "deploy/scripts/update-release-index.mjs"), "--release", "production", "--file", "bright-os-0.0.1.1-capacitor.apk", "--version", "0.0.1.1", "--version-code", "1", "--published-at", "2026-06-23T09:13:50Z"], {
      env: { ...process.env, BRIGHT_OS_ROOT: root },
    });

    const html = await readFile(path.join(releaseDir, "index.html"), "utf8");
    expect(html.match(/<section>/g)?.length).toBe(7);
    expect(html).toContain("Bright OS Dev");
    expect(html).toContain("Bright OS E");
    expect(html).toContain("APK ещё не опубликован");
    expect(html).toContain("bright-os-0.0.1.1-capacitor.apk");
  });
});

async function fixtureRoot(prefix: string) {
  return await mkdtemp(path.join(tmpdir(), prefix));
}

async function writeStaticExport(root: string, marker: string) {
  const out = path.join(root, "apps/bright_os_app/out");
  await mkdir(path.join(out, "_next"), { recursive: true });
  await mkdir(path.join(root, "apps/bright_os_app/public"), { recursive: true });
  await writeFile(path.join(out, "index.html"), `<main>${marker}</main>`);
  await writeFile(path.join(out, "_next/app.js"), "console.log('ok')");
  await writeFile(path.join(out, "version.json"), JSON.stringify({ marker }));
  await writeFile(path.join(root, "apps/bright_os_app/public/version.json"), JSON.stringify({ version: "9.9.9.99" }));
}
