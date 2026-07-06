import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveAppVersion } from "./resolve-app-version.mjs";

const requireFromApi = createRequire(new URL("../../services/brai_api/package.json", import.meta.url));
const Database = requireFromApi("better-sqlite3");

test("OTA version follows the build ledger before stale deployed manifests", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "brai-version-"));
  try {
    const dbPath = path.join(tmp, "brai.sqlite");
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE build_versions (version_type_id TEXT NOT NULL, version INTEGER NOT NULL);
      INSERT INTO build_versions (version_type_id, version) VALUES ('build', 66), ('apk', 1);
    `);
    db.close();

    const prodWebVersionJson = path.join(tmp, "version.json");
    fs.writeFileSync(prodWebVersionJson, `${JSON.stringify({ version: "0.0.63" })}\n`);

    const mobileTarget = path.join(tmp, "mobile-update");
    fs.mkdirSync(path.join(mobileTarget, "bundles", "0.0.63"), { recursive: true });
    fs.writeFileSync(path.join(mobileTarget, "manifest.json"), `${JSON.stringify({ otaVersion: "0.0.63" })}\n`);
    fs.writeFileSync(path.join(mobileTarget, "bundles", "0.0.63", "metadata.json"), `${JSON.stringify({ otaVersion: "0.0.63" })}\n`);

    assert.equal(resolveAppVersion({ environment: "prod", db: dbPath, prodWebVersionJson, mobileTarget, root: tmp }), "0.0.66");
    assert.equal(resolveAppVersion({ environment: "preview-a", prodDb: dbPath, prodWebVersionJson, mobileTarget, root: tmp }), "0.0.66");
    assert.equal(resolveAppVersion({ environment: "preview-a", prodDb: dbPath, prodWebVersionJson, mobileTarget, nextOta: true, root: tmp }), "0.0.67");
    assert.equal(resolveAppVersion({ kind: "apk", db: dbPath }), "1");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("next preview OTA version advances past the current slot manifest", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "brai-version-next-preview-"));
  try {
    const dbPath = path.join(tmp, "brai.sqlite");
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE build_versions (version_type_id TEXT NOT NULL, version INTEGER NOT NULL);
      INSERT INTO build_versions (version_type_id, version) VALUES ('build', 80);
    `);
    db.close();

    const mobileTarget = path.join(tmp, "mobile-update");
    fs.mkdirSync(mobileTarget, { recursive: true });
    fs.writeFileSync(path.join(mobileTarget, "manifest.json"), `${JSON.stringify({ otaVersion: "0.0.81" })}\n`);

    assert.equal(resolveAppVersion({ environment: "preview-e", prodDb: dbPath, mobileTarget, nextOta: true, root: tmp }), "0.0.82");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("OTA version resolution fails instead of falling back to stale public metadata", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "brai-version-missing-"));
  try {
    fs.mkdirSync(path.join(tmp, "apps/brai_app/public"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "apps/brai_app/public/version.json"), `${JSON.stringify({ version: "0.0.10" })}\n`);

    assert.throws(
      () => resolveAppVersion({ environment: "prod", root: tmp, explicit: "" }),
      /Unable to resolve Brai X\.Y\.Z OTA version/,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
