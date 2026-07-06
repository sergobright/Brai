import process from "node:process";
import { BraiStore } from "../../services/brai_api/src/store.js";

const args = parseArgs(process.argv.slice(2));
const store = new BraiStore(databaseTarget(args));

try {
  store.recordDeployment({
    environment: required(args, "environment"),
    slot: args.slot || null,
    branch: required(args, "branch"),
    commit: required(args, "commit"),
    domain: required(args, "domain"),
    webOtaVersion: args["web-ota-version"] || null,
    apkVersion: args["apk-version"] || null,
    shortChanges: args["short-changes"] || "Деплой ветки",
    detailedChanges: args["detailed-changes"] || "",
    reason: args.reason || "Автоматическая доставка ветки",
    deployedAtUtc: args["deployed-at"] || new Date().toISOString(),
  });
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

function required(values, key) {
  const value = values[key];
  if (!value) throw new Error(`missing --${key}`);
  return value;
}

function databaseTarget(values) {
  return values["postgres-url"] || process.env.BRAI_DATABASE_URL || required(values, "db");
}
