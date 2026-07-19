import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const source = new URL("./build-nonproduction-apks.sh", import.meta.url);

test("non-production APK builds inherit the published Production baseline", () => {
  const fixture = createFixture();
  const result = runFixture(fixture);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readFileSync(fixture.log, "utf8").trim().split("\n"), [
    "dev:13:false",
    "previewA:13:false",
    "previewB:13:false",
    "previewC:13:false",
    "previewD:13:false",
    "previewE:13:false",
  ]);
});

test("non-production APK builds reject a baseline that differs from Production", () => {
  const fixture = createFixture();
  const result = runFixture(fixture, { BRAI_APK_VERSION: "12" });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Requested APK baseline 12 does not match published Production 13/);
  assert.equal(fs.existsSync(fixture.log), false);
});

function createFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "brai-nonprod-apk-test-"));
  const script = path.join(directory, "build-nonproduction-apks.sh");
  const resolver = path.join(directory, "resolve-required-apk-version.mjs");
  const builder = path.join(directory, "build-android-env-apk.sh");
  const log = path.join(directory, "builds.log");

  fs.copyFileSync(source, script);
  fs.writeFileSync(resolver, 'console.log("13");\n');
  fs.writeFileSync(builder, [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    'printf "%s:%s:%s\\n" "$1" "$BRAI_APK_VERSION" "$BRAI_BUILD_CLIENT" >>"$BRAI_TEST_LOG"',
    "",
  ].join("\n"));
  fs.chmodSync(script, 0o755);
  fs.chmodSync(builder, 0o755);

  return { directory, script, log };
}

function runFixture(fixture, extraEnv = {}) {
  return spawnSync(fixture.script, {
    encoding: "utf8",
    env: {
      ...process.env,
      BRAI_TEST_LOG: fixture.log,
      ...extraEnv,
    },
  });
}
