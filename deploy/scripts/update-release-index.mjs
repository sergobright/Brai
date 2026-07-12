import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { apkReleaseTargetByKey, apkReleaseTargets } from "./apk-release-targets.mjs";
import { renderReleasePage } from "./release-page.mjs";

const args = parseArgs(process.argv.slice(2));
const root = process.env.BRAI_ROOT ?? path.resolve(import.meta.dirname, "../..");
const releaseDir = process.env.BRAI_RELEASE_TARGET ?? path.join(root, "deploy/releases");
const indexPath = path.join(releaseDir, "releases.json");
const targets = apkReleaseTargets(root);
const data = readIndex();
if (args["render-only"] === "true") {
  publishReleaseMetadata(data, false);
} else {
  const releaseKey = required(args, "release");
  const fileName = required(args, "file");
  const filePath = path.join(releaseDir, fileName);
  const target = apkReleaseTargetByKey(releaseKey, root);
  const apkBuildKind = args["build-kind"] === "preview" ? "preview" : "stable";
  const previewIteration = Number(args["preview-iteration"] ?? 0);

  if (!target) throw new Error(`unknown release section: ${releaseKey}`);
  if (!fs.existsSync(filePath)) throw new Error(`missing APK file: ${fileName}`);
  if (apkBuildKind === "preview" && (!Number.isInteger(previewIteration) || previewIteration <= 0)) {
    throw new Error("preview APK release requires --preview-iteration");
  }

  data.sections[releaseKey] = {
    ...sectionDefaults(target),
    title: apkBuildKind === "preview" ? previewTitle(target) : target.androidApp,
    applicationId: applicationIdForBuild(target, apkBuildKind),
    file: fileName,
    apkVersion: Number(required(args, "apk-version")),
    versionCode: Number(required(args, "version-code")),
    releaseKey,
    apkBuildKind,
    previewIteration: apkBuildKind === "preview" ? previewIteration : null,
    publishedAt: required(args, "published-at"),
    sizeBytes: fs.statSync(filePath).size,
    sha256: sha256(filePath),
    capabilities: apkCapabilities(),
  };

  publishReleaseMetadata(data, true);
}

function readIndex() {
  const existing = fs.existsSync(indexPath) ? JSON.parse(fs.readFileSync(indexPath, "utf8")) : {};
  return {
    schemaVersion: 2,
    sections: Object.fromEntries(
      targets.map((target) => [
        target.releaseKey,
        { ...sectionDefaults(target), ...(existing.sections?.[target.releaseKey] ?? {}) },
      ]),
    ),
  };
}

function sectionDefaults(target) {
  return {
    title: target.androidApp,
    androidApp: target.androidApp,
    applicationId: target.applicationId,
    releaseKey: target.releaseKey,
    file: null,
    apkVersion: null,
    versionCode: null,
    apkBuildKind: "stable",
    previewIteration: null,
    publishedAt: null,
    sizeBytes: null,
    sha256: null,
    capabilities: apkCapabilities(),
  };
}

function applicationIdForBuild(target, apkBuildKind) {
  return apkBuildKind === "preview" ? `${target.applicationId}.work` : target.applicationId;
}

function previewTitle(target) {
  const key = String(target.releaseKey ?? "").toUpperCase();
  return key.length === 1 ? `Preview ${key}` : target.androidApp;
}

function apkCapabilities() {
  return [
    "AccessibilityService для доступа к экрану и будущих сценариев скриншотов.",
    "SYSTEM_ALERT_WINDOW для плавающих кнопок поверх других приложений.",
    "Уведомления и foreground service для постоянных сценариев.",
    "RECORD_AUDIO и foreground microphone service для будущей записи с микрофона.",
    "MediaProjection foreground service для будущего захвата экрана и системного аудио там, где Android/ROM разрешает это.",
  ];
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index];
    if (!key?.startsWith("--")) throw new Error(`invalid argument: ${key}`);
    const next = values[index + 1];
    if (next && !next.startsWith("--")) {
      parsed[key.slice(2)] = next;
      index += 1;
    } else {
      parsed[key.slice(2)] = "true";
    }
  }
  return parsed;
}

function required(values, key) {
  const value = values[key];
  if (!value) throw new Error(`missing --${key}`);
  return value;
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function publishReleaseMetadata(value, includeIndex) {
  fs.mkdirSync(releaseDir, { recursive: true });
  const suffix = `${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  const stagedIndex = path.join(releaseDir, `.releases.json.${suffix}`);
  const stagedHtml = path.join(releaseDir, `.index.html.${suffix}`);
  const backupIndex = path.join(releaseDir, `.releases.json.${suffix}.bak`);
  const backupHtml = path.join(releaseDir, `.index.html.${suffix}.bak`);
  const htmlPath = path.join(releaseDir, "index.html");
  try {
    if (includeIndex) {
      fs.writeFileSync(stagedIndex, `${JSON.stringify(value, null, 2)}\n`);
      chmodPublicFile(stagedIndex);
    }
    fs.writeFileSync(stagedHtml, renderReleasePage(value));
    chmodPublicFile(stagedHtml);
    if (process.env.BRAI_RELEASE_METADATA_FAIL_AFTER_STAGE === "1") throw new Error("injected release metadata failure");
    if (includeIndex && fs.existsSync(indexPath)) fs.renameSync(indexPath, backupIndex);
    if (fs.existsSync(htmlPath)) fs.renameSync(htmlPath, backupHtml);
    try {
      if (includeIndex) fs.renameSync(stagedIndex, indexPath);
      if (process.env.BRAI_RELEASE_METADATA_FAIL_AFTER_INDEX === "1") throw new Error("injected release metadata swap failure");
      fs.renameSync(stagedHtml, htmlPath);
    } catch (error) {
      if (includeIndex) fs.rmSync(indexPath, { force: true });
      fs.rmSync(htmlPath, { force: true });
      if (includeIndex && fs.existsSync(backupIndex)) fs.renameSync(backupIndex, indexPath);
      if (fs.existsSync(backupHtml)) fs.renameSync(backupHtml, htmlPath);
      throw error;
    }
  } finally {
    fs.rmSync(stagedIndex, { force: true });
    fs.rmSync(stagedHtml, { force: true });
    fs.rmSync(backupIndex, { force: true });
    fs.rmSync(backupHtml, { force: true });
  }
}

function chmodPublicFile(filePath) {
  fs.chmodSync(filePath, 0o664);
}
