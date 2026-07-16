import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const androidPrefix = "apps/brai_app/android/";
const nonReleaseAndroidSourcePattern = /\/src\/(?:androidTest|test|testFixtures)(?:\/|$)/;
const environmentFile = "deploy/environments.json";
const nativeEnvironmentPattern = /^\s*[+-]\s*"(displayLabel|domain|androidApp|androidFlavor|applicationId|releaseKey)"\s*:/m;
const nativePackageFiles = new Set([
  "apps/brai_app/package.json",
  "apps/brai_app/package-lock.json",
]);
const nativePackagePattern = /^\s*[+-].*("@capacitor\/|@capacitor-community\/|@capawesome\/|capacitor-android|capacitor-cordova|cordova-)/m;

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const branch = process.argv[2] ?? "";
  const explicitBase = process.argv[3] ?? process.env.BRAI_BASE_COMMIT ?? "";
  const ranges = diffRanges(branch, explicitBase);
  if (ranges.length === 0) {
    console.log("false");
    process.exit(0);
  }

  const changed = ranges.some((range) => {
    const files = gitLines(["diff", "--name-only", range]);
    const packageDiff = files.some((file) => nativePackageFiles.has(file))
      ? execFileSync("git", ["diff", "--unified=0", range, "--", ...nativePackageFiles], { encoding: "utf8" })
      : "";
    const environmentDiff = files.includes(environmentFile)
      ? execFileSync("git", ["diff", "--unified=0", range, "--", environmentFile], { encoding: "utf8" })
      : "";
    return requiresNativeApkChange(files, packageDiff, environmentDiff);
  });
  console.log(changed ? "true" : "false");
}

export function requiresNativeApkChange(files, packageDiff = "", environmentDiff = "") {
  return files.some(isNativeApkInput)
    || nativePackagePattern.test(packageDiff)
    || (files.includes(environmentFile) && requiresNativeEnvironmentChange(environmentDiff));
}

function isNativeApkInput(file) {
  return file.startsWith("apps/brai_app/capacitor.config")
    || (file.startsWith(androidPrefix) && !nonReleaseAndroidSourcePattern.test(file));
}

function requiresNativeEnvironmentChange(diff) {
  return diff ? nativeEnvironmentPattern.test(diff) : true;
}

export function diffRange(branchName, base, referenceExists = refExists) {
  return diffRanges(branchName, base, referenceExists)[0] ?? null;
}

export function diffRanges(branchName, base, referenceExists = refExists) {
  const ranges = [];
  if (branchName.startsWith("codex/") && referenceExists(acceptedBaseRef())) {
    ranges.push(`${acceptedBaseRef()}...HEAD`);
  }
  if (base && !/^0{40}$/.test(base) && referenceExists(base)) {
    ranges.push(`${base}..HEAD`);
  }
  if (ranges.length > 0) return [...new Set(ranges)];
  if (branchName === "dev" || branchName === "main") return ["HEAD^..HEAD"];
  return referenceExists("HEAD^") ? ["HEAD^..HEAD"] : [];
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
