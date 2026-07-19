import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const script = new URL("./update-release-index.mjs", import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, "../..");

test("restores a transient Preview APK section to the published stable APK baseline", () => {
  const fixture = releaseFixture({ stableArtifact: true });
  const result = run(fixture.directory, "--restore-stable-preview", "a");

  assert.equal(result.status, 0, result.stderr);
  const releases = JSON.parse(fs.readFileSync(fixture.index, "utf8"));
  assert.deepEqual({
    apkBuildKind: releases.sections.a.apkBuildKind,
    apkVersion: releases.sections.a.apkVersion,
    applicationId: releases.sections.a.applicationId,
    file: releases.sections.a.file,
    previewIteration: releases.sections.a.previewIteration,
    versionCode: releases.sections.a.versionCode,
  }, {
    apkBuildKind: "stable",
    apkVersion: 13,
    applicationId: "world.brightos.brai.preview.a",
    file: "brai-a-v13.apk",
    previewIteration: null,
    versionCode: 13,
  });
  assert.match(fs.readFileSync(path.join(fixture.directory, "index.html"), "utf8"), /brai-a-v13\.apk/);
});

test("does not discard transient metadata when the stable Preview artifact is missing", () => {
  const fixture = releaseFixture({ stableArtifact: false });
  const before = fs.readFileSync(fixture.index, "utf8");
  const result = run(fixture.directory, "--restore-stable-preview", "a");

  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing stable Preview APK/);
  assert.equal(fs.readFileSync(fixture.index, "utf8"), before);
});

function releaseFixture({ stableArtifact }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "brai-release-index-test-"));
  const index = path.join(directory, "releases.json");
  fs.writeFileSync(path.join(directory, "brai-v13.apk"), "production");
  fs.writeFileSync(path.join(directory, "brai-a-v14-preview1.apk"), "transient");
  if (stableArtifact) fs.writeFileSync(path.join(directory, "brai-a-v13.apk"), "stable-a");
  fs.writeFileSync(index, `${JSON.stringify({
    schemaVersion: 2,
    sections: {
      production: {
        applicationId: "world.brightos.brai",
        file: "brai-v13.apk",
        apkVersion: 13,
        versionCode: 13,
        apkBuildKind: "stable",
      },
      a: {
        applicationId: "world.brightos.brai.preview.a.work",
        file: "brai-a-v14-preview1.apk",
        apkVersion: 14,
        versionCode: 140001,
        apkBuildKind: "preview",
        previewIteration: 1,
      },
    },
  }, null, 2)}\n`);
  return { directory, index };
}

function run(releaseDir, ...args) {
  return spawnSync(process.execPath, [script.pathname, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      BRAI_RELEASE_TARGET: releaseDir,
      BRAI_ROOT: repoRoot,
    },
  });
}
