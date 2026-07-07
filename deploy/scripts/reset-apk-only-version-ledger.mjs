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
      store.db.prepare("DELETE FROM build_version_refs WHERE version_type_id = 'apk' AND version > 2").run();
      store.db.prepare("DELETE FROM build_versions WHERE version_type_id = 'apk' AND version > 2").run();
      try {
        store.db.prepare("UPDATE build_version_counters SET last_version = 2 WHERE version_type_id = 'apk'").run();
      } catch (error) {
      if (!String(error?.message ?? error).includes("build_version_counters")) throw error;
    }
    store.upsertBuildVersion({
      versionTypeId: "apk",
      version: 2,
      includedInVersionId: null,
      shortChanges: "Актуальная публичная APK-сборка v2.",
      detailedChanges: "APK v2 использует Android versionName 2 и versionCode 2. В сборке объявлены AccessibilityService для доступа к экрану, overlay permission для плавающих кнопок, уведомления, микрофон и foreground service для MediaProjection/системного аудио там, где Android или ROM разрешает такие возможности.",
      reason: "Ошибочные APK выше v2 удаляются, актуальная APK-линейка Brai продолжается с v2.",
      releasedAtUtc,
    });
  })();
  console.log(JSON.stringify({ ok: true, db: "postgres", apk: 2 }, null, 2));
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
