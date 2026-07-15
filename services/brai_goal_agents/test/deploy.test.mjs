// File-size exception: destructive deploy scenarios share one shell fixture so safety mocks cannot drift between separate suites.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repo = path.resolve(import.meta.dirname, "../../..");
const read = (relative) => fs.readFileSync(path.join(repo, relative), "utf8");
const slugs = [
  "activity-classifier",
  "goal-item-matcher",
  "goal-member-finder",
  "goal-discovery",
  "goal-planner"
];

test("deployment config defines five production families and all environment suffixes", () => {
  const environments = JSON.parse(read("deploy/environments.json")).environments;
  assert.equal(environments.prod.goalAgentServiceSuffix, "");
  assert.equal(environments.prod.goalAgentQueueEnvironment, "prod");
  assert.equal(environments.dev.goalAgentServiceSuffix, "-dev");
  for (const slot of ["a", "b", "c", "d", "e"]) {
    assert.equal(environments[`preview-${slot}`].goalAgentServiceSuffix, `-preview-${slot}`);
    assert.equal(environments[`preview-${slot}`].goalAgentQueueEnvironment, `preview-${slot}`);
  }
  const vars = read("deploy/ansible/group_vars/brai.yml");
  for (const slug of slugs) assert.match(vars, new RegExp(`unit_base: brai-agent-${slug}`));
  const apiUnit = read("deploy/ansible/templates/brai-api.service.j2");
  assert.match(apiUnit, /^TimeoutStopSec=45$/m);
  assert.equal(
    apiUnit.match(/ExecStart=\/usr\/bin\/env BRAI_ENVIRONMENT=\{\{ item\.value\.goal_agent_queue_environment \}\}/g)?.length,
    2
  );
});

test("systemd template is a hardened listener-free Temporal/LLM worker", () => {
  const unit = read("deploy/ansible/templates/brai-goal-agent.service.j2");
  const env = read("deploy/ansible/templates/brai-goal-agents.env.j2");
  const runtimePolicy = JSON.parse(read("services/brai_goal_agents/runtime-policy.json"));
  assert.match(unit, /User=\{\{ brai_goal_agent_user \}\}/);
  assert.match(unit, /Group=\{\{ brai_goal_agent_group \}\}/);
  assert.match(unit, /SupplementaryGroups=\{\{ brai_codex_exec_group \}\} \{\{ brai_codex_auth_group \}\}/);
  assert.doesNotMatch(unit, /User=\{\{ brai_service_user \}\}|Group=\{\{ brai_service_group \}\}|brai-deploy/);
  assert.match(unit, /Environment=BRAI_GOAL_AGENT_TASK_QUEUE=/);
  assert.match(unit, /runtime-policy\.json/);
  assert.match(unit, /UnsetEnvironment=\{\{ goal_agent_runtime_policy\.forbidden_environment_keys \| join\(' '\) \}\}/);
  assert.match(unit, /ExecStartPre=\/usr\/bin\/test -r \{\{ brai_goal_agent_codex_home \}\}\/auth\.json/);
  assert.match(unit, /ExecStartPre=\/usr\/bin\/test -r \{\{ brai_goal_agent_codex_home \}\}\/config\.toml/);
  assert.match(unit, /ExecStartPre=\{\{ brai_codex_bin \}\} --version/);
  assert.ok(unit.indexOf("ExecStartPre={{ brai_codex_bin }} --version")
    < unit.indexOf("ExecStart={{ brai_node_bin }} src/entrypoints/"));
  for (const key of ["DATABASE_URL", "BRAI_PROD_DATABASE_URL", "SUPABASE_ACCESS_TOKEN", "BRAI_API_URL"]) {
    assert.ok(runtimePolicy.forbidden_environment_keys.includes(key));
  }
  assert.match(unit, /TimeoutStopSec=45/);
  assert.match(unit, /NoNewPrivileges=true/);
  assert.match(unit, /ProtectSystem=strict/);
  assert.match(unit, /CapabilityBoundingSet=/);
  assert.doesNotMatch(unit, /ListenStream/);
  assert.doesNotMatch(unit, /^(?:Environment|EnvironmentFile)=.*(?:PORT=|BRAI_DATABASE_URL|BRAI_API_)/m);
  assert.match(env, /TEMPORAL_ADDRESS=127\.0\.0\.1:7233/);
  assert.match(env, /BRAI_CODEX_BIN=\{\{ brai_codex_bin \}\}/);
  assert.match(env, /CODEX_HOME=\{\{ brai_goal_agent_codex_home \}\}/);
  assert.doesNotMatch(env, /DATABASE|SUPABASE|API_TOKEN|SERVICE_ROLE/);
});

test("Ansible enforces a dedicated identity that cannot read API secrets", () => {
  const vars = read("deploy/ansible/group_vars/brai.yml");
  const playbook = read("deploy/ansible/brai.yml");
  const envTemplate = read("deploy/ansible/templates/brai-goal-agents.env.j2");
  assert.match(vars, /^brai_goal_agent_user: brai-goal-agent$/m);
  assert.match(vars, /^brai_goal_agent_group: brai-goal-agent$/m);
  assert.match(vars, /^brai_codex_exec_group: brai-codex-exec$/m);
  assert.match(vars, /^brai_codex_auth_group: brai-codex-auth$/m);
  assert.match(playbook, /name: Create isolated Brai Goal agent user[\s\S]*?append: false/);
  assert.match(playbook, /name: Assert isolated Brai Goal agent effective identity/);
  assert.match(playbook, /brai_service_group not in brai_goal_agent_effective_groups\.stdout\.split\(\)/);
  assert.match(playbook, /brai_deploy_user not in brai_goal_agent_effective_groups\.stdout\.split\(\)/);
  assert.match(playbook, /name: Assert Brai Goal agent cannot read API secrets[\s\S]*?\/usr\/bin\/sudo[\s\S]*?"!"[\s\S]*?brai_api_env_source/);
  assert.match(playbook, /name: Ensure protected Brai env directory contract[\s\S]*?mode: "0751"/);
  assert.match(playbook, /name: Install Brai Goal agent environment contract[\s\S]*?mode: "0640"/);
  assert.match(playbook, /name: Keep Node\.js library directories private to Codex executable readers[\s\S]*?group: "\{\{ brai_codex_exec_group \}\}"[\s\S]*?mode: "0750"[\s\S]*?brai_node_root \}\}\/lib[\s\S]*?brai_node_root \}\}\/lib\/node_modules/);
  assert.match(playbook, /name: Allow Codex executable readers to enter scoped package directory[\s\S]*?group: "\{\{ brai_codex_exec_group \}\}"[\s\S]*?mode: "0750"/);
  assert.match(playbook, /name: Grant read and execute access only to the Codex CLI package[\s\S]*?group: "\{\{ brai_codex_exec_group \}\}"[\s\S]*?mode: "u=rwX,g=rX,o="[\s\S]*?recurse: true/);
  assert.match(
    playbook,
    /name: Grant only Brai Codex auth readers access to shared credentials[\s\S]*?owner: root[\s\S]*?group: "\{\{ brai_codex_auth_group \}\}"[\s\S]*?mode: "0640"/,
  );
  assert.match(
    playbook,
    /name: Link isolated Goal agent Codex home to read-only shared auth[\s\S]*?follow: false/,
    "auth symlink ownership must never follow through and rewrite shared credential files",
  );
  assert.match(playbook, /name: Assert Brai Goal agent can read only its environment contract/);
  assert.match(playbook, /name: Assert Brai Goal agent cannot list protected env directory[\s\S]*?"!"[\s\S]*?-r[\s\S]*?brai_protected_env_dir/);
  assert.match(playbook, /name: Assert Brai Goal agent can start Codex CLI[\s\S]*?\/usr\/bin\/env[\s\S]*?CODEX_HOME=\{\{ brai_goal_agent_codex_home \}\}[\s\S]*?HOME=\{\{ brai_goal_agent_codex_home \}\}[\s\S]*?brai_codex_bin[\s\S]*?--version/);
  assert.doesNotMatch(envTemplate, /DATABASE|SUPABASE|API_TOKEN|SERVICE_ROLE/);
  assert.match(playbook, /name: Allow Brai API service to read Goal agent contracts and retain Codex access[\s\S]*?brai_goal_agent_group[\s\S]*?append: true[\s\S]*?notify: Restart active Brai API services after Codex access change/);
  assert.match(playbook, /name: Check Brai API source directories before active-service restart[\s\S]*?source\/services\/brai_api[\s\S]*?register: brai_api_source_directories/);
  assert.match(playbook, /name: Restart active Brai API services after Codex access change[\s\S]*?brai_api_source_directories\.results[\s\S]*?when: item\.stat\.exists/);
  assert.match(playbook, /name: Assert all Brai Goal agent units use the isolated identity/);
});

