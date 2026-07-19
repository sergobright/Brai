import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { BraiStore } from "../../services/brai_api/src/store.js";
import { createTestDatabase } from "../../services/brai_api/test-support/api.js";
import { productAncestorCommits, resolveAppVersion, resolveAppVersionAsync } from "./resolve-app-version.mjs";

test("explicit versions resolve without database access", () => {
  assert.equal(resolveAppVersion({ explicit: "1.2.3" }), "1.2.3");
  assert.equal(resolveAppVersion({ kind: "apk", explicit: "7" }), "7");
  assert.equal(resolveAppVersion({ kind: "product", explicit: "148" }), "148");
  assert.equal(resolveAppVersion({ kind: "product", explicit: "" }), "");
});

test("Product ancestor commit input is explicit and validated", () => {
  assert.deepEqual(productAncestorCommits(`${"a".repeat(40)},${"B".repeat(40)}`), ["a".repeat(40), "B".repeat(40)]);
  assert.deepEqual(productAncestorCommits(""), []);
  assert.throws(() => productAncestorCommits("not-a-commit"), /Invalid Brai Product ancestor commits/);
});

test("client artifact detection imports without API dependencies", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "brai-version-import-"));
  try {
    const scriptDir = path.join(tmp, "deploy/scripts");
    const apiDir = path.join(tmp, "services/brai_api");
    fs.mkdirSync(scriptDir, { recursive: true });
    fs.mkdirSync(apiDir, { recursive: true });
    fs.copyFileSync(path.join(import.meta.dirname, "resolve-app-version.mjs"), path.join(scriptDir, "resolve-app-version.mjs"));
    fs.writeFileSync(path.join(apiDir, "package.json"), '{"type":"module"}\n');

    const result = spawnSync(process.execPath, [
      "--input-type=module",
      "-e",
      "const { clientArtifactChanged } = await import('./deploy/scripts/resolve-app-version.mjs'); console.log(clientArtifactChanged({ baseCommit: '' }));",
    ], { cwd: tmp, encoding: "utf8" });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "false");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("OTA version resolution fails without published artifact metadata", async () => {
  await assert.rejects(
    () => resolveAppVersionAsync({ environment: "prod", explicit: "" }),
    /provide published web\/mobile metadata/
  );
  await assert.rejects(
    () => resolveAppVersionAsync({ kind: "apk", explicit: "" }),
    /BRAI_DATABASE_URL is required to resolve Brai APK version/
  );
});

test("OTA version uses the already resolved Product version as its deployment floor", async () => {
  assert.equal(await resolveAppVersionAsync({
    environment: "prod",
    explicit: "",
    productVersion: "152",
    clientArtifactChanged: "true",
  }), "0.0.153");
  assert.equal(await resolveAppVersionAsync({
    environment: "prod",
    explicit: "",
    productVersion: "152",
    clientArtifactChanged: "false",
  }), "0.0.152");
});

test("OTA version uses published artifacts with the accepted Product version as a downgrade floor", { skip: !process.env.BRAI_TEST_DATABASE_URL }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "brai-version-"));
  const database = await createTestDatabase();
  const store = new BraiStore(database.url);
  const acceptedProduct66 = "a".repeat(40);
  const newerUnrelatedProduct = "b".repeat(40);
  try {
    store.upsertBuildVersion({
      versionTypeId: "build",
      version: 66,
      includedInVersionId: null,
      shortChanges: "Production build.",
      detailedChanges: "Production build.",
      reason: "Test.",
      releasedAtUtc: "2026-07-06T00:00:00.000Z",
      targetBranch: "main",
      targetCommit: acceptedProduct66
    });
    store.upsertBuildVersion({
      versionTypeId: "build",
      version: 67,
      includedInVersionId: null,
      shortChanges: "Unrelated production build.",
      detailedChanges: "Unrelated production build.",
      reason: "Test.",
      releasedAtUtc: "2026-07-07T00:00:00.000Z",
      targetBranch: "main",
      targetCommit: newerUnrelatedProduct
    });

    const prodWebVersionJson = path.join(tmp, "version.json");
    fs.writeFileSync(prodWebVersionJson, `${JSON.stringify({ version: "0.0.63" })}\n`);

    const mobileTarget = path.join(tmp, "mobile-update");
    fs.mkdirSync(path.join(mobileTarget, "bundles", "0.0.63"), { recursive: true });
    fs.writeFileSync(path.join(mobileTarget, "manifest.json"), `${JSON.stringify({ otaVersion: "0.0.63" })}\n`);
    fs.writeFileSync(path.join(mobileTarget, "bundles", "0.0.63", "metadata.json"), `${JSON.stringify({ otaVersion: "0.0.63" })}\n`);

    assert.equal(await resolveAppVersionAsync({ environment: "prod", postgresUrl: database.url, prodWebVersionJson, mobileTarget }), "0.0.63");
    assert.equal(await resolveAppVersionAsync({ environment: "prod", prodWebVersionJson, mobileTarget, clientArtifactChanged: "true" }), "0.0.64");
    assert.equal(await resolveAppVersionAsync({
      environment: "preview-a",
      prodPostgresUrl: database.url,
      prodWebVersionJson,
      mobileTarget,
      nextOta: true,
      targetCommit: acceptedProduct66,
    }), "0.0.67");
    await assert.rejects(
      () => resolveAppVersionAsync({ environment: "prod", prodWebVersionJson, mobileTarget, clientArtifactChanged: "yes" }),
      /invalid client artifact change hint/,
    );
    assert.equal(await resolveAppVersionAsync({ environment: "preview-a", prodPostgresUrl: database.url, prodWebVersionJson, mobileTarget, nextOta: true }), "0.0.64");
    assert.equal(await resolveAppVersionAsync({ kind: "apk", postgresUrl: database.url }), "2");
    assert.equal(await resolveAppVersionAsync({ kind: "product", postgresUrl: database.url, targetCommit: acceptedProduct66 }), "66");
    assert.equal(await resolveAppVersionAsync({ kind: "product", postgresUrl: database.url, targetCommit: "unknown-product" }), "");
    assert.equal(await resolveAppVersionAsync({
      kind: "product",
      postgresUrl: database.url,
      ancestorCommits: `${"c".repeat(40)},${acceptedProduct66}`,
    }), "66");
  } finally {
    store.close();
    await database.drop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
