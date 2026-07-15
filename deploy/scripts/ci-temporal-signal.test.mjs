import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const script = new URL('./ci-temporal-signal.sh', import.meta.url).pathname;

test('direct Temporal mode permits only the read-only Preview query without SSH credentials', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brai-temporal-direct-'));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'node'), '#!/usr/bin/env bash\nprintf "%s %s\\n" "$TEMPORAL_ADDRESS" "$*"\n');
  fs.chmodSync(path.join(bin, 'node'), 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, BRAI_TEMPORAL_DIRECT: 'true', BRAI_TEMPORAL_REQUIRED: 'true' };
  const query = spawnSync('bash', [script, 'query-preview-deploy', '--branch', 'codex/test', '--sha', 'a'.repeat(40)], { env, encoding: 'utf8' });
  assert.equal(query.status, 0, query.stderr);
  assert.match(query.stdout, /127\.0\.0\.1:7233/);
  assert.match(query.stdout, /query-preview-deploy/);
  const dispatch = spawnSync('bash', [script, 'dispatch-preview-deploy'], { env, encoding: 'utf8' });
  assert.notEqual(dispatch.status, 0);
  assert.match(dispatch.stderr, /only permits read-only/);
});
