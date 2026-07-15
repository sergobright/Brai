import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { applyCaddyAuthentication, readCaddyCredentials } from '../chrome-devtools-mcp/caddy-auth-policy.js';

const installer = new URL('./install-chrome-devtools-caddy-auth.mjs', import.meta.url);

test('installer is version-pinned and idempotent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brai-caddy-mcp-'));
  fs.mkdirSync(path.join(root, 'build/src/tools'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '1.5.0' }));
  fs.writeFileSync(path.join(root, 'build/src/tools/tools.js'), "import * as consoleTools from './console.js';\nconst rawTools = [\n            ...Object.values(consoleTools),\n];\n");
  const env = { ...process.env, CHROME_DEVTOOLS_MCP_ROOT: root };
  assert.equal(spawnSync(process.execPath, [installer.pathname, '--install'], { env }).status, 0);
  const once = fs.readFileSync(path.join(root, 'build/src/tools/tools.js'), 'utf8');
  assert.equal(spawnSync(process.execPath, [installer.pathname, '--install'], { env }).status, 0);
  assert.equal(fs.readFileSync(path.join(root, 'build/src/tools/tools.js'), 'utf8'), once);
  assert.equal(spawnSync(process.execPath, [installer.pathname, '--check'], { env }).status, 0);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '1.6.0' }));
  assert.notEqual(spawnSync(process.execPath, [installer.pathname, '--install'], { env }).status, 0);

  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '1.5.0' }));
  fs.writeFileSync(path.join(root, 'build/src/tools/tools.js'), 'export const rawTools = [];\n');
  assert.notEqual(spawnSync(process.execPath, [installer.pathname, '--install'], { env }).status, 0);
});

test('credential policy rejects unknown hosts before reading and rejects unsafe files', () => {
  assert.throws(() => readCaddyCredentials('/missing', 'https://example.com'), /not allowed/);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brai-caddy-creds-'));
  const file = path.join(root, 'credentials.txt');
  fs.writeFileSync(file, 'Domain: admin.brightos.world\nUsername: user\nPassword: secret\n', { mode: 0o644 });
  fs.chmodSync(file, 0o644);
  assert.throws(() => readCaddyCredentials(file, 'https://admin.brightos.world'), /group or other/);
  fs.chmodSync(file, 0o600);
  fs.writeFileSync(file, 'Domain: admin.brightos.world\nUsername: user\n');
  assert.throws(() => readCaddyCredentials(file, 'https://admin.brightos.world'), /missing Password/);
});

test('apply and clear never return credentials', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brai-caddy-apply-'));
  const file = path.join(root, 'credentials.txt');
  fs.writeFileSync(file, 'Domain: admin.brightos.world\nUsername: user\nPassword: secret\n', { mode: 0o600 });
  const calls = [];
  const page = { url: () => 'https://admin.brightos.world/', authenticate: async (value) => calls.push(value), reload: async () => {} };
  const applied = await applyCaddyAuthentication(page, 'apply', file);
  const cleared = await applyCaddyAuthentication(page, 'clear', file);
  assert.deepEqual(applied, { host: 'admin.brightos.world', action: 'apply' });
  assert.deepEqual(cleared, { host: 'admin.brightos.world', action: 'clear' });
  assert.equal(calls[0].password, 'secret');
  assert.equal(calls[1], null);
  assert.doesNotMatch(JSON.stringify([applied, cleared]), /user|secret/);
});

test('apply recovers an allowlisted URL from a Chrome error navigation without exposing credentials', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brai-caddy-retry-'));
  const file = path.join(root, 'credentials.txt');
  fs.writeFileSync(file, 'Domain: admin.brightos.world\nUsername: user\nPassword: secret\n', { mode: 0o600 });
  const calls = [];
  const session = {
    send: async () => ({ currentIndex: 1, entries: [{ url: 'about:blank' }, { url: 'https://dev.brai.one/admin' }] }),
    detach: async () => calls.push('detach'),
  };
  const page = {
    url: () => 'chrome-error://chromewebdata/',
    createCDPSession: async () => session,
    authenticate: async (value) => calls.push(value),
    goto: async (url) => calls.push(url),
  };
  const result = await applyCaddyAuthentication(page, 'apply', file);
  assert.deepEqual(result, { host: 'dev.brai.one', action: 'apply' });
  assert.equal(calls.at(-1), 'https://dev.brai.one/admin');
  assert.doesNotMatch(JSON.stringify(result), /user|secret/);
});
