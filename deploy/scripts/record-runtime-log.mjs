#!/usr/bin/env node
import process from "node:process";
import { BraiStore } from "../../services/brai_api/src/store.js";

const args = parseArgs(process.argv.slice(2));
const databaseUrl = args["postgres-url"] || process.env.BRAI_DATABASE_URL || process.env.BRAI_PROD_DATABASE_URL || process.env.PROD_POSTGRES_URL || "";
if (!databaseUrl) process.exit(0);

const store = new BraiStore(databaseUrl);
try {
  store.recordLog({
    service: args.service || "brai-ops",
    source: required(args, "source"),
    operation: required(args, "operation"),
    status: args.status || "done",
    severityText: args.severity || (args.status === "failed" ? "ERROR" : "INFO"),
    reason: args.reason || null,
    message: args.message || "",
    durationMs: integerArg(args["duration-ms"]),
    traceId: args["trace-id"] || null,
    jsonData: boundedJson(args.json || "{}"),
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

function integerArg(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function boundedJson(text) {
  const parsed = JSON.parse(text || "{}");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("--json must be an object");
  const bytes = Buffer.byteLength(JSON.stringify(parsed));
  return bytes <= 4096 ? parsed : { truncated: true, original_bytes: bytes };
}
