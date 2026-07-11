#!/usr/bin/env node
import fs from "node:fs";
import process from "node:process";

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

async function check(reason) {
  if (running) return;
  running = true;
  try {
    log(`SocratiCode ensure started (${reason})`);
    await runSocraticodeCheck({ mode: "ensure", root, report: log });
    writeState({ ok: true, reason });
    log(`SocratiCode ensure OK (${reason})`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeState({ ok: false, reason, error: message });
    console.error(`[${new Date().toISOString()}] SocratiCode ensure failed (${reason}): ${message}`);
  } finally {
    running = false;
  }
}

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
