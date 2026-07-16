import fs from "node:fs";
import path from "node:path";
import process from "node:process";

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = process.env.BRAI_ROOT ?? path.resolve(import.meta.dirname, "../..");
  writeClientRuntimeConfig(root, process.env);
}

export function writeClientRuntimeConfig(root, env = process.env) {
  const outDir = path.join(root, "apps/brai_app/out");
  if (!fs.existsSync(outDir)) {
    throw new Error(`Missing static export: ${outDir}`);
  }

  const filePath = path.join(outDir, "brai-runtime-config.js");
  fs.writeFileSync(filePath, runtimeConfigSource(runtimeConfigFromEnv(env)));
  return filePath;
}

export function runtimeConfigFromEnv(env = process.env) {
  return {
    appVersion: value(env.BRAI_APP_VERSION, env.NEXT_PUBLIC_BRAI_APP_VERSION, "unknown"),
    environment: value(env.NEXT_PUBLIC_BRAI_ENVIRONMENT, env.BRAI_ENVIRONMENT, "prod"),
    previewSlot: value(env.NEXT_PUBLIC_BRAI_PREVIEW_SLOT, ""),
    branch: value(env.NEXT_PUBLIC_BRAI_BRANCH, env.BRAI_BRANCH, ""),
    commit: value(env.NEXT_PUBLIC_BRAI_COMMIT, env.BRAI_COMMIT, ""),
    productVersion: positiveInteger(env.NEXT_PUBLIC_BRAI_PRODUCT_VERSION, env.BRAI_PRODUCT_VERSION),
    webApiBase: value(env.NEXT_PUBLIC_BRAI_API, "/api"),
    androidApiBase: value(env.NEXT_PUBLIC_BRAI_ANDROID_API, "https://api.brai.one"),
    otaChannel: value(env.NEXT_PUBLIC_BRAI_OTA_CHANNEL, "app.brai.one/mobile-update"),
  };
}

export function runtimeConfigSource(config) {
  return `window.__BRAI_RUNTIME_CONFIG__ = ${safeJson(config)};\n`;
}

function value(...candidates) {
  return candidates.find((candidate) => typeof candidate === "string" && candidate.length > 0) ?? "";
}

function positiveInteger(...candidates) {
  const parsed = Number(value(...candidates));
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function safeJson(value) {
  return JSON.stringify(value, null, 2)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}
