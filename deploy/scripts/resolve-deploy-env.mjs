import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const branch = process.argv[2];
if (!branch) throw new Error("branch is required");

const root = process.env.BRIGHT_OS_ROOT ?? path.resolve(import.meta.dirname, "../..");
const { environments } = JSON.parse(fs.readFileSync(path.join(root, "deploy/environments.json"), "utf8"));
let key;

if (branch === "main") key = "prod";
else if (branch.startsWith("codex/")) {
  const slot = process.env.BRIGHT_OS_PREVIEW_SLOT || resolvePreviewSlot(branch);
  key = `preview-${slot.toLowerCase()}`;
} else {
  throw new Error(`unsupported Bright OS deployment branch: ${branch}`);
}

const env = environments[key];
console.log(key);
console.log(env.displayLabel);
console.log(env.domain);
console.log(env.path);
console.log(env.serviceName);

function resolvePreviewSlot(branchName) {
  const envsRoot = process.env.BRIGHT_OS_ENVS_ROOT ?? "/srv/projects/bright-os-envs";
  const registryPath = process.env.BRIGHT_OS_PREVIEW_REGISTRY ?? path.join(envsRoot, "preview-slots.json");
  if (!fs.existsSync(registryPath)) return "A";
  const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  for (const slot of ["A", "B", "C", "D", "E"]) {
    if (registry[slot]?.branch === branchName) return slot;
  }
  for (const slot of ["A", "B", "C", "D", "E"]) {
    if ((registry[slot]?.status ?? "free") === "free") return slot;
  }
  throw new Error("no preview slot available");
}
