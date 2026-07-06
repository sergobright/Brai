import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const previewKeys = ["a", "b", "c", "d", "e"];

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const root = process.env.BRAI_ROOT ?? path.resolve(import.meta.dirname, "../..");
  const [releaseKey, ...fields] = process.argv.slice(2);
  const target = apkReleaseTargetByKey(releaseKey, root);
  if (!target) throw new Error(`unknown APK release target: ${releaseKey}`);
  for (const field of fields.length ? fields : ["releaseKey", "androidFlavor"]) {
    console.log(target[field] ?? "");
  }
}

export function apkReleaseTargets(root = process.env.BRAI_ROOT ?? path.resolve(import.meta.dirname, "../..")) {
  const { environments } = JSON.parse(fs.readFileSync(path.join(root, "deploy/environments.json"), "utf8"));
  return [
    fromDeployEnv("prod", environments.prod),
    fromDeployEnv("dev", environments.dev),
    ...previewKeys.map((key) => fromDeployEnv(`preview-${key}`, environments[`preview-${key}`])),
  ];
}

export function apkReleaseTargetByKey(releaseKey, root) {
  return apkReleaseTargets(root).find((target) => target.releaseKey === releaseKey) ?? null;
}

export function apkReleaseTargetByFlavor(flavor, root) {
  return apkReleaseTargets(root).find((target) => target.androidFlavor === flavor) ?? null;
}

export function apkReleaseTargetByEnvironment(environment, root) {
  if (environment === "prod" || environment === "production") return apkReleaseTargetByKey("production", root);
  if (environment === "dev") return apkReleaseTargetByKey("dev", root);
  const preview = String(environment || "").match(/^preview-([a-e])$/);
  return preview ? apkReleaseTargetByKey(preview[1], root) : null;
}

function fromDeployEnv(environment, env) {
  if (!env) throw new Error(`missing APK release environment: ${environment}`);
  return {
    environment,
    displayName: env.displayName,
    displayLabel: env.displayLabel,
    domain: env.domain,
    androidApp: env.androidApp,
    androidFlavor: env.androidFlavor,
    applicationId: env.applicationId,
    path: env.path,
    releaseKey: env.releaseKey,
  };
}