test("deployment docs require first Ansible install and describe all 35 agent units", () => {
  const docs = read("docs/operations/branch-preview-environments.md");
  const sudoers = read("deploy/ansible/templates/brai-deploy-sudoers.j2");
  assert.match(docs, /first deployment containing Goal agents requires this Ansible apply/);
  assert.match(docs, /all 35[\s\S]*?five service families across Production, Dev, and Preview A-E/);
  assert.match(sudoers, /brai_envs\.items\(\)[\s\S]*?brai_goal_agents\.items\(\)[\s\S]*?systemctl restart/);
  assert.match(sudoers, /name in \['prod', 'dev'\][\s\S]*?systemctl enable --now/);
  assert.match(sudoers, /NOPASSWD: \{\{ brai_goal_agent_runtime_prepare \}\} ""$/m);
  assert.match(sudoers, /\{\{ brai_codex_maintenance_user \}\} ALL=\(root\) NOPASSWD: \{\{ brai_goal_agent_runtime_prepare \}\} ""/);
  assert.doesNotMatch(sudoers, /brai_goal_agent_runtime_prepare \*/);
  assert.equal(sudoers.match(/systemctl stop \{\{ env\.service \}\}/g)?.length, 1);
  assert.ok(
    sudoers.indexOf("systemctl stop {{ env.service }}")
      < sudoers.indexOf("{% for agent_name, agent in brai_goal_agents.items() %}")
  );
});

