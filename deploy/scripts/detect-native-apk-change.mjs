import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const nativePrefixes = [
  "apps/brai_app/android/",
  "apps/brai_app/capacitor.config",
  "deploy/environments.json",
  "deploy/scripts/apk-release-targets",
  "deploy/scripts/build-android-env-apk",
  "deploy/scripts/build-nonproduction-apks",
  "deploy/scripts/resolve-android-env",
];
const nativePackageFiles = new Set([
  "apps/brai_app/package.json",
  "apps/brai_app/package-lock.json",
]);
const nativePackagePattern = /^\s*[+-].*("@capacitor\/|@capacitor-community\/|@capawesome\/|capacitor-android|capacitor-cordova|cordova-)/m;

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const branch = process.argv[2] ?? "";
  const explicitBase = process.argv[3] ?? process.env.BRAI_BASE_COMMIT ?? "";
  const range = diffRange(branch, explicitBase);
  if (!range) {
    console.log("false");
    process.exit(0);
  }

  const files = gitLines(["diff", "--name-only", range]);
  const packageDiff = files.some((file) => nativePackageFiles.has(file))
    ? execFileSync("git", ["diff", "--unified=0", range, "--", ...nativePackageFiles], { encoding: "utf8" })
    : "";
  console.log(requiresNativeApkChange(files, packageDiff) ? "true" : "false");
}

export function requiresNativeApkChange(files, packageDiff = "") {
  return files.some((file) => nativePrefixes.some((prefix) => file.startsWith(prefix)))
    || nativePackagePattern.test(packageDiff);
}

function diffRange(branchName, base) {
  if (base && !/^0{40}$/.test(base)) return `${base}..HEAD`;
  if (branchName.startsWith("codex/") && refExists(acceptedBaseRef())) return `${acceptedBaseRef()}...HEAD`;
  if (branchName === "dev" || branchName === "main") return "HEAD^..HEAD";
  return refExists("HEAD^") ? "HEAD^..HEAD" : null;
}

function acceptedBaseRef() {
  return `origin/${process.env.BRAI_ACCEPT_BASE || "main"}`;
}

function refExists(ref) {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", ref], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function gitLines(args) {
  return execFileSync("git", args, { encoding: "utf8" })
    .split("\n")
    .map((file) => file.trim())
    .filter(Boolean);
}
