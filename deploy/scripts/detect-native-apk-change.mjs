import { execFileSync } from "node:child_process";
import process from "node:process";

const branch = process.argv[2] ?? "";
const explicitBase = process.argv[3] ?? process.env.BRIGHT_OS_BASE_COMMIT ?? "";
const nativePrefixes = [
  "apps/bright_os_app/android/",
  "apps/bright_os_app/capacitor.config",
  "apps/bright_os_app/src/shared/platform/androidTimerNotification",
  "apps/bright_os_app/src/shared/platform/ota",
  "deploy/environments.json",
  "deploy/scripts/apk-version-code",
  "deploy/scripts/build-android-env-apk",
  "deploy/scripts/build-nonproduction-apks",
  "deploy/scripts/publish-capacitor-apk",
  "deploy/scripts/resolve-android-env",
];
const nativeFiles = new Set([
  "apps/bright_os_app/package.json",
  "apps/bright_os_app/package-lock.json",
]);

const range = diffRange(branch, explicitBase);
if (!range) {
  console.log("false");
  process.exit(0);
}

const files = execFileSync("git", ["diff", "--name-only", range], { encoding: "utf8" })
  .split("\n")
  .map((file) => file.trim())
  .filter(Boolean);

const changed = files.some((file) => nativeFiles.has(file) || nativePrefixes.some((prefix) => file.startsWith(prefix)));
console.log(changed ? "true" : "false");

function diffRange(branchName, base) {
  if (base && !/^0{40}$/.test(base)) return `${base}..HEAD`;
  if (branchName.startsWith("codex/") && refExists(acceptedBaseRef())) return `${acceptedBaseRef()}...HEAD`;
  if (branchName === "dev" || branchName === "main") return "HEAD^..HEAD";
  return refExists("HEAD^") ? "HEAD^..HEAD" : null;
}

function acceptedBaseRef() {
  return `origin/${process.env.BRIGHT_OS_ACCEPT_BASE || "main"}`;
}

function refExists(ref) {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", ref], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
