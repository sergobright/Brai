#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { runSocraticodeCheck } from "./brai-socraticode-preflight.mjs";

const DEFAULT_ROOT = "/srv/projects/brai";
const root = process.env.BRAI_SOCRATICODE_ROOT || process.env.BRAI_ROOT || DEFAULT_ROOT;
const intervalMs = Number(process.env.BRAI_SOCRATICODE_WATCHER_INTERVAL_MS || 60_000);
const stateFile = process.env.BRAI_SOCRATICODE_WATCHER_STATE || "/tmp/brai-socraticode-watcher-state.json";

let running = false;

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function writeState(state) {
  fs.writeFileSync(stateFile, `${JSON.stringify({ root, checkedAt: new Date().toISOString(), ...state }, null, 2)}\n`);
}

export async function runWatcherCheck({ reason, root, report, runCheck = runSocraticodeCheck }) {
  const mode = reason === "startup" ? "ensure" : "preflight";
  await runCheck({ mode, root, report });
  return { mode };
}

async function check(reason) {
  if (running) return;
  running = true;
  try {
    const result = await runWatcherCheck({ reason, root, report: log });
    writeState({ ok: true, reason, mode: result.mode });
    log(`SocratiCode ${result.mode} OK (${reason})`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const mode = reason === "startup" ? "ensure" : "preflight";
    writeState({ ok: false, reason, mode, error: message });
    console.error(`[${new Date().toISOString()}] SocratiCode ${mode} failed (${reason}): ${message}`);
  } finally {
    running = false;
  }
}

async function main() {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      log(`received ${signal}, exiting`);
      process.exit(0);
    });
  }

  await check("startup");
  setInterval(() => {
    void check("timer");
  }, intervalMs);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await main();
}
