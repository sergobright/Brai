import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const LANDING_FILES = [
  'landing/public/index.html',
  'landing/public/versions.html',
  'landing/public/auth-link.js',
  'landing/public/styles.css'
];

test('public landing exposes Sign In app button without secrets', async () => {
  const files = Object.fromEntries(await Promise.all(
    LANDING_FILES.map(async (file) => [file, await readFile(file, 'utf8')])
  ));

  for (const htmlFile of ['landing/public/index.html', 'landing/public/versions.html']) {
    const html = files[htmlFile];
    assert.match(html, /data-auth-link/);
    assert.match(html, />Sign In</);
    assert.match(html, /href="https:\/\/app\.brightos\.world\/"/);
    assert.match(html, /src="\/auth-link\.js"/);
  }

  assert.match(files['landing/public/auth-link.js'], /https:\/\/app\.brightos\.world\/api\/auth\/session/);
  assert.match(files['landing/public/auth-link.js'], /credentials: "include"/);
  assert.match(files['landing/public/auth-link.js'], /textContent = "APP"/);

  const publicBundle = Object.values(files).join('\n');
  assert.doesNotMatch(publicBundle, /Bearer\s+[A-Za-z0-9._-]+/);
  assert.doesNotMatch(publicBundle, /BRAI_(TOKEN|INBOX_API_KEY|WEB_PASSWORD|SESSION_SECRET)/);
});
