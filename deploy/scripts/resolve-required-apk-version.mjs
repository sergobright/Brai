import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { apkReleaseTargetByEnvironment } from "./apk-release-targets.mjs";

const root = process.env.BRAI_ROOT ?? path.resolve(import.meta.dirname, "../..");
const releaseDir = process.env.BRAI_RELEASE_TARGET ?? path.join(root, "deploy/releases");
const environment = process.argv[2] ?? process.env.NEXT_PUBLIC_BRAI_ENVIRONMENT ?? process.env.BRAI_ENVIRONMENT ?? "prod";
const field = process.argv[3] ?? "apkVersion";
const target = apkReleaseTargetByEnvironment(environment, root);
if (!target) throw new Error(`unknown environment: ${environment}`);

const releaseIndex = path.join(releaseDir, "releases.json");
const data = fs.existsSync(releaseIndex) ? JSON.parse(fs.readFileSync(releaseIndex, "utf8")) : { sections: {} };
const candidates = [target.releaseKey, "production"].filter(Boolean);
const section = candidates.map((key) => data.sections?.[key]).find((candidate) => candidate?.file) ?? null;
if (field !== "apkVersion") {
  const value = resolveField(section, target.releaseKey, field);
  console.log(value == null ? "" : String(value));
  process.exit(0);
}
for (const key of candidates) {
  const apkVersion = Number(data.sections?.[key]?.apkVersion ?? data.sections?.[key]?.version);
  if (Number.isInteger(apkVersion) && apkVersion > 0) {
    console.log(String(apkVersion));
    process.exit(0);
  }
}

console.log("1");

function resolveField(section, releaseKey, key) {
  if (key === "releaseKey") return releaseKey;
  if (key === "buildKind") return section?.apkBuildKind ?? "stable";
  if (key === "previewIteration") return section?.previewIteration ?? "";
  if (key === "versionCode") return section?.versionCode ?? section?.apkVersion ?? "";
  throw new Error(`unknown APK metadata field: ${key}`);
}
