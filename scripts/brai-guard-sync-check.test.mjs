import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const script = new URL('./brai-guard-sync-check.sh', import.meta.url).pathname;

test('guard sync uses the explicit canonical main source, never the calling branch copy', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brai-guard-sync-'));
  const source = path.join(root, 'main-task.mjs');
  const installed = path.join(root, 'installed-task.mjs');
  fs.writeFileSync(source, 'canonical\n');
  fs.writeFileSync(installed, 'frozen-branch\n');
  const env = { ...process.env, BRAI_GUARD_SOURCE_TASK: source, BRAI_INSTALLED_GUARD_TASK: installed };
  assert.notEqual(spawnSync('bash', [script, '--check'], { env }).status, 0);
  assert.equal(spawnSync('bash', [script, '--install'], { env }).status, 0);
  assert.equal(fs.readFileSync(installed, 'utf8'), 'canonical\n');
  assert.equal(spawnSync('bash', [script, '--check'], { env }).status, 0);
});
