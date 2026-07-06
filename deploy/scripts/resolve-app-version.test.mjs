import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { BraiStore } from "../../services/brai_api/src/store.js";
import { createTestDatabase } from "../../services/brai_api/test-support/api.js";
import { resolveAppVersion, resolveAppVersionAsync } from "./resolve-app-version.mjs";

test("explicit versions resolve without database access", () => {
  assert.equal(resolveAppVersion({ explicit: "1.2.3" }), "1.2.3");
  assert.equal(resolveAppVersion({ kind: "apk", explicit: "7" }), "7");
});

test("version resolution fails without Supabase/Postgres ledger URL", async () => {
  await assert.rejects(
    () => resolveAppVersionAsync({ environment: "prod", explicit: "" }),
    /BRAI_DATABASE_URL or BRAI_PROD_DATABASE_URL is required/
  );
  await assert.rejects(
    () => resolveAppVersionAsync({ kind: "apk", explicit: "" }),
    /BRAI_DATABASE_URL is required to resolve Brai APK version/
  );
});

test("OTA version follows the Postgres build ledger before stale deployed manifests", { skip: !process.env.BRAI_TEST_DATABASE_URL }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "brai-version-"));
  const database = await createTestDatabase();
  const store = new BraiStore(database.url);
  try {
    store.upsertBuildVersion({
      versionTypeId: "build",
      version: 66,
      includedInVersionId: null,
      shortChanges: "Production build.",
      detailedChanges: "Production build.",
      reason: "Test.",
      releasedAtUtc: "2026-07-06T00:00:00.000Z"
    });

    const prodWebVersionJson = path.join(tmp, "version.json");
    fs.writeFileSync(prodWebVersionJson, `${JSON.stringify({ version: "0.0.63" })}\n`);

    const mobileTarget = path.join(tmp, "mobile-update");
    fs.mkdirSync(path.join(mobileTarget, "bundles", "0.0.63"), { recursive: true });
    fs.writeFileSync(path.join(mobileTarget, "manifest.json"), `${JSON.stringify({ otaVersion: "0.0.63" })}\n`);
    fs.writeFileSync(path.join(mobileTarget, "bundles", "0.0.63", "metadata.json"), `${JSON.stringify({ otaVersion: "0.0.63" })}\n`);

    assert.equal(await resolveAppVersionAsync({ environment: "prod", postgresUrl: database.url, prodWebVersionJson, mobileTarget }), "0.0.66");
    assert.equal(await resolveAppVersionAsync({ environment: "preview-a", prodPostgresUrl: database.url, prodWebVersionJson, mobileTarget, nextOta: true }), "0.0.67");
    assert.equal(await resolveAppVersionAsync({ kind: "apk", postgresUrl: database.url }), "1");
  } finally {
    store.close();
    await database.drop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
