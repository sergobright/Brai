import process from "node:process";
import { BrightOsStore } from "../../services/bright_os_api/src/store.js";

const args = parseArgs(process.argv.slice(2));
const store = new BrightOsStore(required(args, "db"));

try {
  store.recordAcceptedBuildVersion({
    prNumber: required(args, "pr-number"),
    sourceBranch: required(args, "source-branch"),
    sourceCommit: required(args, "source-commit"),
    sourceDetails: args["source-details"] || "Accepted dev deployment.",
    targetBranch: required(args, "target-branch"),
    targetCommit: required(args, "target-commit"),
    releasedAtUtc: args["released-at"] || new Date().toISOString(),
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
