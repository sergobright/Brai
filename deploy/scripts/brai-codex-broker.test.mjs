import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

test("Codex image and broker unit are pinned, non-public and least-privileged", () => {
  const dockerfile = read("services/brai_codex_broker/Dockerfile");
  const unit = read("deploy/ansible/templates/brai-codex-broker.service.j2");
  const apiUnit = read("deploy/ansible/templates/brai-api.service.j2");
  const staticApiUnit = read("deploy/systemd/brai-api.service");
  assert.match(dockerfile, /FROM node:22\.16\.0-bookworm-slim/);
  assert.match(dockerfile, /ARG CODEX_VERSION=0\.144\.4/);
  assert.match(dockerfile, /@openai\/codex@\$\{CODEX_VERSION\}/);
  assert.match(dockerfile, /apt-get install --yes --no-install-recommends ca-certificates/);
  assert.match(dockerfile, /mkdir -p \/etc\/codex/);
  assert.match(dockerfile, /USER 65532:65532/);
  assert.doesNotMatch(dockerfile, /\bEXPOSE\b/);
  assert.match(unit, /BRAI_CODEX_BROKER_SOCKET=\/run\/brai-codex-broker-/);
  assert.match(unit, /ConditionPathExists=\{\{ brai_env_root \}\}\/\{\{ item\.value\.path \}\}\/source\/services\/brai_codex_broker\/src\/index\.mjs/);
  assert.match(unit, /BRAI_CODEX_ATTACHMENT_ROOT=\{\{ item\.value\.vault_root \}\}/);
  assert.match(apiUnit, /BRAI_VAULT_ROOT=\{\{ item\.value\.vault_root \}\}/);
  assert.match(staticApiUnit, /BRAI_VAULT_ROOT=\/srv\/projects\/brai\/vault/);
  assert.match(unit, /BRAI_CODEX_REQUIREMENTS_FILE=\{\{ brai_codex_broker_requirements \}\}/);
  assert.match(unit, /BRAI_CODEX_SECCOMP_FILE=\{\{ brai_codex_broker_seccomp \}\}/);
  assert.match(unit, /BRAI_CODEX_APPARMOR_PROFILE=\{\{ brai_codex_broker_apparmor_profile \}\}/);
  assert.match(unit, /User=\{\{ brai_codex_broker_user \}\}/);
  assert.match(unit, /Group=\{\{ brai_deploy_user \}\}/);
  assert.match(unit, /SupplementaryGroups=docker \{\{ brai_service_group \}\} \{\{ brai_codex_auth_group \}\} \{\{ brai_source_group \}\}/);
  assert.match(unit, /RuntimeDirectoryMode=0750/);
  assert.match(unit, /ProtectSystem=strict/);
  assert.match(unit, /RestrictAddressFamilies=AF_UNIX/);
  assert.doesNotMatch(unit, /ListenStream|0\.0\.0\.0|:[0-9]{2,5}/);
});

test("every environment has a private broker unit/socket and deploy restart wiring", () => {
  const environments = JSON.parse(read("deploy/environments.json")).environments;
  const services = new Set();
  const sockets = new Set();
  for (const [name, environment] of Object.entries(environments)) {
    assert.equal(environment.brokerServiceName, `brai-codex-broker-${name}.service`);
    assert.equal(environment.brokerSocketPath, `/run/brai-codex-broker-${name}/broker.sock`);
    services.add(environment.brokerServiceName);
    sockets.add(environment.brokerSocketPath);
  }
  assert.equal(services.size, Object.keys(environments).length);
  assert.equal(sockets.size, Object.keys(environments).length);
  const deploy = read("deploy/scripts/deploy-branch.sh");
  assert.match(deploy, /BRAI_BROKER_ALREADY_RESTARTED/);
  assert.match(deploy, /services\/brai_codex_broker\/src\/check\.mjs/);
  const ciDeploy = read("deploy/scripts/ci-ssh-deploy.sh");
  assert.ok(ciDeploy.indexOf("Starting provisional $BROKER_SERVICE_NAME") < ciDeploy.indexOf("Starting provisional $SERVICE_NAME"));
  const release = read("deploy/scripts/ci-ssh-release-slot.sh");
  assert.match(release, /stop_preview_unit_if_exists "brai-codex-broker-preview-\$SLOT_LOWER\.service"/);
});

