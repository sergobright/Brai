import fs from "node:fs";
import process from "node:process";

export function classifyVersionWorkState({ latestBuildVersion = 0, works = [] } = {}) {
  const finalizedBuildWorkKeys = [];
  const finalizedWorkKeys = [];
  const finalizedPulls = [];
  const pendingNativeWorkKeys = [];
  const seen = new Set();

  for (const work of works) {
    const workKey = String(work?.workKey ?? "");
    if (!workKey || seen.has(workKey)) throw new Error(`Invalid duplicate release work state: ${workKey || "(missing)"}`);
    seen.add(workKey);
    if (work.status !== "finalized" || work.hasBuild !== true) continue;

    finalizedBuildWorkKeys.push(workKey);
    if (work.nativeBoundary === true && work.hasApk !== true) {
      pendingNativeWorkKeys.push(workKey);
      continue;
    }
    finalizedWorkKeys.push(workKey);
    for (const pull of work.pulls ?? []) {
      const repository = String(pull?.repository ?? "");
      const pullNumber = Number(pull?.pullNumber ?? 0);
      if (repository && Number.isInteger(pullNumber) && pullNumber > 0) finalizedPulls.push({ repository, pullNumber });
    }
  }

  return {
    latestBuildVersion: Number(latestBuildVersion || 0),
    finalizedBuildWorkKeys: finalizedBuildWorkKeys.sort(),
    finalizedWorkKeys: finalizedWorkKeys.sort(),
    finalizedPulls: finalizedPulls.sort((left, right) => left.repository.localeCompare(right.repository) || left.pullNumber - right.pullNumber),
    pendingNativeWorkKeys: pendingNativeWorkKeys.sort(),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const input = JSON.parse(fs.readFileSync(0, "utf8"));
  console.log(JSON.stringify(classifyVersionWorkState(input)));
}
