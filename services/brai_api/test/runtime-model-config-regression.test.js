import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('Brai API service retries use the supported primary Codex model by default', () => {
  const files = [
    new URL('../../../deploy/systemd/brai-api.service', import.meta.url),
    new URL('../../../deploy/ansible/templates/brai-api.service.j2', import.meta.url)
  ];

  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    assert.match(source, /BRAI_CODEX_MODEL=gpt-5\.4-mini/);
    assert.doesNotMatch(source, /BRAI_CODEX_FALLBACK_MODEL=/);
  }
});