test("Ansible owns protected auth/image/state wiring and Caddy exposes no broker route", () => {
  const playbook = read("deploy/ansible/brai.yml");
  const vars = read("deploy/ansible/group_vars/brai.yml");
  const sudoers = read("deploy/ansible/templates/brai-deploy-sudoers.j2");
  const config = read("deploy/ansible/templates/brai-codex-runtime-config.toml.j2");
  const requirements = read("deploy/ansible/templates/brai-codex-runtime-requirements.toml.j2");
  const seccomp = read("deploy/ansible/templates/brai-codex-seccomp.json.j2");
  const apparmor = read("deploy/ansible/templates/brai-codex-app-server.apparmor.j2");
  const previewCleanup = read("deploy/ansible/templates/brai-codex-cleanup-preview-state.sh.j2");
  const broker = read("services/brai_codex_broker/src/broker.mjs");
  const caddy = read("deploy/ansible/templates/Caddyfile.j2");
  assert.match(playbook, /Create isolated Brai Codex broker user[\s\S]*?- "\{\{ brai_source_group \}\}"[\s\S]*?- "\{\{ brai_deploy_user \}\}"/);
  assert.match(playbook, /Create service group[\s\S]*?tags:\n\s+- brai-codex-broker\n\s+- targeted-infra-apply/);
  assert.match(playbook, /Create Brai Codex auth group[\s\S]*?tags:\n\s+- brai-goal-agents\n\s+- brai-codex-broker\n\s+- targeted-infra-apply/);
  assert.match(playbook, /Build pinned Brai Codex image/);
  assert.match(playbook, /Create Brai Codex egress network/);
  assert.match(playbook, /Install enforced Brai Codex runtime requirements/);
  assert.match(playbook, /Install Moby-derived Brai Codex seccomp profile/);
  assert.match(playbook, /Load Brai Codex AppArmor profile/);
  assert.match(playbook, /Install Brai Codex broker systemd units/);
  assert.match(playbook, /Stop Brai Codex brokers without deployed source[\s\S]*?enabled: false[\s\S]*?state: stopped/);
  assert.match(playbook, /Install fail-closed Brai Codex Preview state cleanup/);
  assert.match(playbook, /Create non-production environment Vault roots[\s\S]*?owner: "\{\{ brai_deploy_user \}\}"[\s\S]*?group: "\{\{ brai_deploy_user \}\}"[\s\S]*?mode: "2770"[\s\S]*?- brai-codex-broker/);
  assert.match(playbook, /Install deploy user sudoers boundary[\s\S]*?tags:[\s\S]*?- brai-codex-broker/);
  assert.match(vars, /brai_codex_broker_image: brai-codex-app-server:0\.144\.4/);
  assert.match(vars, /brai_codex_broker_requirements: \/srv\/opt\/brai-codex-broker\/requirements\.toml/);
  assert.match(vars, /brai_codex_broker_seccomp: \/srv\/opt\/brai-codex-broker\/seccomp\.json/);
  assert.match(vars, /prod:[\s\S]*?vault_root: "\{\{ brai_syncthing_vault_path \}\}"/);
  for (const name of ["dev", "preview-a", "preview-b", "preview-c", "preview-d", "preview-e"]) {
    assert.match(vars, new RegExp(`vault_root: "\\{\\{ brai_env_root \\}\\}/${name}/vault"`));
  }
  assert.doesNotMatch(vars, /brai_codex_attachment_root/);
  assert.match(sudoers, /systemctl stop brai-codex-broker-\{\{ name \}\}\.service/);
  assert.match(sudoers, /reset-failed brai-codex-broker-\{\{ name \}\}\.service/);
  assert.match(sudoers, /\{\{ brai_codex_preview_cleanup \}\} \{\{ name \}\}/);
  assert.match(previewCleanup, /preview-a\|preview-b\|preview-c\|preview-d\|preview-e/);
  assert.match(previewCleanup, /systemctl is-active --quiet/);
  assert.match(previewCleanup, /find "\$root" -xdev -mindepth 1 -delete/);
  assert.match(config, /approval_policy = "never"/);
  assert.match(config, /default_permissions = "brai-chat"/);
  assert.match(config, /web_search = "disabled"/);
  assert.match(config, /\[features\][\s\S]*apps = false[\s\S]*plugins = false[\s\S]*tool_suggest = false[\s\S]*enable_mcp_apps = false/);
  assert.doesNotMatch(config, /\[permissions\.brai-chat/);
  assert.match(requirements, /allowed_approval_policies = \["never"\]/);
  assert.match(requirements, /allowed_web_search_modes = \[\]/);
  assert.match(requirements, /\[allowed_permission_profiles\]\nbrai-chat = true/);
  assert.match(requirements, /\[permissions\.filesystem\]\ndeny_read = \["\/codex-home"\]/);
  assert.match(requirements, /\[permissions\.brai-chat\.network\]\nenabled = false/);
  assert.match(requirements, /\[features\][\s\S]*apps = false[\s\S]*plugins = false[\s\S]*tool_suggest = false[\s\S]*enable_mcp_apps = false/);
  assert.match(broker, /bindMount\(this\.requirementsPath, "\/etc\/codex\/requirements\.toml", true\)/);
  assert.match(broker, /\/proc\/1\/root\/codex-home\/auth\.json/);
  assert.match(broker, /createSocket\('udp4'\)/);
  assert.match(broker, /d\.bind\(0,'127\.0\.0\.1'/);
  assert.doesNotMatch(broker, /\/proc\/1\/environ/);
  const seccompProfile = JSON.parse(seccomp);
  const unconditional = seccompProfile.syscalls.find((rule) => rule.action === "SCMP_ACT_ALLOW" && !rule.args && !rule.includes && !rule.excludes);
  for (const syscall of ["clone", "clone3", "mount", "pivot_root", "umount2", "unshare"]) assert.ok(unconditional.names.includes(syscall));
  assert.doesNotMatch(seccomp, /"defaultAction": "SCMP_ACT_ALLOW"/);
  assert.match(apparmor, /profile \{\{ brai_codex_broker_apparmor_profile \}\}/);
  assert.match(apparmor, /\n  mount,\n/);
  assert.doesNotMatch(apparmor, /deny mount/);
  for (const path of ["keys", "latency_stats", "sched_debug", "timer_list", "timer_stats"]) {
    assert.match(apparmor, new RegExp(`deny @\\{PROC\\}/${path} rwklx`));
  }
  assert.match(broker, /"systempaths=unconfined"/);
  assert.doesNotMatch(caddy, /codex|broker|app-server/i);
});
