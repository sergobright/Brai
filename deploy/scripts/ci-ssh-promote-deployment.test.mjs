import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../..");
const script = path.join(root, "deploy/scripts/ci-ssh-promote-deployment.sh");

test("version work transport preserves empty legacy SSH arguments", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "brai-promote-ssh-"));
  const bin = path.join(fixture, "bin");
  await mkdir(bin);
  await writeFile(path.join(bin, "ssh"), `#!/usr/bin/env bash
set -euo pipefail

remote=()
capture=false
for argument in "$@"; do
  if [[ "$capture" == "true" ]]; then
    remote+=("$argument")
  elif [[ "$argument" == "bash" ]]; then
    capture=true
    remote+=("$argument")
  fi
done

remote_command="\${remote[*]}"
read -r -a parsed <<<"$remote_command"
payload=("\${parsed[@]:3}")
if [[ "\${#payload[@]}" -ne 10 ]]; then
  echo "remote payload lost positional arguments: \${#payload[@]}" >&2
  exit 1
fi

decode_remote_value() {
  local decoded
  decoded="$(printf '%s' "$1" | base64 -d)"
  [[ "\${decoded:0:1}" == "." ]]
  printf '%s' "\${decoded:1}"
}

[[ "$(decode_remote_value "\${payload[5]}")" == "" ]]
[[ "$(decode_remote_value "\${payload[6]}")" == "" ]]
[[ "$(decode_remote_value "\${payload[7]}")" == "" ]]
[[ "\${payload[8]}" == "false" ]]
[[ "$(decode_remote_value "\${payload[9]}")" == "$EXPECTED_WORK_JSON" ]]
`, { mode: 0o755 });

  const workJson = JSON.stringify({
    work: { key: "work_67377d4a-9e6b-4532-84a4-b884cd61e712", role: "owner" },
    pulls: [{ pullNumber: 306, title: "История версий" }],
  });
  const result = spawnSync("bash", [script], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      BRAI_DEPLOY_HOST: "example.invalid",
      BRAI_DEPLOY_USER: "brai-deploy",
      BRAI_DEPLOY_SSH_KEY: "test-key",
      BRAI_SOURCE_BRANCH: "codex/normalize-version-work-history-complete",
      BRAI_TARGET_ENVIRONMENT: "prod",
      BRAI_TARGET_BRANCH: "main",
      BRAI_TARGET_COMMIT: "cbf5ba69215e6efa02e0ecc4ad848cdcce98c5b4",
      BRAI_VERSION_WORK_JSON: workJson,
      BRAI_RECORD_PRODUCTION_RELEASE: "false",
      EXPECTED_WORK_JSON: workJson,
    },
  });

  await rm(fixture, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