test("the required Goal-agent gate repairs Codex access through one fixed root helper", () => {
  const vars = read("deploy/ansible/group_vars/brai.yml");
  const playbook = read("deploy/ansible/brai.yml");
  const helper = read("deploy/ansible/templates/brai-goal-agent-runtime-prepare.sh.j2");
  const gate = read("deploy/scripts/deploy-goal-agents.sh");
  assert.match(vars, /^brai_goal_agent_runtime_prepare: \/srv\/opt\/brai-goal-agent-runtime-prepare\.sh$/m);
  assert.match(vars, /^brai_codex_maintenance_sync: \/srv\/opt\/codex-maintenance\/sync-managed-release\.sh$/m);
  assert.match(playbook, /name: Install Goal agent runtime preparation helper[\s\S]*?owner: root[\s\S]*?group: root[\s\S]*?mode: "0755"/);
  assert.match(playbook, /name: Prepare and verify Goal agent Codex runtime access[\s\S]*?brai_goal_agent_runtime_prepare/);
  assert.match(playbook, /name: Reconcile Goal agent access after every managed Codex update[\s\S]*?blockinfile:[\s\S]*?brai_codex_maintenance_sync[\s\S]*?\/usr\/bin\/sudo -n \{\{ brai_goal_agent_runtime_prepare \}\}/);
  assert.match(helper, /\(\(\$# != 0\)\)/);
  assert.match(helper, /\(\(EUID != 0\)\)/);
  assert.match(helper, /CODEX_TARGET=.*readlink -f/);
  assert.match(helper, /CODEX_PACKAGE\/bin\/codex\.js/);
  assert.match(helper, /chgrp -R -- "\$CODEX_EXEC_GROUP" "\$CODEX_PACKAGE"/);
  assert.match(helper, /chmod -R u=rwX,g=rX,o= "\$CODEX_PACKAGE"/);
  assert.match(helper, /runuser -u "\$GOAL_AGENT_USER"[\s\S]*?env -i[\s\S]*?"\$CODEX_BIN" --version/);
  const prepare = gate.indexOf('"${BRAI_SUDO:-sudo}" "$GOAL_AGENT_RUNTIME_PREPARE"');
  const preflight = gate.indexOf('goal-agent-infrastructure-preflight.sh" "$ENVIRONMENT"');
  const restart = gate.indexOf('systemctl restart "$unit"');
  assert.ok(prepare > 0 && prepare < preflight && preflight < restart);
});

test("generic deploy fails early on missing agent infrastructure and leaves the independent gate pending", () => {
  const ci = read("deploy/scripts/ci-ssh-deploy.sh");
  const deploy = read("deploy/scripts/deploy-branch.sh");
  const preflight = read("deploy/scripts/goal-agent-infrastructure-preflight.sh");
  assert.match(ci, /npm --prefix services\/brai_goal_agents ci/);
  assert.ok(ci.indexOf('goal-agent-infrastructure-preflight.sh "$ENVIRONMENT"') < ci.indexOf("npm ci"));
  assert.match(ci, /GOAL_AGENT_RUNTIME_GROUP="\$\{BRAI_GOAL_AGENT_GROUP:-brai-goal-agent\}"/);
  assert.match(ci, /find "\$GOAL_AGENT_SOURCE" -exec chgrp -h "\$GOAL_AGENT_RUNTIME_GROUP"/);
  assert.match(ci, /chmod -R g=rX,o= "\$GOAL_AGENT_SOURCE"/);
  assert.match(preflight, /root:\$GOAL_AGENT_GROUP:640/);
  assert.match(preflight, /API service user \$API_SERVICE_USER cannot read shared Goal-agent runtime contracts/);
  assert.match(preflight, /deploy identity \$\(id -un\) cannot publish Goal-agent source/);
  assert.match(preflight, /Apply deploy\/ansible\/brai\.yml/);
  assert.match(deploy, /systemctl restart "\$SERVICE_NAME"/);
  assert.match(deploy, /BRAI_API_ALREADY_RESTARTED:-false[\s\S]*?already provisionally verified[\s\S]*?else[\s\S]*?systemctl restart "\$SERVICE_NAME"[\s\S]*?wait_for_preview_api/);
  assert.equal(deploy.match(/systemctl restart "\$SERVICE_NAME"/g)?.length, 1);
  assert.doesNotMatch(deploy, /GOAL_AGENT_IDS=\(|context-smoke-cli|preview-slots\.sh" ready/);
  assert.match(deploy, /Goal-agent gate remains pending/);
});

test("API drain, data checks, source swap, and one provisional restart stay ordered", () => {
  const ci = read("deploy/scripts/ci-ssh-deploy.sh");
  const deploy = read("deploy/scripts/deploy-branch.sh");
  const stop = ci.indexOf('API_TRANSITION_STARTED="true"\n  "${BRAI_SUDO:-sudo}" systemctl stop "$SERVICE_NAME"');
  const precheck = ci.indexOf('run_goal_agent_drain_check "$CURRENT_DATABASE_URL" "before-data-setup"');
  const emptyTemporalPrecheck = ci.indexOf('run_goal_agent_temporal_empty_check "before-data-setup"');
  const dataSetup = ci.indexOf("node deploy/scripts/supabase-branch.mjs preview-env");
  const postcheck = ci.indexOf('run_goal_agent_drain_check "$TARGET_DATABASE_URL" "after-data-setup"');
  const swap = ci.indexOf('mv "$REMOTE_UPLOAD" "$SOURCE_ROOT"');
  const provisionalLabel = ci.indexOf('echo "Starting provisional $SERVICE_NAME from incoming source..."');
  const provisionalRestart = ci.indexOf('systemctl restart "$SERVICE_NAME"', provisionalLabel);
  const provisionalHealth = ci.indexOf('wait_for_api_health "New API"', provisionalRestart);
  const genericDeploy = ci.indexOf("deploy/scripts/deploy-branch.sh", provisionalHealth);

  for (const index of [stop, precheck, emptyTemporalPrecheck, dataSetup, postcheck, swap, provisionalRestart, provisionalHealth, genericDeploy]) {
    assert.ok(index > 0);
  }
  assert.ok(stop < precheck);
  assert.ok(precheck < dataSetup);
  assert.ok(emptyTemporalPrecheck < dataSetup);
  assert.ok(dataSetup < postcheck);
  assert.ok(postcheck < swap);
  assert.ok(swap < provisionalRestart);
  assert.ok(provisionalRestart < provisionalHealth);
  assert.ok(provisionalHealth < genericDeploy);
  assert.match(ci, /NEW_API_HEALTHY="true"[\s\S]*?export BRAI_API_ALREADY_RESTARTED="true"[\s\S]*?deploy\/scripts\/deploy-branch\.sh/);
  assert.match(ci, /supabase-branch\.mjs preview-env[\s\S]*?--commit "\$BRAI_COMMIT"/);
  assert.match(deploy, /BRAI_API_ALREADY_RESTARTED:-false/);
});

test("failed incoming API health restores old source and proves old API healthy", (t) => {
  const ci = read("deploy/scripts/ci-ssh-deploy.sh");
  const functionNames = [
    "is_deploy_attempt_suffix",
    "assert_attempt_staging_path",
    "write_attempt_terminal_marker",
    "remove_attempt_staging",
    "restore_previous_source",
    "assert_api_quiesced",
    "wait_for_api_health",
    "rollback_before_new_api_health",
    "reconcile_source_swap_state",
    "deploy_cleanup"
  ];
  const functions = functionNames.map((name) => {
    const source = ci.match(new RegExp(`${name}\\(\\) \\{[\\s\\S]*?\\n\\}`))?.[0];
    assert.ok(source, `missing ${name}`);
    return source;
  }).join("\n");

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "brai-api-rollback-test-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const sourceRoot = path.join(temp, "source");
  const uploadRoot = path.join(temp, "ci-uploads");
  const commit = "a".repeat(40);
  const attemptSuffix = "local-0-deploy-100-200";
  const remoteUpload = path.join(uploadRoot, `branch-${commit}.attempt-${attemptSuffix}`);
  const previousSource = `${sourceRoot}.previous-${attemptSuffix}`;
  const state = path.join(temp, "state");
  const trace = path.join(temp, "trace");
  fs.mkdirSync(uploadRoot);
  fs.mkdirSync(sourceRoot);
  fs.mkdirSync(previousSource);
  fs.writeFileSync(path.join(sourceRoot, "version"), "incoming\n");
  fs.writeFileSync(path.join(previousSource, "version"), "old\n");
  fs.writeFileSync(state, "active\n");
  fs.writeFileSync(path.join(temp, "systemctl"), `#!/usr/bin/env bash
set -euo pipefail
printf 'systemctl %s\\n' "$*" >>"$TRACE"
case "$1" in
  stop) printf 'inactive\\n' >"$STATE" ;;
  restart) printf 'active\\n' >"$STATE" ;;
  is-active) [[ "$(cat "$STATE")" == "active" ]] ;;
  show) [[ "$(cat "$STATE")" == "active" ]] && printf '4242\\n' || printf '0\\n' ;;
  *) exit 2 ;;
esac
`, { mode: 0o755 });
  fs.writeFileSync(path.join(temp, "sudo"), `#!/usr/bin/env bash
set -euo pipefail
printf 'sudo %s\\n' "$*" >>"$TRACE"
exec "$@"
`, { mode: 0o755 });
  fs.writeFileSync(path.join(temp, "node"), `#!/usr/bin/env bash
set -euo pipefail
printf 'node health\\n' >>"$TRACE"
[[ "$(cat "$STATE")" == "active" ]]
grep -qx old "$SOURCE_ROOT/version"
`, { mode: 0o755 });

  const result = spawnSync("bash", ["-c", `${functions}
sleep() { :; }
export SOURCE_ROOT=${shellQuote(sourceRoot)}
export PREVIOUS_SOURCE=${shellQuote(previousSource)}
export REMOTE_UPLOAD=${shellQuote(remoteUpload)}
export ATTEMPT_STAGING=${shellQuote(remoteUpload)}
export UPLOAD_ROOT=${shellQuote(uploadRoot)}
export UPLOAD_MARKER=.brai-upload-terminal.json
export BRAI_COMMIT=${commit}
export DEPLOY_ATTEMPT_SUFFIX=${attemptSuffix}
export STATE=${shellQuote(state)}
export TRACE=${shellQuote(trace)}
export SERVICE_NAME=brai-api-preview-b.service
export API_PORT=3012
export ENVIRONMENT=preview-b
PREVIOUS_SOURCE_READY=true
SOURCE_SWAPPED=true
API_WAS_ACTIVE=true
API_TRANSITION_STARTED=true
API_QUIESCED=false
NEW_API_HEALTHY=false
DEPLOY_CLEANUP_RUNNING=false
BRAI_SUDO=sudo
mark_preview_failed() { :; }
cleanup_preview_queue() { :; }
trap 'deploy_cleanup $?' EXIT
trap 'deploy_cleanup $?' ERR
wait_for_api_health "New API"
printf 'continued\n' >${shellQuote(path.join(temp, "continued"))}
`], {
    env: { ...process.env, PATH: `${temp}:${process.env.PATH}` }, encoding: "utf8"
  });
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /New API health check failed/);
  assert.match(result.stdout, /Restored brai-api-preview-b\.service is healthy after rollback/);
  assert.equal(fs.readFileSync(path.join(sourceRoot, "version"), "utf8"), "old\n");
  assert.equal(fs.existsSync(remoteUpload), false);
  assert.equal(fs.existsSync(previousSource), false);
  assert.equal(fs.existsSync(path.join(temp, "continued")), false);
  const rollbackTrace = fs.readFileSync(trace, "utf8");
  assert.match(rollbackTrace, /sudo systemctl stop brai-api-preview-b\.service[\s\S]*?sudo systemctl restart brai-api-preview-b\.service[\s\S]*?node health/);
});

test("pre-cutover failure removes only its exact attempt staging", (t) => {
  const ci = read("deploy/scripts/ci-ssh-deploy.sh");
  const functionNames = [
    "is_deploy_attempt_suffix",
    "assert_attempt_staging_path",
    "write_attempt_terminal_marker",
    "remove_attempt_staging",
    "reconcile_source_swap_state",
    "deploy_cleanup"
  ];
  const functions = functionNames.map((name) => {
    const source = ci.match(new RegExp(`${name}\\(\\) \\{[\\s\\S]*?\\n\\}`))?.[0];
    assert.ok(source, `missing ${name}`);
    return source;
  }).join("\n");

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "brai-pre-cutover-cleanup-test-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const sourceRoot = path.join(temp, "source");
  const uploadRoot = path.join(temp, "ci-uploads");
  const commit = "b".repeat(40);
  const attemptSuffix = "local-0-deploy-101-201";
  const attempt = path.join(uploadRoot, `branch-${commit}.attempt-${attemptSuffix}`);
  const collision = `${sourceRoot}.previous-${attemptSuffix}`;
  const otherAttempt = path.join(uploadRoot, `branch-${commit}.attempt-other`);
  const orphan = path.join(temp, "source.orphan-keep");
  const cutover = path.join(temp, "source.cutover-backup-keep");
  const markerCapture = path.join(temp, "terminal-marker.json");
  for (const directory of [sourceRoot, uploadRoot, attempt, otherAttempt, collision, orphan, cutover]) fs.mkdirSync(directory);
  fs.writeFileSync(path.join(sourceRoot, "version"), "old\n");
  fs.writeFileSync(path.join(collision, "keep"), "foreign\n");

  const result = spawnSync("bash", ["-c", `set -euo pipefail
${functions}
SOURCE_ROOT=${shellQuote(sourceRoot)}
PREVIOUS_SOURCE=${shellQuote(collision)}
ATTEMPT_STAGING=${shellQuote(attempt)}
UPLOAD_ROOT=${shellQuote(uploadRoot)}
UPLOAD_MARKER=.brai-upload-terminal.json
BRAI_COMMIT=${commit}
MARKER_CAPTURE=${shellQuote(markerCapture)}
DEPLOY_ATTEMPT_SUFFIX=${attemptSuffix}
SOURCE_SWAPPED=false
PREVIOUS_SOURCE_READY=false
API_WAS_ACTIVE=false
API_TRANSITION_STARTED=false
API_QUIESCED=false
NEW_API_HEALTHY=false
DEPLOY_CLEANUP_RUNNING=false
mark_preview_failed() { :; }
cleanup_preview_queue() { :; }
rm() {
  if [[ "\${!#}" == "$ATTEMPT_STAGING" ]]; then
    cp "$ATTEMPT_STAGING/$UPLOAD_MARKER" "$MARKER_CAPTURE"
  fi
  command rm "$@"
}
trap 'deploy_cleanup $?' EXIT
trap 'deploy_cleanup $?' ERR
false
`], { encoding: "utf8" });

  assert.equal(result.status, 1, result.stderr);
  assert.equal(fs.existsSync(attempt), false);
  const marker = JSON.parse(fs.readFileSync(markerCapture, "utf8"));
  assert.deepEqual({ status: marker.status, commit: marker.commit }, { status: "failed", commit });
  assert.ok(Number.isFinite(Date.parse(marker.finishedAt)));
  for (const directory of [sourceRoot, otherAttempt, collision, orphan, cutover]) assert.equal(fs.existsSync(directory), true);
  assert.equal(fs.readFileSync(path.join(collision, "keep"), "utf8"), "foreign\n");
  assert.equal(fs.readFileSync(path.join(sourceRoot, "version"), "utf8"), "old\n");
});

test("attempt cleanup removes only the exact SHA staging when terminal marker rename runs out of space", (t) => {
  const ci = read("deploy/scripts/ci-ssh-deploy.sh");
  const functionNames = [
    "is_deploy_attempt_suffix",
    "assert_attempt_staging_path",
    "write_attempt_terminal_marker",
    "remove_attempt_staging"
  ];
  const functions = functionNames.map((name) => {
    const source = ci.match(new RegExp(`${name}\\(\\) \\{[\\s\\S]*?\\n\\}`))?.[0];
    assert.ok(source, `missing ${name}`);
    return source;
  }).join("\n");
  const cleanupStartToken = "<<'REMOTE' || true\n";
  const cleanupStart = ci.indexOf(cleanupStartToken, ci.indexOf("cleanup_remote_upload()"));
  const cleanupEnd = ci.indexOf("\nREMOTE\n}", cleanupStart);
  assert.ok(cleanupStart > 0 && cleanupEnd > cleanupStart);
  const cleanupRemoteScript = ci.slice(cleanupStart + cleanupStartToken.length, cleanupEnd);

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "brai-marker-enospc-cleanup-test-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const uploadRoot = path.join(temp, "ci-uploads");
  const fakeBin = path.join(temp, "bin");
  const commit = "7".repeat(40);
  const otherCommit = "8".repeat(40);
  const innerSuffix = "local-0-deploy-102-202";
  const outerSuffix = "local-0-deploy-103-203";
  const mismatchSuffix = "local-0-deploy-104-204";
  const symlinkSuffix = "local-0-deploy-105-205";
  const siblingSuffix = "local-0-deploy-106-206";
  const innerAttempt = path.join(uploadRoot, `branch-${commit}.attempt-${innerSuffix}`);
  const outerAttempt = path.join(uploadRoot, `branch-${commit}.attempt-${outerSuffix}`);
  const mismatchedAttempt = path.join(uploadRoot, `branch-${otherCommit}.attempt-${mismatchSuffix}`);
  const siblingAttempt = path.join(uploadRoot, `branch-${commit}.attempt-${siblingSuffix}`);
  const symlinkAttempt = path.join(uploadRoot, `branch-${commit}.attempt-${symlinkSuffix}`);
  const symlinkTarget = path.join(temp, "outside-attempt");
  for (const directory of [fakeBin, innerAttempt, outerAttempt, mismatchedAttempt, siblingAttempt, symlinkTarget]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  fs.writeFileSync(path.join(uploadRoot, ".staging-operation.lock"), "");
  fs.writeFileSync(path.join(symlinkTarget, "keep"), "outside\n");
  fs.symlinkSync(symlinkTarget, symlinkAttempt);
  fs.writeFileSync(path.join(fakeBin, "mv"), "#!/bin/sh\necho 'No space left on device' >&2\nexit 1\n", { mode: 0o755 });
  const env = { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` };

  const inner = spawnSync("bash", ["-c", `set -euo pipefail
${functions}
ATTEMPT_STAGING=${shellQuote(innerAttempt)}
UPLOAD_ROOT=${shellQuote(uploadRoot)}
UPLOAD_MARKER=.brai-upload-terminal.json
BRAI_COMMIT=${commit}
DEPLOY_ATTEMPT_SUFFIX=${innerSuffix}
remove_attempt_staging failed
`], { env, encoding: "utf8" });
  assert.equal(inner.status, 0, inner.stderr);
  assert.match(inner.stderr, /No space left on device/);
  assert.equal(fs.existsSync(innerAttempt), false);

  const cleanupScriptPath = path.join(temp, "cleanup-remote.sh");
  fs.writeFileSync(cleanupScriptPath, cleanupRemoteScript, { mode: 0o755 });
  const outer = spawnSync("bash", [cleanupScriptPath, outerAttempt, uploadRoot, path.basename(outerAttempt), commit, ".brai-upload-terminal.json", "failed"], {
    env,
    encoding: "utf8"
  });
  assert.equal(outer.status, 0, outer.stderr);
  assert.match(outer.stderr, /No space left on device/);
  assert.equal(fs.existsSync(outerAttempt), false);

  const mismatched = spawnSync("bash", ["-c", `set -euo pipefail
${functions}
ATTEMPT_STAGING=${shellQuote(mismatchedAttempt)}
UPLOAD_ROOT=${shellQuote(uploadRoot)}
UPLOAD_MARKER=.brai-upload-terminal.json
BRAI_COMMIT=${commit}
DEPLOY_ATTEMPT_SUFFIX=${mismatchSuffix}
remove_attempt_staging failed
`], { env, encoding: "utf8" });
  assert.equal(mismatched.status, 1, mismatched.stderr);
  assert.equal(fs.existsSync(mismatchedAttempt), true);

  const symlink = spawnSync("bash", ["-c", `set -euo pipefail
${functions}
ATTEMPT_STAGING=${shellQuote(symlinkAttempt)}
UPLOAD_ROOT=${shellQuote(uploadRoot)}
UPLOAD_MARKER=.brai-upload-terminal.json
BRAI_COMMIT=${commit}
DEPLOY_ATTEMPT_SUFFIX=${symlinkSuffix}
remove_attempt_staging failed
`], { encoding: "utf8" });
  assert.equal(symlink.status, 0, symlink.stderr);
  assert.equal(fs.existsSync(symlinkAttempt), false);
  assert.equal(fs.existsSync(path.join(symlinkTarget, ".brai-upload-terminal.json")), false);
  assert.equal(fs.readFileSync(path.join(symlinkTarget, "keep"), "utf8"), "outside\n");
  assert.equal(fs.existsSync(siblingAttempt), true);
});

test("CI rejects symlink source and lock boundaries without touching external targets", (t) => {
  const ci = read("deploy/scripts/ci-ssh-deploy.sh");
  assert.match(ci, /\[\[ -f "\$SOURCE_OPERATION_LOCK" && ! -L "\$SOURCE_OPERATION_LOCK" \]\]/);
  assert.match(ci, /exec 8<>"\$SOURCE_OPERATION_LOCK"/);
  assert.match(ci, /\[\[ -f "\$STAGING_OPERATION_LOCK" && ! -L "\$STAGING_OPERATION_LOCK" \]\]/);
  assert.match(ci, /exec 7<>"\$STAGING_OPERATION_LOCK"/);
  const validationStart = ci.indexOf('SOURCE_PRESENT="false"\nif [[ -e "$SOURCE_ROOT" || -L "$SOURCE_ROOT" ]]');
  const validationEnd = ci.indexOf('\nPREVIOUS_SOURCE="${SOURCE_ROOT}.previous-', validationStart);
  assert.ok(validationStart > 0 && validationEnd > validationStart);
  const validation = ci.slice(validationStart, validationEnd);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "brai-source-symlink-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const outside = path.join(root, "outside");
  const source = path.join(root, "source");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "keep"), "unchanged\n");
  fs.symlinkSync(outside, source);
  const result = spawnSync("bash", ["-c", `set -euo pipefail
SOURCE_ROOT=${shellQuote(source)}
${validation}
`], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not a plain directory/);
  assert.equal(fs.readFileSync(path.join(outside, "keep"), "utf8"), "unchanged\n");
  assert.equal(fs.existsSync(path.join(outside, ".brai-previous-source.json")), false);
});

test("local EXIT cleanup deletes staging only while the local phase owns it", (t) => {
  const ci = read("deploy/scripts/ci-ssh-deploy.sh");
  const cleanup = ci.match(/cleanup\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(cleanup);
  const setupOwnership = ci.indexOf('REMOTE_UPLOAD_OWNED="true"');
  const deployOwnership = ci.indexOf('REMOTE_DEPLOY_OWNS_STAGING="true"');
  const localRelease = ci.indexOf('REMOTE_UPLOAD_OWNED="false"', setupOwnership);
  assert.ok(setupOwnership > 0 && setupOwnership < deployOwnership && deployOwnership < localRelease);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "brai-local-cleanup-owner-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [name, locallyOwned, remotelyOwned, expectedCall] of [
    ["before-setup", "false", "false", false],
    ["after-setup", "true", "false", true],
    ["remote-deploy", "false", "true", false],
  ]) {
    const caseRoot = path.join(root, name);
    fs.mkdirSync(caseRoot);
    const key = path.join(caseRoot, "key");
    const called = path.join(caseRoot, "called");
    fs.writeFileSync(key, "key");
    const result = spawnSync("bash", ["-c", `${cleanup}
KEY_FILE=${shellQuote(key)}
CLEANUP_TERMINAL_STATUS=failed
REMOTE_UPLOAD_OWNED=${locallyOwned}
REMOTE_DEPLOY_OWNS_STAGING=${remotelyOwned}
cleanup_remote_upload() { printf called >${shellQuote(called)}; }
false
cleanup
`], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.equal(fs.existsSync(called), expectedCall);
  }
});

test("truncated remote tar upload writes a failed terminal marker", (t) => {
  const ci = read("deploy/scripts/ci-ssh-deploy.sh");
  const uploadStartToken = "read -r -d '' REMOTE_EXTRACT_SCRIPT <<'REMOTE_EXTRACT' || true\n";
  const uploadStart = ci.indexOf(uploadStartToken);
  const uploadEnd = ci.indexOf("\nREMOTE_EXTRACT\n", uploadStart);
  assert.ok(uploadStart > 0 && uploadEnd > uploadStart);
  const uploadScript = ci.slice(uploadStart + uploadStartToken.length, uploadEnd);
  assert.match(uploadScript, /-d "\$REMOTE_UPLOAD" && ! -L "\$REMOTE_UPLOAD"/);
  assert.match(ci, /printf -v REMOTE_EXTRACT_COMMAND 'bash -c %q bash %q %q %q %q %q'/);
  assert.match(ci, /ssh[^\n]*\\\n\s+"\$REMOTE_EXTRACT_COMMAND"/);

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "brai-truncated-upload-test-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const commit = "d".repeat(40);
  const uploadRoot = path.join(temp, "ci uploads");
  const uploadName = `branch-${commit}.attempt-truncated`;
  const attempt = path.join(uploadRoot, uploadName);
  const archive = path.join(temp, "truncated.tar.gz");
  fs.mkdirSync(attempt, { recursive: true });
  fs.writeFileSync(path.join(uploadRoot, ".staging-operation.lock"), "");
  fs.writeFileSync(archive, "not-a-gzip-stream");
  fs.writeFileSync(path.join(attempt, ".brai-upload-terminal.json"), JSON.stringify({
    status: "active", commit, finishedAt: null
  }));

  const archiveFd = fs.openSync(archive, "r");
  const quote = (value) => {
    const result = spawnSync("bash", ["-c", 'printf "%q" "$1"', "quote-upload-value", value], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const openSshCommand = [
    "bash", "-c", quote(uploadScript), "bash",
    ...[attempt, uploadRoot, uploadName, commit, ".brai-upload-terminal.json"].map(quote)
  ].join(" ");
  const result = spawnSync("bash", ["-c", openSshCommand], {
    stdio: [archiveFd, "pipe", "pipe"], encoding: "utf8"
  });
  fs.closeSync(archiveFd);
  assert.notEqual(result.status, 0);
  const marker = JSON.parse(fs.readFileSync(path.join(attempt, ".brai-upload-terminal.json"), "utf8"));
  assert.deepEqual({ status: marker.status, commit: marker.commit }, { status: "failed", commit });
  assert.ok(Number.isFinite(Date.parse(marker.finishedAt)));
});

test("remote deploy command preserves an empty preview lease generation", () => {
  const values = [
    "/srv/projects/brai",
    "/srv/projects/brai-envs/ci uploads/main-attempt",
    "main",
    "a".repeat(40),
    "false",
    "",
    "/srv/projects/brai-envs/ci uploads",
    ".brai-upload-terminal.json",
    "12",
  ];
  const openSshCommand = ["bash", "-s", "--", ...values].map(shellQuote).join(" ");
  const result = spawnSync("bash", ["-c", openSshCommand], {
    input: 'set -euo pipefail\nprintf "%s|%s|%s\\n" "$#" "${6-missing}" "$9"\n',
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "9||12\n");
});

test("signal between source renames restores the old source and marks cancellation", (t) => {
  const ci = read("deploy/scripts/ci-ssh-deploy.sh");
  const functionNames = [
    "is_deploy_attempt_suffix",
    "assert_attempt_staging_path",
    "write_attempt_terminal_marker",
    "remove_attempt_staging",
    "restore_previous_source",
    "rollback_before_new_api_health",
    "reconcile_source_swap_state",
    "deploy_cleanup"
  ];
  const functions = functionNames.map((name) => {
    const source = ci.match(new RegExp(`${name}\\(\\) \\{[\\s\\S]*?\\n\\}`))?.[0];
    assert.ok(source, `missing ${name}`);
    return source;
  }).join("\n");

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "brai-source-rename-signal-test-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const sourceRoot = path.join(temp, "source");
  const previousSource = `${sourceRoot}.previous-cancel`;
  const uploadRoot = path.join(temp, "ci-uploads");
  const commit = "c".repeat(40);
  const attemptSuffix = "local-0-deploy-107-207";
  const attempt = path.join(uploadRoot, `branch-${commit}.attempt-${attemptSuffix}`);
  const markerCapture = path.join(temp, "terminal-marker.json");
  fs.mkdirSync(previousSource, { recursive: true });
  fs.mkdirSync(attempt, { recursive: true });
  fs.writeFileSync(path.join(previousSource, "version"), "old\n");
  fs.writeFileSync(path.join(attempt, "version"), "incoming\n");

  const result = spawnSync("bash", ["-c", `set -euo pipefail
${functions}
SOURCE_ROOT=${shellQuote(sourceRoot)}
PREVIOUS_SOURCE=${shellQuote(previousSource)}
ATTEMPT_STAGING=${shellQuote(attempt)}
UPLOAD_ROOT=${shellQuote(uploadRoot)}
UPLOAD_MARKER=.brai-upload-terminal.json
BRAI_COMMIT=${commit}
MARKER_CAPTURE=${shellQuote(markerCapture)}
DEPLOY_ATTEMPT_SUFFIX=${attemptSuffix}
SOURCE_PRESENT=true
SOURCE_SWAPPED=false
PREVIOUS_SOURCE_READY=false
API_WAS_ACTIVE=false
API_TRANSITION_STARTED=true
API_QUIESCED=true
NEW_API_HEALTHY=false
DEPLOY_CLEANUP_RUNNING=false
SERVICE_NAME=""
mark_preview_failed() { :; }
cleanup_preview_queue() { :; }
rm() {
  if [[ "\${!#}" == "$ATTEMPT_STAGING" ]]; then
    cp "$ATTEMPT_STAGING/$UPLOAD_MARKER" "$MARKER_CAPTURE"
  fi
  command rm "$@"
}
deploy_cleanup 143
`], { encoding: "utf8" });

  assert.equal(result.status, 143, result.stderr);
  assert.equal(fs.readFileSync(path.join(sourceRoot, "version"), "utf8"), "old\n");
  assert.equal(fs.existsSync(previousSource), false);
  assert.equal(fs.existsSync(attempt), false);
  const marker = JSON.parse(fs.readFileSync(markerCapture, "utf8"));
  assert.deepEqual({ status: marker.status, commit: marker.commit }, { status: "cancelled", commit });
  assert.ok(Number.isFinite(Date.parse(marker.finishedAt)));
});


test("post-health completion, failure, and cancellation preserve the exact previous source", (t) => {
  const ci = read("deploy/scripts/ci-ssh-deploy.sh");
  const functionNames = [
    "is_deploy_attempt_suffix",
    "assert_attempt_staging_path",
    "write_attempt_terminal_marker",
    "remove_attempt_staging",
    "reconcile_source_swap_state",
    "deploy_cleanup"
  ];
  const functions = functionNames.map((name) => {
    const source = ci.match(new RegExp(`${name}\\(\\) \\{[\\s\\S]*?\\n\\}`))?.[0];
    assert.ok(source, `missing ${name}`);
    return source;
  }).join("\n");

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "brai-post-health-failure-test-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  for (const [label, status, markerStatus, shaCharacter, attemptSuffix] of [
    ["failure", 1, "failed", "e", "local-0-deploy-108-208"],
    ["cancellation", 143, "cancelled", "f", "local-0-deploy-109-209"],
    ["success", 0, "succeeded", "9", "local-0-deploy-110-210"]
  ]) {
    const caseRoot = path.join(temp, label);
    const sourceRoot = path.join(caseRoot, "source");
    const previousSource = `${sourceRoot}.previous-${attemptSuffix}`;
    const uploadRoot = path.join(caseRoot, "ci-uploads");
    const commit = shaCharacter.repeat(40);
    const attempt = path.join(uploadRoot, `branch-${commit}.attempt-${attemptSuffix}`);
    const markerCapture = path.join(caseRoot, "terminal-marker.json");
    for (const directory of [sourceRoot, previousSource, attempt]) fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, "version"), "healthy-incoming\n");
    fs.writeFileSync(path.join(previousSource, "version"), "previous\n");

    const result = spawnSync("bash", ["-c", `set -euo pipefail
${functions}
SOURCE_ROOT=${shellQuote(sourceRoot)}
PREVIOUS_SOURCE=${shellQuote(previousSource)}
ATTEMPT_STAGING=${shellQuote(attempt)}
UPLOAD_ROOT=${shellQuote(uploadRoot)}
UPLOAD_MARKER=.brai-upload-terminal.json
BRAI_COMMIT=${commit}
MARKER_CAPTURE=${shellQuote(markerCapture)}
DEPLOY_ATTEMPT_SUFFIX=${attemptSuffix}
SOURCE_PRESENT=true
SOURCE_SWAPPED=true
PREVIOUS_SOURCE_READY=true
API_WAS_ACTIVE=true
API_TRANSITION_STARTED=true
API_QUIESCED=false
NEW_API_HEALTHY=true
DEPLOY_CLEANUP_RUNNING=false
mark_preview_failed() { :; }
cleanup_preview_queue() { :; }
rm() {
  if [[ "\${!#}" == "$ATTEMPT_STAGING" ]]; then
    cp "$ATTEMPT_STAGING/$UPLOAD_MARKER" "$MARKER_CAPTURE"
  fi
  command rm "$@"
}
deploy_cleanup ${status}
`], { encoding: "utf8" });

    assert.equal(result.status, status, result.stderr);
    assert.equal(fs.readFileSync(path.join(sourceRoot, "version"), "utf8"), "healthy-incoming\n");
    assert.equal(fs.readFileSync(path.join(previousSource, "version"), "utf8"), "previous\n");
    assert.equal(fs.existsSync(attempt), false);
    const marker = JSON.parse(fs.readFileSync(markerCapture, "utf8"));
    assert.deepEqual({ status: marker.status, commit: marker.commit }, { status: markerStatus, commit });
  }
});

test("deploy headroom cannot be lowered below 12 GiB", () => {
  const ci = read("deploy/scripts/ci-ssh-deploy.sh");
  const functionSource = ci.match(/check_deploy_headroom\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(functionSource);
  const result = spawnSync("bash", ["-c", `${functionSource}
DEPLOY_MIN_FREE_GB=11 check_deploy_headroom /tmp
`], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /at least 12 GiB/);
});

test("source swap is exact-SHA and atomic with the Preview lease check", () => {
  const ci = read("deploy/scripts/ci-ssh-deploy.sh");
  const lockIndex = ci.indexOf('flock 9');
  const assertIndex = ci.indexOf('preview-slots.mjs assert-owned');
  const previousIndex = ci.indexOf('mv "$SOURCE_ROOT" "$PREVIOUS_SOURCE"');
  const previousMarkerIndex = ci.indexOf('mv -f -- "$previous_marker_tmp" "$PREVIOUS_SOURCE/.brai-previous-source.json"', previousIndex);
  const swapIndex = ci.indexOf('mv "$REMOTE_UPLOAD" "$SOURCE_ROOT"');
  const markerRemovalIndex = ci.indexOf('rm -f -- "$SOURCE_ROOT/$UPLOAD_MARKER"', swapIndex);
  const attemptMarkerIndex = ci.indexOf('>"$SOURCE_ROOT/.brai-deploy-attempt"', markerRemovalIndex);
  const commitMarkerIndex = ci.indexOf('>"$SOURCE_ROOT/.brai-deploy-commit"', attemptMarkerIndex);
  const branchMarkerIndex = ci.indexOf('>"$SOURCE_ROOT/.brai-deploy-branch"', commitMarkerIndex);
  const unlockIndex = ci.indexOf('exec 9>&-', swapIndex);
  assert.match(ci, /REMOTE_UPLOAD="\$UPLOAD_ROOT\/\$SAFE_BRANCH-\$BRAI_COMMIT\.attempt-\$SAFE_ATTEMPT_ID"/);
  assert.match(ci, /preview-slots\.sh allocate "\$BRAI_BRANCH" "\$BRAI_COMMIT" "\$BRAI_PREVIEW_LEASE_GENERATION"/);
  assert.ok(lockIndex > 0 && lockIndex < assertIndex);
  assert.ok(assertIndex < previousIndex && previousIndex < previousMarkerIndex && previousMarkerIndex < swapIndex);
  assert.ok(swapIndex < markerRemovalIndex && markerRemovalIndex < attemptMarkerIndex);
  assert.ok(attemptMarkerIndex < commitMarkerIndex && commitMarkerIndex < branchMarkerIndex && branchMarkerIndex < unlockIndex);
  assert.match(ci, /\.brai-deploy-commit/);
  assert.match(ci, /\.brai-deploy-branch/);
  assert.doesNotMatch(ci, /remove_owned_previous_source|remove_stale_previous_sources/);
});

test("independent agent gate restarts exact units, promotes builds, smokes cross-queue, then marks ready", () => {
  const gate = read("deploy/scripts/deploy-goal-agents.sh");
  const ciGate = read("deploy/scripts/ci-ssh-deploy-goal-agents.sh");
  const sudoers = read("deploy/ansible/templates/brai-deploy-sudoers.j2");
  const playbook = read("deploy/ansible/brai.yml");
  assert.match(gate, /GOAL_AGENT_IDS=\(/);
  for (const id of ["activity.classifier", "goal.item-matcher", "goal.member-finder", "goal.discovery", "goal.planner"]) {
    assert.match(gate, new RegExp(id.replaceAll(".", "\\.")));
  }
  assert.match(gate, /systemctl is-active --quiet "\$unit"/);
  assert.match(gate, /verify_goal_agent_process_identity "\$process_id"[\s\S]*?run_goal_agent_health/);
  assert.match(gate, /systemctl enable --now "\$unit"/);
  assert.match(gate, /promote_goal_agent_deployment "\$agent_id"/);
  assert.match(gate, /wait_for_context_poller/);
  assert.match(gate, /context-smoke-cli\.mjs/);
  assert.match(gate, /preview-slots\.sh" ready "\$BRANCH" "\$COMMIT"/);
  assert.ok(gate.indexOf("context-smoke-cli.mjs") < gate.indexOf('preview-slots.sh" ready'));
  const sourceLockIndex = gate.indexOf("flock 9");
  const sourceIdentityIndex = gate.indexOf('[[ -r "$ROOT/.brai-deploy-commit"');
  const readyMarkerIndex = gate.indexOf('mv -f -- "$READY_MARKER_TMP" "$READY_MARKER"');
  const sourceUnlockIndex = gate.indexOf("exec 9>&-", readyMarkerIndex);
  const maintenanceTriggerIndex = gate.indexOf("systemctl --no-block start brai-storage-maintenance.service", sourceUnlockIndex);
  assert.ok(sourceLockIndex < sourceIdentityIndex);
  assert.ok(gate.indexOf("context-smoke-cli.mjs") < readyMarkerIndex);
  assert.ok(gate.indexOf('preview-slots.sh" ready') < readyMarkerIndex);
  assert.ok(readyMarkerIndex < sourceUnlockIndex && sourceUnlockIndex < maintenanceTriggerIndex);
  assert.match(sudoers, /NOPASSWD: \/bin\/systemctl --no-block start brai-storage-maintenance\.service/);
  assert.match(playbook, /name: Install deploy user sudoers boundary[\s\S]*?tags:\n\s+- brai-caddy\n\s+- brai-codex-broker\n\s+- brai-goal-agents\n\s+- brai-storage-maintenance\n\s+- brai-supavisor-maintenance\n\s+- targeted-infra-apply/);
  assert.match(ciGate, /registry\[key\]\?\.branch === branch && registry\[key\]\?\.commit === commit/);
  assert.match(ciGate, /deploy-goal-agents\.sh/);
});

test("preview release stops all agent instances before deleting the slot source", () => {
  const release = read("deploy/scripts/ci-ssh-release-slot.sh");
  for (const slug of slugs) assert.match(release, new RegExp(slug));
  const stopIndex = release.indexOf('stop_preview_unit_if_exists "brai-agent-$agent_slug-preview-$SLOT_LOWER.service"');
  const cleanupIndex = release.indexOf("cleanup_released_preview_slot_artifacts");
  assert.ok(stopIndex > 0);
  assert.ok(cleanupIndex > 0);
  assert.ok(stopIndex < release.lastIndexOf("cleanup_released_preview_slot_artifacts"));
  assert.match(release, /if systemctl cat "\$unit"/);
  assert.doesNotMatch(release, /BRAI_SUDO:-sudo}" systemctl cat/);
  const cleanupFunction = release.slice(cleanupIndex, release.indexOf("accepted_build_recorded()", cleanupIndex));
  assert.ok(cleanupFunction.indexOf('flock -x 8') < cleanupFunction.indexOf('flock -x 9'));
  assert.ok(cleanupFunction.indexOf('entry?.status === "free"') < cleanupFunction.indexOf('rm -rf "$slot_root/source"'));
  assert.match(cleanupFunction, /\[\[ -f "\$source_lock" && ! -L "\$source_lock" \]\]/);
});

test("preview release cleanup preserves a slot reallocated before its source lock", (t) => {
  const release = read("deploy/scripts/ci-ssh-release-slot.sh");
  const functionStart = release.indexOf("cleanup_released_preview_slot_artifacts() {");
  const functionEnd = release.indexOf("accepted_build_recorded()", functionStart);
  assert.ok(functionStart > 0 && functionEnd > functionStart);
  const functionSource = release.slice(functionStart, functionEnd);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "brai-release-source-lock-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  for (const [name, entry, shouldRemove] of [
    ["reallocated", { status: "deploying", branch: "codex/new-owner" }, false],
    ["free", { status: "free", branch: null }, true],
  ]) {
    const envsRoot = path.join(root, name);
    const slotRoot = path.join(envsRoot, "preview-a");
    const registry = path.join(envsRoot, "preview-slots.json");
    fs.mkdirSync(slotRoot, { recursive: true });
    fs.writeFileSync(path.join(slotRoot, ".source-operation.lock"), "");
    fs.writeFileSync(path.join(envsRoot, "preview-slots.lock"), "");
    fs.writeFileSync(registry, JSON.stringify({ A: entry }));
    for (const artifact of ["source", "source.previous-local-0-deploy-1-2", "web", "mobile-update"]) {
      fs.mkdirSync(path.join(slotRoot, artifact));
      fs.writeFileSync(path.join(slotRoot, artifact, "keep"), name);
    }
    const result = spawnSync("bash", ["-c", `set -euo pipefail
${functionSource}
ENVS_ROOT=${shellQuote(envsRoot)}
REGISTRY=${shellQuote(registry)}
SLOT_LOWER=a
BRAI_SUDO=true
cleanup_released_preview_slot_artifacts '{"released":true,"slot":"A"}'
`], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    for (const artifact of ["source", "source.previous-local-0-deploy-1-2", "web", "mobile-update"]) {
      assert.equal(fs.existsSync(path.join(slotRoot, artifact)), !shouldRemove);
    }
  }
});

test("preview release existence probe cannot be bypassed by missing sudo permission for systemctl cat", () => {
  const release = read("deploy/scripts/ci-ssh-release-slot.sh");
  const functionSource = release.match(/stop_preview_unit_if_exists\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(functionSource);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "brai-release-unit-test-"));
  const trace = path.join(temp, "trace");
  fs.writeFileSync(path.join(temp, "systemctl"), "#!/bin/sh\nprintf 'systemctl %s\\n' \"$*\" >>\"$TRACE\"\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(path.join(temp, "sudo"), "#!/bin/sh\nprintf 'sudo %s\\n' \"$*\" >>\"$TRACE\"\nexec \"$@\"\n", { mode: 0o755 });
  const result = spawnSync("bash", ["-c", `${functionSource}\nBRAI_SUDO=sudo stop_preview_unit_if_exists test.service`], {
    env: { ...process.env, PATH: `${temp}:${process.env.PATH}`, TRACE: trace }, encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readFileSync(trace, "utf8").trim().split("\n"), [
    "systemctl cat test.service",
    "sudo systemctl stop test.service",
    "systemctl stop test.service",
    "sudo systemctl reset-failed test.service",
    "systemctl reset-failed test.service"
  ]);
  fs.rmSync(temp, { recursive: true, force: true });
});

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}
