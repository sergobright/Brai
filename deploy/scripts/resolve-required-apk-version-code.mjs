import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.env.BRIGHT_OS_ROOT ?? path.resolve(import.meta.dirname, "../..");
const releaseDir = process.env.BRIGHT_OS_RELEASE_TARGET ?? path.join(root, "deploy/releases");
const environment = process.argv[2] ?? process.env.NEXT_PUBLIC_BRIGHT_OS_ENVIRONMENT ?? process.env.BRIGHT_OS_ENVIRONMENT ?? "prod";
const { environments } = JSON.parse(fs.readFileSync(path.join(root, "deploy/environments.json"), "utf8"));
const env = environments[environment];
if (!env) throw new Error(`unknown environment: ${environment}`);

const releaseIndex = path.join(releaseDir, "releases.json");
const data = fs.existsSync(releaseIndex) ? JSON.parse(fs.readFileSync(releaseIndex, "utf8")) : { sections: {} };
const candidates = [env.releaseKey, "production"].filter(Boolean);
for (const key of candidates) {
  const versionCode = Number(data.sections?.[key]?.versionCode);
  if (Number.isInteger(versionCode) && versionCode > 0) {
    console.log(String(versionCode));
    process.exit(0);
  }
}

console.log("1");
