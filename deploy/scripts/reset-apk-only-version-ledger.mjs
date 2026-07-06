#!/usr/bin/env node
import process from "node:process";
import { BraiStore } from "../../services/brai_api/src/store.js";

const args = parseArgs(process.argv.slice(2));
const dbTarget = args["postgres-url"] || process.env.BRAI_DATABASE_URL;
if (!dbTarget) throw new Error("missing --postgres-url or BRAI_DATABASE_URL");

const store = new BraiStore(dbTarget);
try {
  const releasedAtUtc = args["released-at"] || "2026-06-23T09:13:50Z";
  store.db.transaction(() => {
    store.db.prepare("DELETE FROM build_version_refs WHERE version_type_id = 'apk'").run();
    store.db.prepare("DELETE FROM build_versions WHERE version_type_id = 'apk'").run();
    store.db.prepare("DELETE FROM build_version_refs WHERE version_type_id IN ('release', 'canon')").run();
    store.db.prepare("DELETE FROM build_versions WHERE version_type_id IN ('release', 'canon')").run();
    store.db.prepare("DELETE FROM build_version_counters WHERE version_type_id IN ('release', 'canon')").run();
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
  console.log(JSON.stringify({ ok: true, db: "postgres", apk: 1 }, null, 2));
} finally {
  store.close();
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
