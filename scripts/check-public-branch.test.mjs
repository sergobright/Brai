import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', env: isolatedGitEnv() });
  assert.equal(result.status, 0, result.stderr);
}

function isolatedGitEnv() {
  const env = { ...process.env };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX']) delete env[name];
  return env;
}

test('public guard checks untracked paths and reports content matches by path only', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brai-public-guard-'));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.copyFileSync(new URL('./check-public-branch.mjs', import.meta.url), path.join(root, 'scripts/check-public-branch.mjs'));
  fs.writeFileSync(path.join(root, 'README.md'), 'clean\n');
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'base');

  fs.writeFileSync(path.join(root, '.env.local'), 'VALUE=hidden\n');
  let result = spawnSync(process.execPath, ['scripts/check-public-branch.mjs'], {
    cwd: root,
    encoding: 'utf8',
    env: isolatedGitEnv(),
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /\.env\.local/);
  fs.rmSync(path.join(root, '.env.local'));

  const secret = `AKIA${'A'.repeat(16)}`;
  fs.writeFileSync(path.join(root, 'leak.txt'), `${secret}\n`);
  result = spawnSync(process.execPath, ['scripts/check-public-branch.mjs'], {
    cwd: root,
    encoding: 'utf8',
    env: isolatedGitEnv(),
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /leak\.txt/);
  assert.doesNotMatch(result.stderr, new RegExp(secret));
});
