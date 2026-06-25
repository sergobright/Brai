import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

export async function deployBranch(env = {}) {
  return runExistingScript("deploy/scripts/deploy-branch.sh", [], env);
}

export async function previewSlot({ action, args = [], env = {} }) {
  return runExistingScript("deploy/scripts/preview-slots.sh", [action, ...args], env);
}

function runExistingScript(script, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(script, args, {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const result = { code, stdout, stderr };
      if (code === 0) resolve(result);
      else reject(Object.assign(new Error(`${script} exited ${code}`), result));
    });
  });
}
