#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { BraiStore } from "../../services/brai_api/src/store.js";
import { isPostgresUrl } from "../../services/brai_api/src/postgres-sync-db.js";

const args = parseArgs(process.argv.slice(2));
const dbTarget = args["postgres-url"] || process.env.BRAI_DATABASE_URL || args.db || process.env.BRAI_DB;
if (!dbTarget) throw new Error("missing --postgres-url, BRAI_DATABASE_URL, --db, or BRAI_DB");

const store = new BraiStore(dbTarget);
try {
  const releasedAtUtc = args["released-at"] || "2026-06-23T09:13:50Z";
  const backupPath = isPostgresUrl(dbTarget) ? null : await backupSqlite(store, dbTarget, args["backup-dir"]);
  store.db.transaction(() => {
    store.db.prepare("DELETE FROM build_version_refs WHERE version_type_id = 'apk'").run();
    store.db.prepare("DELETE FROM build_versions WHERE version_type_id = 'apk'").run();
    store.db.prepare("DELETE FROM build_version_refs WHERE version_type_id IN ('release', 'canon')").run();
    store.db.prepare("DELETE FROM build_versions WHERE version_type_id IN ('release', 'canon')").run();
    store.db.prepare("DELETE FROM version_types WHERE id IN ('release', 'canon')").run();
    try {
      store.db.prepare("UPDATE build_version_counters SET last_version = 0 WHERE version_type_id = 'apk'").run();
    } catch (error) {
      if (!String(error?.message ?? error).includes("build_version_counters")) throw error;
    }
    store.upsertBuildVersion({
      versionTypeId: "apk",
      version: 1,
      includedInVersionId: null,
      shortChanges: "Первичная публичная APK-сборка.",
      detailedChanges: "APK v1 использует Android versionName 1 и versionCode 1. В сборке объявлены AccessibilityService для доступа к экрану, overlay permission для плавающих кнопок, уведомления, микрофон и foreground service для MediaProjection/системного аудио там, где Android или ROM разрешает такие возможности.",
      reason: "Старые APK полностью удаляются, APK-линейка Brai начинается заново с v1.",
      releasedAtUtc,
    });
  })();
  console.log(JSON.stringify({ ok: true, db: isPostgresUrl(dbTarget) ? "postgres" : dbTarget, backup: backupPath, apk: 1 }, null, 2));
} finally {
  store.close();
}

async function backupSqlite(store, dbPath, backupDir) {
  const backupRoot = backupDir || path.join(path.dirname(dbPath), "backups");
  fs.mkdirSync(backupRoot, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(backupRoot, `${path.basename(dbPath)}.apk-reset-${stamp}.bak`);
  await store.db.backup(backupPath);
  return backupPath;
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    if (!key?.startsWith("--")) throw new Error(`invalid argument: ${key}`);
    parsed[key.slice(2)] = values[index + 1] ?? "";
  }
  return parsed;
}
