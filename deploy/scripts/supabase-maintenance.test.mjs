import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const maintenancePath = path.join(import.meta.dirname, "supabase-maintenance.sh");

test("Supabase maintenance is a no-op dry-run unless --apply is explicit", () => {
  const syntax = spawnSync("bash", ["-n", maintenancePath], { encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
  const dryRun = spawnSync("bash", [maintenancePath, "reconfigure-pooler"], { encoding: "utf8" });
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.deepEqual(JSON.parse(dryRun.stdout), {
    ok: true,
    mode: "dry-run",
    operation: "reconfigure-pooler",
    changes: false,
  });
});

test("Supabase maintenance takes every deploy lock in canonical order", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "brai-supabase-maintenance-"));
  const envsRoot = path.join(root, "envs");
  const releaseDir = path.join(root, "releases");
  const names = ["prod", "dev", "preview-a", "preview-b", "preview-c", "preview-d", "preview-e"];
  for (const name of names) {
    fs.mkdirSync(path.join(envsRoot, name), { recursive: true });
    fs.writeFileSync(path.join(envsRoot, name, ".source-operation.lock"), "");
  }
  fs.mkdirSync(path.join(envsRoot, "ci-uploads"));
  fs.writeFileSync(path.join(envsRoot, "ci-uploads", ".staging-operation.lock"), "");
  fs.writeFileSync(path.join(envsRoot, "preview-slots.lock"), "");
  fs.mkdirSync(releaseDir);

  const result = spawnSync("bash", ["-c", 'source "$1"; lock_paths', "_", maintenancePath], {
    encoding: "utf8",
    env: { ...process.env, BRAI_ENVS_ROOT: envsRoot, BRAI_RELEASE_DIR: releaseDir },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split("\n"), [
    ...names.map((name) => path.join(envsRoot, name, ".source-operation.lock")),
    path.join(envsRoot, "ci-uploads", ".staging-operation.lock"),
    releaseDir,
    path.join(envsRoot, "preview-slots.lock"),
  ]);

  fs.rmSync(path.join(envsRoot, "preview-b", ".source-operation.lock"));
  const missing = spawnSync("bash", ["-c", 'source "$1"; lock_paths', "_", maintenancePath], {
    encoding: "utf8",
    env: { ...process.env, BRAI_ENVS_ROOT: envsRoot, BRAI_RELEASE_DIR: releaseDir },
  });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /missing or unsafe/);
});

test("pooler reconfiguration is repo-managed, bounded, and canaried", () => {
  const script = fs.readFileSync(maintenancePath, "utf8");
  const bootstrap = fs.readFileSync(path.join(repoRoot, "deploy/supabase/pooler.exs"), "utf8");
  const playbook = fs.readFileSync(path.join(repoRoot, "deploy/ansible/brai.yml"), "utf8");
  const sudoers = fs.readFileSync(path.join(repoRoot, "deploy/ansible/templates/brai-deploy-sudoers.j2"), "utf8");
  const deploy = fs.readFileSync(path.join(repoRoot, "deploy/scripts/ci-ssh-deploy.sh"), "utf8");

  assert.doesNotMatch(bootstrap, /POOLER_TENANT_ID|brightos/);
  assert.match(bootstrap, /brai-prod/);
  assert.match(bootstrap, /brai-nonprod/);
  assert.match(script, /DELETE FROM _supavisor\.cluster_tenants/);
  assert.match(script, /DELETE FROM _supavisor\.tenants/);
  assert.match(script, /'brightos', 'brightos-prod', 'brightos-nonprod'/);
  assert.match(script, /ARRAY\['brai-nonprod', 'brai-prod'\]::text\[\]/);
  assert.match(script, /Supavisor tenant metadata is not restricted to Brai targets/);
  assert.match(script, /"legacyTenantsRemoved":true/);
  assert.match(script, /--set ON_ERROR_STOP=1/);
  assert.doesNotMatch(script, /\\\$\\\$/);
  assert.match(script, /systemctl stop "\$\{API_SERVICES\[@\]\}"/);
  assert.match(script, /up -d --force-recreate supavisor/);
  assert.match(script, /wait_for_auth_canary 3020/);
  assert.equal(script.match(/--connect-timeout 2 --max-time 5/g)?.length, 2);
  assert.match(script, /SCRAM\.\*timeout\|timeout\.\*SCRAM\|Circuit breaker\|ECIRCUITBREAKER/);
  assert.match(script, /BRAI_SUPAVISOR_TENANT_ISOLATION/);
  assert.match(script, /Rollback restored production; non-production APIs remain stopped/);
  assert.doesNotMatch(script, /start_previously_active_services/);
  const install = script.indexOf('/usr/bin/install -o root -g root -m 0644 "$MANAGED_POOLER_CONFIG" "$LIVE_POOLER_CONFIG"');
  const deleteLegacy = script.indexOf("delete_legacy_tenant_metadata", install);
  const recreate = script.indexOf("compose_recreate_pooler", deleteLegacy);
  const assertTargets = script.indexOf("assert_target_tenant_metadata", recreate);
  const rewrite = script.indexOf("rewrite_runtime_tenants", assertTargets);
  assert.ok(install > 0 && install < deleteLegacy && deleteLegacy < recreate && recreate < assertTargets && assertTargets < rewrite);
  assert.doesNotMatch(script, /force-recreate "\$@"/);
  assert.match(playbook, /deploy\/supabase\/pooler\.exs|\.\.\/supabase\/pooler\.exs/);
  assert.match(playbook, /dest: "\{\{ brai_supabase_maintenance \}\}"/);
  assert.match(sudoers, /brai_supabase_maintenance \}\} --apply reconfigure-pooler/);
  assert.doesNotMatch(sudoers, /brai_supabase_maintenance \}\} --apply \*/);
  assert.match(deploy, /supavisor-tenants\.mjs assert-url --environment "\$ENVIRONMENT"/);
});
