#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { BraiStore } from "../../services/brai_api/src/store.js";

const args = parseArgs(process.argv.slice(2));
const dbPath = args.db || process.env.BRAI_DB;
if (!dbPath) throw new Error("missing --db or BRAI_DB");

const store = new BraiStore(dbPath);
try {
  const releasedAtUtc = args["released-at"] || "2026-06-23T09:13:50Z";
  const backupPath = await backupSqlite(store, dbPath, args["backup-dir"]);
  store.db.transaction(() => {
    store.db.prepare("DELETE FROM build_version_refs WHERE version_type_id = 'apk'").run();
    store.db.prepare("DELETE FROM build_versions WHERE version_type_id = 'apk'").run();
    store.db.prepare("DELETE FROM build_version_refs WHERE version_type_id IN ('release', 'canon')").run();
    store.db.prepare("DELETE FROM build_versions WHERE version_type_id IN ('release', 'canon')").run();
    store.db.prepare("DELETE FROM version_types WHERE id IN ('release', 'canon')").run();
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
  console.log(JSON.stringify({ ok: true, db: dbPath, backup: backupPath, apk: 1 }, null, 2));
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
