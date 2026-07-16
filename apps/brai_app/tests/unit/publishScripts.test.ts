import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import vm from "node:vm";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const appStaticRoutes = ["brai-cmd", "draws", "engine", "factory", "focus", "inbox"];
const fixtureRoots: string[] = [];

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map(async (root) => {
    makeWritable(root);
    await rm(root, { recursive: true, force: true });
  }));
});

function makeWritable(root: string) {
  if (!fs.existsSync(root)) return;
  fs.chmodSync(root, 0o700);
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const child = path.join(root, entry.name);
    if (entry.isDirectory()) makeWritable(child);
    else fs.chmodSync(child, 0o600);
  }
}

async function waitForPath(filePath: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

describe("mobile OTA publish scripts", () => {
  it("publishes browser web and Android OTA from one web-layer command", async () => {
    const root = await fixtureRoot("brai-client-web-layer-");
    await writeStaticExport(root, "unified");
    await mkdir(path.join(root, "landing/public"), { recursive: true });
    await writeFile(path.join(root, "landing/public/index.html"), "<main>landing-home</main>");
    await writeFile(path.join(root, "landing/public/versions.html"), "<main>landing-versions</main>");
    await writeFile(path.join(root, "landing/public/styles.css"), "body{}");
    await writeFile(path.join(root, "landing/public/auth-link.js"), "console.log('landing')");
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
        BRAI_PRODUCT_VERSION: "147",
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
    for (const route of appStaticRoutes) {
      await expect(readFile(path.join(root, `deploy/web/${route}/index.html`), "utf8")).resolves.toContain(
        `${route} route`,
      );
    }
    await expect(readFile(path.join(root, "deploy/site/versions.html"), "utf8")).resolves.toContain(
      "landing-versions",
    );
    await expect(
      readFile(path.join(root, "deploy/mobile-update/bundles", bundleVersion, "bundle.zip")),
    ).resolves.toBeInstanceOf(Buffer);
    const webVersion = JSON.parse(await readFile(path.join(root, "deploy/web/version.json"), "utf8"));
    const runtimeConfig = await readFile(path.join(root, "deploy/web/brai-runtime-config.js"), "utf8");
    expect(webVersion).toMatchObject({
      version: "9.9.9",
      versionParts: { major: 9, release: 9, build: 9 },
    });
    expect(runtimeConfig).toContain("window.__BRAI_RUNTIME_CONFIG__");
    expect(runtimeConfig).toContain('"appVersion": "9.9.9"');
    expect(runtimeConfig).toContain('"productVersion": 147');
    expect(manifest.otaVersion).toBe(bundleVersion);
    expect(manifest.targetApkVersion).toBe(2999);
  });

  it("writes safe client runtime config into the static export", async () => {
    const root = await fixtureRoot("brai-runtime-config-");
    await writeStaticExport(root, "runtime-config");

    await execFileAsync("node", [path.join(workspaceRoot, "deploy/scripts/write-client-runtime-config.mjs")], {
      env: {
        ...process.env,
        BRAI_ROOT: root,
        BRAI_APP_VERSION: "9.9.9",
        NEXT_PUBLIC_BRAI_ENVIRONMENT: "preview-a",
        NEXT_PUBLIC_BRAI_PREVIEW_SLOT: "A",
        NEXT_PUBLIC_BRAI_BRANCH: "codex/x</script>\u2028",
        NEXT_PUBLIC_BRAI_COMMIT: "abc123",
        NEXT_PUBLIC_BRAI_PRODUCT_VERSION: "147",
        NEXT_PUBLIC_BRAI_API: "/api",
        NEXT_PUBLIC_BRAI_ANDROID_API: "https://a.test.brai.one/api",
        NEXT_PUBLIC_BRAI_OTA_CHANNEL: "a.test.brai.one/mobile-update",
      },
    });

    const source = await readFile(path.join(root, "apps/brai_app/out/brai-runtime-config.js"), "utf8");
    expect(source).not.toContain("</script>");
    expect(source).toContain("\\u003c/script>");
    const context = { window: {} as { __BRAI_RUNTIME_CONFIG__?: Record<string, string> } };
    vm.runInNewContext(source, context);
    expect(context.window.__BRAI_RUNTIME_CONFIG__).toMatchObject({
      appVersion: "9.9.9",
      environment: "preview-a",
      previewSlot: "A",
      branch: "codex/x</script>\u2028",
      commit: "abc123",
      productVersion: 147,
      webApiBase: "/api",
      androidApiBase: "https://a.test.brai.one/api",
      otaChannel: "a.test.brai.one/mobile-update",
    });
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
        BRAI_UPDATE_BASE_URL: "https://a.test.brai.one/mobile-update",
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
    expect(manifest.archiveUrl).toBe("https://a.test.brai.one/mobile-update/bundles/9.9.9-preview.42/bundle.zip");
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
        BRAI_SKIP_DEPLOY_USER_REENTRY: "true",
        BRAI_APP_VERSION: "9.9.9",
        BRAI_PRODUCT_VERSION: "147",
        BRAI_TARGET_APK_VERSION: "2999",
        BRAI_PUBLISHED_AT: "2026-06-15T00:00:00Z",
      },
    });

    const target = path.join(root, "envs/preview-b");
    const manifest = JSON.parse(await readFile(path.join(target, "mobile-update/manifest.json"), "utf8"));
    const runtimeConfig = await readFile(path.join(target, "web/brai-runtime-config.js"), "utf8");
    await expect(readFile(path.join(target, "web/index.html"), "utf8")).resolves.toContain("baseline");
    expect(runtimeConfig).toContain('"environment": "preview-b"');
    expect(runtimeConfig).toContain('"previewSlot": "B"');
    expect(runtimeConfig).toContain('"productVersion": 147');
    expect(runtimeConfig).toContain('"androidApiBase": "https://b.test.brai.one/api"');
    expect(manifest.otaVersion).toBe("9.9.9");
    expect(manifest.targetApkVersion).toBe(2999);
    expect(manifest.archiveUrl).toBe("https://b.test.brai.one/mobile-update/bundles/9.9.9/bundle.zip");
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
        BRAI_UPDATE_BASE_URL: "https://a.test.brai.one/mobile-update",
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
        BRAI_UPDATE_BASE_URL: "https://a.test.brai.one/mobile-update",
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

  it("fails closed before non-native Preview OTA publication without a matching stable slot APK", async () => {
    const deployBranch = await readFile(path.join(workspaceRoot, "deploy/scripts/deploy-branch.sh"), "utf8");
    const guardIndex = deployBranch.indexOf("Cannot publish Preview");
    expect(guardIndex).toBeGreaterThan(0);
    expect(guardIndex).toBeLessThan(deployBranch.indexOf('"$SCRIPT_DIR/publish-client-web-layer.sh"'));

    const cases = [
      {
        name: "missing-slot",
        slot: undefined,
        artifact: false,
        error: "stable slot APK release is missing",
      },
      {
        name: "preview-slot",
        slot: { file: "brai-c-v10-preview1.apk", apkVersion: 10, versionCode: 100001, apkBuildKind: "preview" },
        artifact: true,
        error: "slot APK release is preview, expected stable",
      },
      {
        name: "stale-slot",
        slot: { file: "brai-c-v9.apk", apkVersion: 9, versionCode: 9, apkBuildKind: "stable" },
        artifact: true,
        error: "stable slot APK baseline 9/9 does not match Production 10/10",
      },
      {
        name: "missing-artifact",
        slot: { file: "brai-c-v10.apk", apkVersion: 10, versionCode: 10, apkBuildKind: "stable" },
        artifact: false,
        error: "stable slot APK artifact is missing: brai-c-v10.apk",
      },
      {
        name: "matching-slot",
        slot: { file: "brai-c-v10.apk", apkVersion: 10, versionCode: 10, apkBuildKind: "stable" },
        artifact: true,
        error: "Missing static export for BRAI_BUILD_CLIENT=false",
      },
    ];

    for (const testCase of cases) {
      const root = await fixtureRoot(`brai-deploy-slot-apk-${testCase.name}-`);
      await mkdir(path.join(root, "deploy"), { recursive: true });
      await copyFile(
        path.join(workspaceRoot, "deploy/environments.json"),
        path.join(root, "deploy/environments.json"),
      );
      const releaseDir = path.join(root, "releases");
      await mkdir(releaseDir, { recursive: true });
      const production = { file: "brai-v10.apk", apkVersion: 10, versionCode: 10, apkBuildKind: "stable" };
      await writeFile(path.join(releaseDir, production.file), "production-apk");
      if (testCase.slot && testCase.artifact) {
        await writeFile(path.join(releaseDir, testCase.slot.file), "slot-apk");
      }
      await writeFile(
        path.join(releaseDir, "releases.json"),
        JSON.stringify({ schemaVersion: 2, sections: { production, ...(testCase.slot ? { c: testCase.slot } : {}) } }),
      );

      let stderr = "";
      try {
        await execFileAsync("bash", [path.join(workspaceRoot, "deploy/scripts/deploy-branch.sh")], {
          env: {
            ...process.env,
            BRAI_ROOT: root,
            BRAI_BRANCH: "codex/slot-apk-guard",
            BRAI_COMMIT: "guard-commit",
            BRAI_PREVIEW_SLOT: "C",
            BRAI_NATIVE_APK_CHANGE: "false",
            BRAI_DATABASE_URL: "postgresql://unused",
            BRAI_APP_VERSION: "9.9.9",
            BRAI_RELEASE_TARGET: releaseDir,
            BRAI_ENV_ROOT: path.join(root, "envs/preview-c"),
            BRAI_ENVS_ROOT: path.join(root, "envs"),
            BRAI_BUILD_CLIENT: "false",
            BRAI_RESTART_SERVICE: "false",
            NODE_BIN: process.execPath,
          },
        });
      } catch (error) {
        stderr = String((error as { stderr?: string }).stderr ?? error);
      }

      expect(stderr).toContain(testCase.error);
      expect(fs.existsSync(path.join(root, "envs/preview-c/mobile-update/manifest.json"))).toBe(false);
    }
  });

  it("keeps production app public and protects only preview web shells in Caddy", async () => {
    const template = await readFile(path.join(workspaceRoot, "deploy/ansible/templates/Caddyfile.j2"), "utf8");
    const playbook = await readFile(path.join(workspaceRoot, "deploy/ansible/brai.yml"), "utf8");
    const nonProductionStart = template.indexOf("{% for name, env in brai_envs.items() if name != 'prod' %}");
    expect(nonProductionStart).toBeGreaterThanOrEqual(0);
    const productionTemplate = template.slice(template.indexOf("{{ brai_envs.prod.domain }}"), nonProductionStart);
    const nonProductionTemplate = template.slice(nonProductionStart);
    const productionApiBlock = productionTemplate.slice(
      productionTemplate.indexOf("handle_path /api/*"),
      productionTemplate.indexOf("handle_path /mobile-update/*"),
    );
    const productionAdminBlock = productionTemplate.slice(
      productionTemplate.indexOf("handle @admin"),
      productionTemplate.indexOf("handle_path /api/*"),
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
    const adminBlock = nonProductionTemplate.slice(
      nonProductionTemplate.indexOf("handle @admin"),
      mobileIndex,
    );
    const mobileBlock = nonProductionTemplate.slice(mobileIndex, nonProductionTemplate.indexOf("handle {"));
    const webShellBlock = nonProductionTemplate.slice(
      nonProductionTemplate.indexOf("handle {"),
      nonProductionTemplate.indexOf("try_files"),
    );

    expect(productionTemplate).toContain("{{ brai_envs.prod.domain }}");
    expect(template).toContain("{{ brai_api_domain }}");
    expect(template).toContain("{{ brai_temporal_ui_domain }}");
    expect(template).toContain("brai_api_legacy_domains");
    expect(template).toContain("redir https://{{ brai_api_domain }}{uri} 308");
    expect(productionApiBlock).not.toContain("brai_basic_auth_directive");
    expect(productionApiBlock).not.toContain("header_up Authorization");
    expect(template).toContain("@not_brai_chat_runtime not path /v1/brai-chat/runtime*");
    expect(productionTemplate).toContain("@not_brai_chat_runtime not path /api/v1/brai-chat/runtime*");
    expect(nonProductionTemplate).toContain("@not_brai_chat_runtime not path /api/v1/brai-chat/runtime*");
    expect(template.match(/encode @not_brai_chat_runtime zstd gzip/g)?.length).toBe(3);
    expect(productionAdminBlock).toContain("brai_envs.prod.admin_port");
    expect(productionAdminBlock).not.toContain("brai_basic_auth_directive");
    expect(productionTemplate).toContain("@admin path /admin /admin/*");
    expect(productionTemplate).toContain("handle /dev-releases*");
    expect(productionTemplate.indexOf("handle @admin")).toBeLessThan(productionTemplate.indexOf("handle {"));
    expect(productionShellBlock).not.toContain("brai_basic_auth_directive");
    expect(nonProductionTemplate).not.toMatch(/\{\{ env\.domain \}\} \{\n\s+\{\{ brai_basic_auth_directive \}\}/);
    expect(apiBlock).not.toContain("brai_basic_auth_directive");
    expect(apiBlock).not.toContain("header_up Authorization");
    expect(adminBlock).toContain("brai_basic_auth_directive");
    expect(adminBlock).toContain("env.admin_port");
    expect(nonProductionTemplate).toContain("@admin path /admin /admin/*");
    expect(nonProductionTemplate).toContain("handle /dev-releases*");
    expect(mobileIndex).toBeGreaterThan(nonProductionTemplate.indexOf("handle /releases*"));
    expect(mobileIndex).toBeLessThan(nonProductionTemplate.indexOf("handle {"));
    expect(mobileBlock).toContain('header /manifest.json Cache-Control "no-store"');
    expect(webShellBlock).toContain("brai_basic_auth_directive");
    expect(playbook.match(/{{ brai_supabase_studio_domain }}/g)?.length ?? 0).toBeGreaterThanOrEqual(6);
    expect(playbook).toContain("{{ brai_api_legacy_domains[0] }}");
    expect(playbook).toMatch(/Ensure non-production deploy artifact ownership[\s\S]*recurse: true/);
  });

  it("uses the public API endpoint for production Android bundles", async () => {
    const deployBranch = await readFile(path.join(workspaceRoot, "deploy/scripts/deploy-branch.sh"), "utf8");
    const buildApk = await readFile(path.join(workspaceRoot, "deploy/scripts/build-android-env-apk.sh"), "utf8");
    const gradle = await readFile(path.join(workspaceRoot, "apps/brai_app/android/app/build.gradle"), "utf8");

    expect(deployBranch).toContain('ANDROID_API="https://api.brai.one"');
    expect(deployBranch).toContain('export NEXT_PUBLIC_BRAI_ANDROID_API="$ANDROID_API"');
    expect(buildApk).toContain('ANDROID_API="https://api.brai.one"');
    expect(buildApk).toContain('export NEXT_PUBLIC_BRAI_ANDROID_API="$ANDROID_API"');
    expect(buildApk).toContain('export JAVA_HOME="/srv/opt/jdk-21"');
    expect(buildApk).toContain('SIGNING_ENV="${BRAI_ANDROID_SIGNING_ENV:-/srv/projects/brai-envs/android-signing/signing.env}"');
    expect(buildApk).toContain('/srv/opt/android-build-env/build-android.sh "$ROOT/apps/brai_app/android" "$GRADLE_TASK"');
    expect(buildApk).toContain("fs.writeFileSync(outVersionFile");
    expect(buildApk.indexOf('(cd "$ROOT" && "$NPM_BIN" run app:build)')).toBeLessThan(buildApk.indexOf('\nrun_capacitor_sync\n'));
    expect(gradle).toContain('throw new GradleException("BRAI_APP_VERSION is required for Android builds")');
    expect(gradle).toContain("tasks.register('validateBraiAndroidApiBundle')");
    expect(gradle).toContain("brai-runtime-config.js");
    expect(gradle).toContain("Non-production runtime config contains production API");
    expect(gradle).toContain("https://a.test.brai.one/api");
    expect(gradle).not.toContain("BRAI_PROD_FALLBACK_BUNDLE_VERSION");
    expect(gradle).not.toContain("BRAI_NON_PROD_FALLBACK_BUNDLE_VERSION");
    expect(gradle).not.toContain("?: '0.0.10'");
  });

  it("uses the brai.one endpoint for Preview E Android bundles", async () => {
    const environments = JSON.parse(
      await readFile(path.join(workspaceRoot, "deploy/environments.json"), "utf8"),
    );
    const gradle = await readFile(path.join(workspaceRoot, "apps/brai_app/android/app/build.gradle"), "utf8");
    const ansible = await readFile(path.join(workspaceRoot, "deploy/ansible/group_vars/brai.yml"), "utf8");

    expect(environments.environments["preview-e"].domain).toBe("e.test.brai.one");
    expect(gradle).toContain("previewe: 'https://e.test.brai.one/api'");
    expect(gradle).toContain('"https://e.test.brai.one/mobile-update/manifest.json"');
    expect(ansible).toContain("domain: e.test.brai.one");
    expect(gradle).not.toContain("https://e.test.brightos.world/api");
    expect(ansible).toContain("- e.test.brightos.world");
  });

  it("keeps generic deploy pending and marks Preview ready only after the independent Goal-agent gate", async () => {
    const deployBranch = await readFile(path.join(workspaceRoot, "deploy/scripts/deploy-branch.sh"), "utf8");
    const goalAgentGate = await readFile(path.join(workspaceRoot, "deploy/scripts/deploy-goal-agents.sh"), "utf8");
    const restartIndex = deployBranch.indexOf('"${BRAI_SUDO:-sudo}" systemctl restart "$SERVICE_NAME"');
    const adminRestartIndex = deployBranch.indexOf('"${BRAI_SUDO:-sudo}" systemctl restart "$ADMIN_SERVICE_NAME"');
    const smokeIndex = goalAgentGate.indexOf("context-smoke-cli.mjs");
    const readyIndex = goalAgentGate.indexOf('"$SCRIPT_DIR/preview-slots.sh" ready "$BRANCH" "$COMMIT"');

    expect(restartIndex).toBeGreaterThan(0);
    expect(adminRestartIndex).toBeGreaterThan(restartIndex);
    expect(deployBranch).not.toContain('preview-slots.sh" ready');
    expect(deployBranch).toContain("Goal-agent gate remains pending");
    expect(smokeIndex).toBeGreaterThan(0);
    expect(readyIndex).toBeGreaterThan(smokeIndex);
  });

  it("resolves OTA app versions from the build ledger before deployed files", async () => {
    const deployBranch = await readFile(path.join(workspaceRoot, "deploy/scripts/deploy-branch.sh"), "utf8");
    const ciDeploy = await readFile(path.join(workspaceRoot, "deploy/scripts/ci-ssh-deploy.sh"), "utf8");

    expect(deployBranch).toContain('BRAI_DATABASE_URL="$POSTGRES_URL" BRAI_PROD_DATABASE_URL="$PROD_POSTGRES_URL" "$NODE_BIN" "$SCRIPT_DIR/resolve-app-version.mjs"');
    expect(deployBranch).toContain('if [[ -f "$RELEASE_TARGET/releases.json" ]]; then');
    expect(deployBranch).toContain('"$SCRIPT_DIR/update-release-index.mjs" --render-only');
    expect(deployBranch).not.toContain('--postgres-url "$POSTGRES_URL"');
    expect(deployBranch).not.toContain('--prod-postgres-url "$PROD_POSTGRES_URL"');
    expect(deployBranch).not.toContain("--db");
    expect(deployBranch).not.toContain("--prod-db");
    expect(deployBranch).toContain('--mobile-target "$MOBILE_TARGET"');
    expect(deployBranch).toContain('BRAI_RECORD_PROD_BRANCH_DEPLOYMENT');
    const buildApk = await readFile(path.join(workspaceRoot, "deploy/scripts/build-android-env-apk.sh"), "utf8");
    expect(buildApk).toContain('MOBILE_TARGET="${BRAI_MOBILE_TARGET:-}"');
    expect(buildApk).toContain('if [[ -z "$MOBILE_TARGET" && -n "$ENV_PATH" ]]; then');
    expect(buildApk).toContain('--mobile-target "$MOBILE_TARGET"');
    expect(ciDeploy).toContain('[[ -r "/etc/brai/brai-api.env" ]]');
    expect(ciDeploy).toContain('BRAI_PROD_DATABASE_URL="$(env_database_url /etc/brai/brai-api.env)"');
    expect(ciDeploy).not.toContain("BRAI_PROD_DB");
    expect(ciDeploy).toContain('export BRAI_PUBLIC_SITE_TARGET="$DEPLOY_REPO/deploy/site"');
  });

  it("records shipped APK ledger rows idempotently by target commit", async () => {
    const recordScript = await readFile(path.join(workspaceRoot, "deploy/scripts/record-shipped-apk-version.mjs"), "utf8");
    const resolver = await readFile(path.join(workspaceRoot, "deploy/scripts/resolve-app-version.mjs"), "utf8");

    expect(recordScript).toContain('required(values, "postgres-url")');
    expect(recordScript).not.toContain('"db"');
    expect(resolver).toContain("BRAI_DATABASE_URL is required to resolve Brai APK version");
    expect(resolver).not.toContain("better-sqlite3");
  });

  it("promotes production deployment metadata into the production database path", async () => {
    const script = await readFile(path.join(workspaceRoot, "deploy/scripts/ci-ssh-promote-deployment.sh"), "utf8");
    expect(script).toContain('[[ -n "${BRAI_DATABASE_URL:-}" ]] || return 1');
    expect(script).not.toContain("BRAI_DB");
  });

  it("restores stale source permissions only after staged dependencies are complete", async () => {
    const script = await readFile(path.join(workspaceRoot, "deploy/scripts/ci-ssh-deploy.sh"), "utf8");

    expect(script).toContain('find "$REMOTE_UPLOAD" ! -type l -user "$(id -u)" -exec chmod u+rwX,g+rwX {} +');
    const sourceChmod = 'find "$SOURCE_ROOT" ! -type l -user "$(id -u)" -exec chmod u+rwX,g+rwX {} + || true';
    expect(script).toContain(sourceChmod);
    expect(script).toContain('mv "$SOURCE_ROOT" "$PREVIOUS_SOURCE"');
    expect(script.indexOf('npm --prefix services/brai_api ci')).toBeLessThan(script.indexOf(sourceChmod));
    expect(script.indexOf(sourceChmod)).toBeLessThan(script.indexOf('mv "$SOURCE_ROOT" "$PREVIOUS_SOURCE"'));
    expect(script).toContain('check_deploy_headroom "$ENVS_ROOT"');
    expect(script).toContain('BRAI_DEPLOY_MIN_FREE_GB:-12');
    expect(script).not.toContain('cleanup_stale_preview_previous_sources');
    expect(script.indexOf('check_deploy_headroom "$ENVS_ROOT"')).toBeLessThan(script.indexOf('npm ci'));
    expect(script.indexOf('remove_owned_previous_source', script.indexOf('deploy/scripts/deploy-branch.sh'))).toBe(-1);
    expect(script).not.toContain('source.previous-*');
  });

  it("keeps preview runtime Supabase env mandatory and artifacts writable by the deploy group", async () => {
    const deploy = await readFile(path.join(workspaceRoot, "deploy/scripts/deploy-branch.sh"), "utf8");
    const ciDeploy = await readFile(path.join(workspaceRoot, "deploy/scripts/ci-ssh-deploy.sh"), "utf8");
    const playbook = await readFile(path.join(workspaceRoot, "deploy/ansible/brai.yml"), "utf8");
    const service = await readFile(path.join(workspaceRoot, "deploy/ansible/templates/brai-api.service.j2"), "utf8");
    const adminService = await readFile(path.join(workspaceRoot, "deploy/ansible/templates/brai-admin.service.j2"), "utf8");
    const sudoers = await readFile(path.join(workspaceRoot, "deploy/ansible/templates/brai-deploy-sudoers.j2"), "utf8");

    expect(deploy).toContain(': "${POSTGRES_URL:?BRAI_DATABASE_URL is required for $ENVIRONMENT deploy}"');
    expect(deploy).toContain("(cd \"$ROOT/admin\" && npm run build)");
    expect(ciDeploy).toContain("npm --prefix admin ci");
    expect(service).toContain("EnvironmentFile={{ brai_env_root }}/{{ item.value.path }}/brai-api.env");
    expect(service).not.toContain("EnvironmentFile=-");
    expect(service).not.toContain("BRAI_LEGACY_SQLITE_PATH");
    expect(service).toContain('Group={{ brai_deploy_user }}');
    expect(service).toContain('UMask=0002');
    expect(adminService).toContain("WorkingDirectory={{ brai_env_root }}/{{ item.value.path }}/source/admin");
    expect(adminService).toContain("EnvironmentFile={{ brai_env_root }}/{{ item.value.path }}/brai-api.env");
    expect(adminService).toContain("NODE_ENV=production");
    expect(adminService).toContain("BRAI_ADMIN_API_BASE=http://127.0.0.1:{{ item.value.api_port }}");
    expect(adminService).toContain("-p {{ item.value.admin_port }}");
    expect(sudoers).toContain("systemctl restart {{ env.admin_service }}");
    expect(sudoers).toContain("systemctl stop {{ env.admin_service }}");
    expect(sudoers).toContain("systemctl reset-failed {{ env.admin_service }}");
    expect(sudoers).toContain("{% if name.startswith('preview-') %}");
    expect(playbook).toContain("Ensure non-production data directories keep deploy setgid");
    expect(playbook).toContain('group: "{{ brai_deploy_user }}"');
    expect(playbook).toContain('mode: "2775"');
    expect(deploy).not.toContain("Preview SQLite reset failed");
    expect(deploy).not.toContain("brai.sqlite");
  });

  it("rebuilds APK release rows and defers production ledger rows to work reconciliation", async () => {
    const deploy = await readFile(path.join(workspaceRoot, "deploy/scripts/ci-ssh-deploy.sh"), "utf8");
    const deployBranch = await readFile(path.join(workspaceRoot, "deploy/scripts/deploy-branch.sh"), "utf8");
    const buildApk = await readFile(path.join(workspaceRoot, "deploy/scripts/build-android-env-apk.sh"), "utf8");
    const buildNonproduction = await readFile(path.join(workspaceRoot, "deploy/scripts/build-nonproduction-apks.sh"), "utf8");
    const releaseSlot = await readFile(path.join(workspaceRoot, "deploy/scripts/ci-ssh-release-slot.sh"), "utf8");
    const prodBlock = deploy.slice(deploy.indexOf('elif [[ "$ENVIRONMENT" == "prod" ]]'));

    expect(deploy).toContain("export BRAI_NATIVE_APK_CHANGE");
    expect(deploy).toContain('git rev-list --first-parent "$BRAI_COMMIT"');
    expect(deploy).toContain('--target-commit "$BRAI_PRODUCT_BASE_COMMIT"');
    expect(deploy).toContain('--ancestor-commits "$BRAI_PRODUCT_ANCESTOR_COMMITS"');
    expect(deployBranch).toContain("BRAI_NATIVE_APK_CHANGE:-false");
    expect(deployBranch).toContain('resolve-required-apk-version.mjs" prod apkVersion');
    expect(deployBranch).toContain('BRAI_TARGET_APK_VERSION="$("$NODE_BIN" "$SCRIPT_DIR/resolve-required-apk-version.mjs" prod apkVersion)"');
    expect(deployBranch).toContain("export BRAI_TARGET_APK_VERSION");
    expect(deployBranch).toContain('export BRAI_TARGET_APK_BUILD_KIND="stable"');
    expect(deployBranch).not.toContain("BRAI_TARGET_APK_VERSION:-");
    expect(deployBranch).not.toContain("BRAI_TARGET_APK_BUILD_KIND:-stable");
    expect(deployBranch).toContain('preview-slots.sh" clear-apk "$BRANCH" "$COMMIT"');
    expect(prodBlock).toContain('deploy/scripts/build-android-env-apk.sh production');
    expect(prodBlock).toContain('node deploy/scripts/resolve-app-version.mjs --environment prod --root "$SOURCE_ROOT"');
    expect(prodBlock).toContain('deploy/scripts/build-nonproduction-apks.sh');
    expect(prodBlock.indexOf('deploy/scripts/build-android-env-apk.sh production')).toBeLessThan(prodBlock.indexOf('deploy/scripts/build-nonproduction-apks.sh'));
    expect(buildApk).toContain('"${BRAI_RECORD_APK_LEDGER:-true}" != "false"');
    expect(buildApk).toContain('--next-apk true --target-branch "$BRAI_BRANCH" --target-commit "$BRAI_COMMIT"');
    expect(releaseSlot).toContain('systemctl reset-failed "$unit"');
    expect(buildApk).toContain('preview-slots.sh" next-apk-preview "$BRAI_BRANCH" "$BRAI_COMMIT" "$BRAI_APK_VERSION"');
    expect(buildApk.indexOf('if [[ "$ENVIRONMENT" == preview-*')).toBeLessThan(buildApk.indexOf('export BRAI_APK_VERSION='));
    expect(buildApk).toContain('BUILD_CLIENT="${BRAI_BUILD_CLIENT:-true}"');
    expect(buildApk).toContain('Missing static export for BRAI_BUILD_CLIENT=$BUILD_CLIENT');
    expect(buildApk).toContain('write-client-runtime-config.mjs');
    expect(buildApk).not.toContain('record-shipped-apk-version.mjs');
    expect(buildApk).toContain('ledger recording waits for work reconciliation');
    expect(buildNonproduction).toContain('for flavor in dev previewA previewB previewC previewD previewE; do');
    expect(buildNonproduction).toContain('BRAI_BUILD_CLIENT=false "$SCRIPT_DIR/build-android-env-apk.sh" "$flavor"');
    expect(releaseSlot).toContain('section?.apkBuildKind === "stable"');
    expect(releaseSlot).toContain('Stable Preview ${SLOT_META[0]} APK baseline already exists; skipping rebuild.');
    expect(releaseSlot).toContain('stop_preview_unit_if_exists "brai-api-preview-$SLOT_LOWER.service"');
    expect(releaseSlot).toContain('stop_preview_unit_if_exists "brai-admin-preview-$SLOT_LOWER.service"');
    expect(releaseSlot).toContain('cleanup_released_preview_slot_artifacts');
    expect(releaseSlot).toContain('rm -rf "$slot_root/source" "$slot_root"/source.previous-* "$slot_root/web" "$slot_root/mobile-update"');
    expect(releaseSlot).not.toContain('rm -rf "$slot_root/data"');
    expect(releaseSlot).not.toContain('rm -rf "$slot_root/vault"');
    expect(releaseSlot).toContain('deploy/scripts/build-android-env-apk.sh "preview${SLOT_META[0]}" >&2');
  });

  it("guards APK publication against stale embedded web versions", async () => {
    const buildApk = await readFile(path.join(workspaceRoot, "deploy/scripts/build-android-env-apk.sh"), "utf8");
    const syncIndex = buildApk.indexOf('(cd "$ROOT" && "$NPM_BIN" run app:cap:sync)');
    const publishIndex = buildApk.indexOf('BRAI_RELEASE_ENV="$RELEASE_KEY" BRAI_APK_SOURCE="$APK" "$SCRIPT_DIR/publish-capacitor-apk.sh"');
    const guardBlock = buildApk.slice(syncIndex, publishIndex);

    expect(syncIndex).toBeGreaterThan(0);
    expect(publishIndex).toBeGreaterThan(syncIndex);
    expect(guardBlock).toContain("version.json");
    expect(guardBlock).toContain("BRAI_APP_VERSION");
    expect(guardBlock).toContain("Embedded APK version.json mismatch");
    expect(guardBlock).toMatch(/exit 1/);
  });

  it("publishes a versioned bundle and atomic manifest from a static export", async () => {
    const root = await fixtureRoot("brai-mobile-publish-");
    await writeStaticExport(root, "ota");

    await execFileAsync("bash", [path.join(workspaceRoot, "deploy/scripts/publish-mobile-bundle.sh")], {
      env: {
        ...process.env,
        BRAI_ROOT: root,
        BRAI_APP_VERSION: "9.9.9",
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
      archiveUrl: `https://app.brai.one/mobile-update/bundles/${bundleVersion}/bundle.zip`,
      entrypoint: "index.html",
      targetApkVersion: 2999,
      targetApkReleaseKey: "production",
      targetApkBuildKind: "stable",
      targetApkPreviewIteration: 0,
      targetApkVersionCode: 2999,
      mandatory: false,
    });
    expect(manifest.sizeBytes).toBe((await stat(archivePath)).size);
    expect(manifest.sha256).toBe(createHash("sha256").update(archive).digest("hex"));
  });

  it("publishes preview APK target metadata into OTA manifests", async () => {
    const root = await fixtureRoot("brai-mobile-preview-target-");
    await writeStaticExport(root, "ota-preview");

    await execFileAsync("bash", [path.join(workspaceRoot, "deploy/scripts/publish-mobile-bundle.sh")], {
      env: {
        ...process.env,
        BRAI_ROOT: root,
        BRAI_APP_VERSION: "9.9.9",
        BRAI_TARGET_APK_VERSION: "2",
        BRAI_TARGET_APK_RELEASE_KEY: "a",
        BRAI_TARGET_APK_BUILD_KIND: "preview",
        BRAI_TARGET_APK_PREVIEW_ITERATION: "6",
        BRAI_TARGET_APK_VERSION_CODE: "20006",
        BRAI_PUBLISHED_AT: "2026-06-15T00:00:00Z",
      },
    });

    const manifest = JSON.parse(await readFile(path.join(root, "deploy/mobile-update/manifest.json"), "utf8"));
    expect(manifest).toMatchObject({
      targetApkVersion: 2,
      targetApkReleaseKey: "a",
      targetApkBuildKind: "preview",
      targetApkPreviewIteration: 6,
      targetApkVersionCode: 20006,
    });
  });

  it("publishes an APK using explicit APK version metadata", async () => {
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
        BRAI_APK_VERSION: "1",
        BRAI_ANDROID_VERSION_CODE: "2999",
        BRAI_PUBLISHED_AT: "2026-06-15T00:00:00Z",
      },
    });

    await expect(readFile(path.join(root, "deploy/releases/brai-v1.apk"), "utf8")).resolves.toBe("apk");
  });

  it("waits for the shared release lock before swapping an APK and its metadata", async () => {
    const root = await fixtureRoot("brai-apk-release-lock-");
    await writeStaticExport(root, "apk-lock");
    await mkdir(path.join(root, "deploy"), { recursive: true });
    await copyFile(
      path.join(workspaceRoot, "deploy/environments.json"),
      path.join(root, "deploy/environments.json"),
    );
    const apkPath = path.join(root, "app-release.apk");
    const releaseDir = path.join(root, "deploy/releases");
    const readyPath = path.join(root, "lock-ready");
    await writeFile(apkPath, "apk-under-lock");
    await mkdir(releaseDir, { recursive: true });

    const holder = execFile("bash", ["-c", 'exec 9<"$1"; flock 9; touch "$2"; IFS= read -r _', "holder", releaseDir, readyPath]);
    const holderDone = new Promise<void>((resolve, reject) => {
      holder.once("error", reject);
      holder.once("close", (code) => code === 0 ? resolve() : reject(new Error(`lock holder exited ${code}`)));
    });
    await waitForPath(readyPath);

    const publisher = execFile("bash", [path.join(workspaceRoot, "deploy/scripts/publish-capacitor-apk.sh")], {
      env: {
        ...process.env,
        BRAI_ROOT: root,
        BRAI_APK_SOURCE: apkPath,
        BRAI_APK_VERSION: "1",
        BRAI_ANDROID_VERSION_CODE: "2999",
        BRAI_PUBLISHED_AT: "2026-06-15T00:00:00Z",
      },
    });
    const publisherDone = new Promise<void>((resolve, reject) => {
      let stderr = "";
      publisher.stderr?.on("data", (chunk) => { stderr += chunk; });
      publisher.once("error", reject);
      publisher.once("close", (code) => code === 0 ? resolve() : reject(new Error(`publisher exited ${code}: ${stderr}`)));
    });

    try {
      await waitForPath(path.join(releaseDir, `.brai-v1.apk.${publisher.pid}.tmp`));
      expect(fs.existsSync(path.join(releaseDir, "brai-v1.apk"))).toBe(false);
      expect(fs.existsSync(path.join(releaseDir, "releases.json"))).toBe(false);
      holder.stdin?.end("release\n");
      await holderDone;
      await publisherDone;
    } finally {
      holder.stdin?.end("release\n");
      holder.kill();
    }

    await expect(readFile(path.join(releaseDir, "brai-v1.apk"), "utf8")).resolves.toBe("apk-under-lock");
    const releases = JSON.parse(await readFile(path.join(releaseDir, "releases.json"), "utf8"));
    expect(releases.sections.production.file).toBe("brai-v1.apk");
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
        BRAI_APK_VERSION: "1",
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

  it("publishes a Preview APK over the selected release slot", async () => {
    const root = await fixtureRoot("brai-preview-apk-publish-");
    await writeStaticExport(root, "preview-apk");
    await mkdir(path.join(root, "deploy"), { recursive: true });
    await copyFile(
      path.join(workspaceRoot, "deploy/environments.json"),
      path.join(root, "deploy/environments.json"),
    );
    const apkPath = path.join(root, "app-preview.apk");
    await writeFile(apkPath, "preview-apk");

    await execFileAsync("bash", [path.join(workspaceRoot, "deploy/scripts/publish-capacitor-apk.sh")], {
      env: {
        ...process.env,
        BRAI_ROOT: root,
        BRAI_APK_SOURCE: apkPath,
        BRAI_RELEASE_ENV: "a",
        BRAI_APK_VERSION: "2",
        BRAI_ANDROID_VERSION_CODE: "20006",
        BRAI_APK_BUILD_KIND: "preview",
        BRAI_APK_PREVIEW_ITERATION: "6",
        BRAI_PUBLISHED_AT: "2026-06-15T00:00:00Z",
      },
    });

    const index = JSON.parse(await readFile(path.join(root, "deploy/releases/releases.json"), "utf8"));
    const html = await readFile(path.join(root, "deploy/releases/index.html"), "utf8");
    expect(index.sections.a).toMatchObject({
      title: "Preview A",
      applicationId: "world.brightos.brai.preview.a.work",
      file: "brai-a-v2-preview6.apk",
      apkVersion: 2,
      versionCode: 20006,
      releaseKey: "a",
      apkBuildKind: "preview",
      previewIteration: 6,
    });
    expect(html).toContain("<h2>Preview A</h2>");
    expect(html).toContain('<p class="version">v2-preview6</p>');
    expect(html).toContain('<a class="download" href="./brai-a-v2-preview6.apk">Скачать</a>');
    await expect(readFile(path.join(root, "deploy/releases/brai-a-v2-preview6.apk"), "utf8")).resolves.toBe("preview-apk");
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
          BRAI_APK_VERSION: "1",
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

  it("replaces stale browser web trees that cannot be cleaned in place", async () => {
    const root = await fixtureRoot("brai-web-stale-");
    await writeStaticExport(root, "fresh-web");
    const previewRoot = path.join(root, "envs/preview-b");
    const webTarget = path.join(previewRoot, "web");
    const staleDir = path.join(webTarget, "stale");
    await mkdir(staleDir, { recursive: true });
    await writeFile(path.join(staleDir, "old.txt"), "old");
    await chmod(staleDir, 0o555);

    try {
      await execFileAsync("bash", [path.join(workspaceRoot, "deploy/scripts/publish-web.sh")], {
        env: { ...process.env, BRAI_ROOT: root, BRAI_WEB_TARGET: webTarget },
      });
    } finally {
      await chmod(staleDir, 0o755).catch(() => {});
    }

    await execFileAsync("bash", ["-c", `source "$1"; normalize_public_tree "$2"`, "bash", path.join(workspaceRoot, "deploy/scripts/permissions.sh"), previewRoot]);

    await expect(readFile(path.join(webTarget, "index.html"), "utf8")).resolves.toContain("fresh-web");
    await expect(readFile(path.join(webTarget, "stale/old.txt"), "utf8")).rejects.toThrow();
  });

  it("syncs occupied preview OTA manifests from each preview source", async () => {
    const root = await fixtureRoot("brai-preview-ota-sync-");
    const envsRoot = path.join(root, "envs");
    const sourceRoot = path.join(envsRoot, "preview-b/source");
    const previewCommit = "c".repeat(40);
    await writeStaticExport(sourceRoot, "preview-b-content");
    await writeFile(path.join(sourceRoot, ".brai-deploy-branch"), "codex/preview-b\n");
    await writeFile(path.join(sourceRoot, ".brai-deploy-commit"), `${previewCommit}\n`);
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
      "normalize-next-static-export.mjs",
      "resolve-required-apk-version.mjs",
      "write-client-runtime-config.mjs",
    ]) {
      await copyFile(path.join(workspaceRoot, "deploy/scripts", file), path.join(sourceRoot, "deploy/scripts", file));
      if (file.endsWith(".sh")) await chmod(path.join(sourceRoot, "deploy/scripts", file), 0o755);
    }
    await mkdir(path.join(envsRoot, "preview-b/mobile-update"), { recursive: true });
    await writeFile(
      path.join(envsRoot, "preview-slots.json"),
      JSON.stringify({ B: { status: "ready", branch: "codex/preview-b", commit: previewCommit }, queue: [] }),
    );
    await writeFile(
      path.join(envsRoot, "preview-b/mobile-update/manifest.json"),
      JSON.stringify({
        otaVersion: "0.0.67",
        archiveUrl: "https://b.test.brai.one/mobile-update/bundles/0.0.67/bundle.zip",
      }),
    );
    await execFileAsync("bash", [path.join(workspaceRoot, "deploy/scripts/sync-occupied-preview-ota-manifests.sh"), "--local"], {
      env: {
        ...process.env,
        BRAI_ROOT: workspaceRoot,
        BRAI_ENVS_ROOT: envsRoot,
        BRAI_APP_VERSION: "0.0.68",
        BRAI_PROD_DATABASE_URL: "postgres://example.invalid/brai",
        BRAI_BUILD_CLIENT: "false",
        BRAI_TARGET_APK_VERSION: "2999",
        BRAI_PUBLISHED_AT: "2026-07-03T00:00:00Z",
      },
    });

    const manifest = JSON.parse(await readFile(path.join(envsRoot, "preview-b/mobile-update/manifest.json"), "utf8"));
    const runtimeConfig = await readFile(path.join(envsRoot, "preview-b/web/brai-runtime-config.js"), "utf8");
    const syncScript = await readFile(path.join(workspaceRoot, "deploy/scripts/sync-occupied-preview-ota-manifests.sh"), "utf8");
    await expect(readFile(path.join(envsRoot, "preview-b/web/index.html"), "utf8")).resolves.toContain("preview-b-content");
    expect(syncScript).toContain("BRAI_BUILD_CLIENT=false");
    expect(runtimeConfig).toContain('"branch": "codex/preview-b"');
    expect(runtimeConfig).toContain(`"commit": "${previewCommit}"`);
    expect(manifest.otaVersion).toBe("0.0.68");
    expect(manifest.archiveUrl).toBe("https://b.test.brai.one/mobile-update/bundles/0.0.68/bundle.zip");
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
    await expect(readFile(path.join(envsRoot, "preview-status/index.html"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("commits preview APK counters per branch and stable version only after a ready preview", async () => {
    const root = await fixtureRoot("brai-slots-apk-counter-");
    const envsRoot = path.join(root, "envs");
    const env = {
      ...process.env,
      BRAI_ROOT: workspaceRoot,
      BRAI_ENVS_ROOT: envsRoot,
    };
    const slotScript = path.join(workspaceRoot, "deploy/scripts/preview-slots.mjs");

    await execFileAsync("node", [slotScript, "allocate", "codex/one", "abc"], { env });
    await execFileAsync("node", [slotScript, "next-apk-preview", "codex/one", "abc", "2"], { env });
    let registry = JSON.parse(await readFile(path.join(envsRoot, "preview-slots.json"), "utf8"));
    expect(registry.A).toMatchObject({ apk_preview_iteration: 1, apk_version_code: 20001 });
    expect(registry.apk_preview_counter).toBe(0);

    await execFileAsync("node", [slotScript, "failed", "codex/one", "abc"], { env });
    registry = JSON.parse(await readFile(path.join(envsRoot, "preview-slots.json"), "utf8"));
    expect(registry.apk_preview_counter).toBe(0);

    await execFileAsync("node", [slotScript, "allocate", "codex/one", "abc"], { env });
    await execFileAsync("node", [slotScript, "next-apk-preview", "codex/one", "abc", "2"], { env });
    registry = JSON.parse(await readFile(path.join(envsRoot, "preview-slots.json"), "utf8"));
    expect(registry.A).toMatchObject({ apk_preview_iteration: 1, apk_version_code: 20001 });

    await execFileAsync("node", [slotScript, "ready", "codex/one", "abc"], { env });
    registry = JSON.parse(await readFile(path.join(envsRoot, "preview-slots.json"), "utf8"));
    expect(registry.apk_preview_counter).toBe(1);
    expect(registry.apk_preview_counters).toMatchObject({ 2: 1 });
    expect(registry.apk_preview_branch_counters).toMatchObject({ 2: { "codex/one": 1 } });

    registry.apk_preview_counter = 0;
    await writeFile(path.join(envsRoot, "preview-slots.json"), JSON.stringify(registry));
    await execFileAsync("node", [slotScript, "allocate", "codex/two", "def"], { env });
    await execFileAsync("node", [slotScript, "next-apk-preview", "codex/two", "def", "2"], { env });
    registry = JSON.parse(await readFile(path.join(envsRoot, "preview-slots.json"), "utf8"));
    expect(registry.B).toMatchObject({ apk_preview_iteration: 1, apk_version_code: 20001 });
    expect(registry.apk_preview_counter).toBe(1);

    await execFileAsync("node", [slotScript, "ready", "codex/two", "def"], { env });
    registry = JSON.parse(await readFile(path.join(envsRoot, "preview-slots.json"), "utf8"));
    expect(registry.apk_preview_branch_counters).toMatchObject({ 2: { "codex/one": 1, "codex/two": 1 } });

    await execFileAsync("node", [slotScript, "allocate", "codex/two", "def2"], { env });
    await execFileAsync("node", [slotScript, "next-apk-preview", "codex/two", "def2", "2"], { env });
    registry = JSON.parse(await readFile(path.join(envsRoot, "preview-slots.json"), "utf8"));

    expect(registry.B).toMatchObject({ apk_preview_iteration: 2, apk_version_code: 20002 });
    expect(registry.apk_preview_counter).toBe(1);

    await execFileAsync("node", [slotScript, "ready", "codex/two", "def2"], { env });
    registry = JSON.parse(await readFile(path.join(envsRoot, "preview-slots.json"), "utf8"));
    expect(registry.apk_preview_counter).toBe(2);
    expect(registry.apk_preview_counters).toMatchObject({ 2: 2 });
    expect(registry.apk_preview_branch_counters).toMatchObject({ 2: { "codex/one": 1, "codex/two": 2 } });

    await execFileAsync("node", [slotScript, "allocate", "codex/three", "ghi"], { env });
    await execFileAsync("node", [slotScript, "next-apk-preview", "codex/three", "ghi", "3"], { env });
    registry = JSON.parse(await readFile(path.join(envsRoot, "preview-slots.json"), "utf8"));
    let three = Object.values(registry).find((entry: unknown) => (entry as { branch?: string }).branch === "codex/three");
    expect(three).toMatchObject({ apk_preview_iteration: 1, apk_version_code: 30001 });
    await execFileAsync("node", [slotScript, "clear-apk", "codex/three", "ghi"], { env });
    registry = JSON.parse(await readFile(path.join(envsRoot, "preview-slots.json"), "utf8"));
    three = Object.values(registry).find((entry: unknown) => (entry as { branch?: string }).branch === "codex/three");
    expect(three).toMatchObject({ apk_preview_iteration: null, apk_version_code: null, apk_build_kind: "stable" });
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
    expect(html).toContain('<div class="version-row"><p class="version">v1</p><span class="size">');
    expect(html).toContain("0 МБ</span>");
    expect(html).toContain("23 июня 2026, 09:13");
    expect(html).toContain('document.querySelectorAll("time[datetime]")');
    expect(html).not.toContain("МСК");
    expect(html).toContain('<a class="download" href="./brai-v1.apk">Скачать</a>');
    expect(html).toContain('<span class="download" aria-disabled="true">Скачать</span>');
    expect(html).not.toContain("versionCode");
    expect(html).not.toContain("applicationId");
    expect(html).not.toContain("AccessibilityService");
  });

  it("can re-render the release page from releases.json without a new APK publish", async () => {
    const root = await fixtureRoot("brai-release-page-rerender-");
    const releaseDir = path.join(root, "deploy/releases");
    await mkdir(releaseDir, { recursive: true });
    await mkdir(path.join(root, "deploy"), { recursive: true });
    await copyFile(
      path.join(workspaceRoot, "deploy/environments.json"),
      path.join(root, "deploy/environments.json"),
    );
    await writeFile(
      path.join(releaseDir, "releases.json"),
      `${JSON.stringify({
        schemaVersion: 2,
        sections: {
          production: {
            title: "Brai",
            androidApp: "Brai",
            applicationId: "world.brightos.brai",
            releaseKey: "production",
            file: "brai-v7.apk",
            apkVersion: 7,
            versionCode: 7,
            apkBuildKind: "stable",
            previewIteration: null,
            publishedAt: "2026-06-23T09:13:50Z",
            sizeBytes: 20_080_000,
            sha256: "abc",
            capabilities: [],
          },
        },
      }, null, 2)}\n`,
    );

    await execFileAsync("node", [path.join(workspaceRoot, "deploy/scripts/update-release-index.mjs"), "--render-only"], {
      env: { ...process.env, BRAI_ROOT: root, BRAI_RELEASE_TARGET: releaseDir },
    });

    const html = await readFile(path.join(releaseDir, "index.html"), "utf8");
    expect(html).toContain("<h2>Brai</h2>");
    expect(html).toContain('<div class="version-row"><p class="version">v7</p><span class="size">20,08 МБ</span></div>');
    expect(html).toContain('<a class="download" href="./brai-v7.apk">Скачать</a>');
  });

  it("keeps published APK metadata unchanged when staging fails", async () => {
    const root = await fixtureRoot("brai-release-page-atomic-");
    const releaseDir = path.join(root, "deploy/releases");
    await mkdir(releaseDir, { recursive: true });
    await copyFile(path.join(workspaceRoot, "deploy/environments.json"), path.join(root, "deploy/environments.json"));
    await writeFile(path.join(releaseDir, "brai-v2.apk"), "new apk");
    const oldJson = '{"schemaVersion":2,"sections":{}}\n';
    await writeFile(path.join(releaseDir, "releases.json"), oldJson);
    await writeFile(path.join(releaseDir, "index.html"), "old html\n");

    await expect(execFileAsync("node", [
      path.join(workspaceRoot, "deploy/scripts/update-release-index.mjs"),
      "--release", "production",
      "--file", "brai-v2.apk",
      "--apk-version", "2",
      "--version-code", "2",
      "--published-at", "2026-07-11T22:00:00Z",
    ], {
      env: { ...process.env, BRAI_ROOT: root, BRAI_RELEASE_METADATA_FAIL_AFTER_STAGE: "1" },
    })).rejects.toThrow(/injected release metadata failure/);

    expect(await readFile(path.join(releaseDir, "releases.json"), "utf8")).toBe(oldJson);
    expect(await readFile(path.join(releaseDir, "index.html"), "utf8")).toBe("old html\n");

    await expect(execFileAsync("node", [
      path.join(workspaceRoot, "deploy/scripts/update-release-index.mjs"),
      "--release", "production",
      "--file", "brai-v2.apk",
      "--apk-version", "2",
      "--version-code", "2",
      "--published-at", "2026-07-11T22:00:00Z",
    ], {
      env: { ...process.env, BRAI_ROOT: root, BRAI_RELEASE_METADATA_FAIL_AFTER_INDEX: "1" },
    })).rejects.toThrow(/injected release metadata swap failure/);

    expect(await readFile(path.join(releaseDir, "releases.json"), "utf8")).toBe(oldJson);
    expect(await readFile(path.join(releaseDir, "index.html"), "utf8")).toBe("old html\n");
  });
});

async function fixtureRoot(prefix: string) {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  fixtureRoots.push(root);
  return root;
}

async function writeStaticExport(root: string, marker: string) {
  const out = path.join(root, "apps/brai_app/out");
  await mkdir(path.join(out, "_next"), { recursive: true });
  await mkdir(path.join(root, "apps/brai_app/public"), { recursive: true });
  await writeFile(path.join(out, "index.html"), `<main>${marker}</main>`);
  for (const route of appStaticRoutes) {
    await mkdir(path.join(out, route), { recursive: true });
    await writeFile(path.join(out, `${route}.html`), `<main>${marker} ${route} route</main>`);
    await writeFile(path.join(out, route, `__next.${route}.txt`), "rsc");
  }
  await writeFile(path.join(out, "_next/app.js"), "console.log('ok')");
  await writeFile(path.join(out, "version.json"), JSON.stringify({ marker }));
  await writeFile(path.join(root, "apps/brai_app/public/version.json"), JSON.stringify({ version: "9.9.9" }));
}
