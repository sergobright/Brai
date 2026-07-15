import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const file = 'landing/public/versions.html';

test('versions landing renders the normalized public history safely', async () => {
  const html = await readFile(file, 'utf8');

  assert.match(html, /https:\/\/api\.brai\.one\/v1\/version-history/);
  assert.match(html, /new URLSearchParams\(\{ limit: "30" \}\)/);
  assert.match(html, /query\.set\("type", selectedType\)/);
  assert.match(html, /query\.set\("cursor", nextCursor\)/);
  assert.match(html, /payload\.next_cursor/);

  assert.match(html, /\["", "All"\]/);
  assert.match(html, /\["build", "Build"\]/);
  assert.match(html, /\["apk", "APK"\]/);
  assert.match(html, /knownTypes\.set\(item\.type/);

  for (const state of [
    'Loading versions…',
    'Could not load version history.',
    'Try again',
    'No versions found for this filter.',
    'No pull request is attached to this version.',
    'Load more',
  ]) {
    assert.ok(html.includes(state), `missing UI state: ${state}`);
  }

  assert.match(html, /document\.createElement\(tag\)/);
  assert.match(html, /node\.textContent = String\(text\)/);
  assert.match(html, /element\("details", "pull-request"\)/);
  assert.match(html, /pullRequest\.body \|\| "No public PR description\."/);
  assert.doesNotMatch(html, /\.innerHTML\s*=/);
  assert.doesNotMatch(html, /insertAdjacentHTML|document\.write|\beval\s*\(/);
  assert.doesNotMatch(html, /<article class="timeline-item">/);
});
