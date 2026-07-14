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
  const stop = ci.indexOf('API_WAS_ACTIVE="true"\n  "${BRAI_SUDO:-sudo}" systemctl stop "$SERVICE_NAME"');
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
    "restore_previous_source",
    "assert_api_quiesced",
    "wait_for_api_health",
    "rollback_before_new_api_health",
    "deploy_failed"
  ];
  const functions = functionNames.map((name) => {
    const source = ci.match(new RegExp(`${name}\\(\\) \\{[\\s\\S]*?\\n\\}`))?.[0];
    assert.ok(source, `missing ${name}`);
    return source;
  }).join("\n");

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "brai-api-rollback-test-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const sourceRoot = path.join(temp, "source");
  const previousSource = path.join(temp, "source.previous");
  const remoteUpload = path.join(temp, "upload");
  const state = path.join(temp, "state");
  const trace = path.join(temp, "trace");
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
export STATE=${shellQuote(state)}
export TRACE=${shellQuote(trace)}
export SERVICE_NAME=brai-api-preview-b.service
export API_PORT=3012
export ENVIRONMENT=preview-b
PREVIOUS_SOURCE_READY=true
SOURCE_SWAPPED=true
API_WAS_ACTIVE=true
NEW_API_HEALTHY=false
BRAI_SUDO=sudo
mark_preview_failed() { :; }
cleanup_stale_preview_previous_sources() { :; }
trap deploy_failed ERR
wait_for_api_health "New API"
printf 'continued\n' >${shellQuote(path.join(temp, "continued"))}
`], {
    env: { ...process.env, PATH: `${temp}:${process.env.PATH}` }, encoding: "utf8"
  });
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /New API health check failed/);
  assert.match(result.stdout, /Restored brai-api-preview-b\.service is healthy after rollback/);
  assert.equal(fs.readFileSync(path.join(sourceRoot, "version"), "utf8"), "old\n");
  assert.equal(fs.readFileSync(path.join(remoteUpload, "version"), "utf8"), "incoming\n");
  assert.equal(fs.existsSync(path.join(temp, "continued")), false);
  const rollbackTrace = fs.readFileSync(trace, "utf8");
  assert.match(rollbackTrace, /sudo systemctl stop brai-api-preview-b\.service[\s\S]*?sudo systemctl restart brai-api-preview-b\.service[\s\S]*?node health/);
});

test("source swap is exact-SHA and atomic with the Preview lease check", () => {
  const ci = read("deploy/scripts/ci-ssh-deploy.sh");
  const lockIndex = ci.indexOf('flock 9');
  const assertIndex = ci.indexOf('preview-slots.mjs assert-owned');
  const previousIndex = ci.indexOf('mv "$SOURCE_ROOT" "$PREVIOUS_SOURCE"');
  const swapIndex = ci.indexOf('mv "$REMOTE_UPLOAD" "$SOURCE_ROOT"');
  const unlockIndex = ci.indexOf('exec 9>&-', swapIndex);
  assert.match(ci, /REMOTE_UPLOAD="\$UPLOAD_ROOT\/\$SAFE_BRANCH-\$BRAI_COMMIT"/);
  assert.match(ci, /preview-slots\.sh allocate "\$BRAI_BRANCH" "\$BRAI_COMMIT" "\$BRAI_PREVIEW_LEASE_GENERATION"/);
  assert.ok(lockIndex > 0 && lockIndex < assertIndex);
  assert.ok(assertIndex < previousIndex && previousIndex < swapIndex && swapIndex < unlockIndex);
  assert.match(ci, /\.brai-deploy-commit/);
  assert.match(ci, /\.brai-deploy-branch/);
});

test("independent agent gate restarts exact units, promotes builds, smokes cross-queue, then marks ready", () => {
  const gate = read("deploy/scripts/deploy-goal-agents.sh");
  const ciGate = read("deploy/scripts/ci-ssh-deploy-goal-agents.sh");
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
