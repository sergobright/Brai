#!/usr/bin/env node
import process from "node:process";
import { BrightOsStore } from "../../services/bright_os_api/src/store.js";

const args = parseArgs(process.argv.slice(2));
const appVersion = required(args, "version");
const versionCode = required(args, "version-code");
const targetBranch = required(args, "target-branch");
const targetCommit = required(args, "target-commit");
const apkVersion = apkCounter(appVersion);
const store = new BrightOsStore(required(args, "db"));

try {
  const existing = store.findBuildVersionByTargetCommit({ targetBranch, targetCommit, versionTypeId: "apk" });
  if (existing && existing.version !== apkVersion) {
    throw new Error(`target ${targetBranch}@${targetCommit} already has apk ${existing.version}, not ${apkVersion}`);
  }
  const latest = store.latestVersion("apk");
  if (!existing && latest && latest.version >= apkVersion) {
    throw new Error(`apk ${apkVersion} is not above latest apk ${latest.version}`);
  }
  const row = store.recordShippedApkVersion({
    version: apkVersion,
    versionCode,
    sourceBranch: args["source-branch"] || null,
    sourceCommit: args["source-commit"] || null,
    targetBranch,
    targetCommit,
    releasedAtUtc: args["released-at"] || new Date().toISOString(),
  });
  console.log(`${row.versionTypeId} ${row.version}`);
} finally {
  store.close();
}

function apkCounter(version) {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(version)) throw new Error(`Invalid Bright OS X.Y.Z.S version: ${version}`);
  return Number(version.split(".")[3]);
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

function required(values, key) {
  const value = values[key];
  if (!value) throw new Error(`missing --${key}`);
  return value;
}
