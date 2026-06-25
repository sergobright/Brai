import process from "node:process";
import { BrightOsStore } from "../../services/bright_os_api/src/store.js";

const args = parseArgs(process.argv.slice(2));
const store = new BrightOsStore(required(args, "db"));

try {
  store.recordDeployment({
    environment: required(args, "environment"),
    slot: args.slot || null,
    branch: required(args, "branch"),
    commit: required(args, "commit"),
    domain: required(args, "domain"),
    webOtaVersion: args["web-ota-version"] || null,
    apkVersion: args["apk-version"] || null,
    shortChanges: args["short-changes"] || "Branch deployment",
    detailedChanges: args["detailed-changes"] || "",
    reason: args.reason || "Automated branch delivery",
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
