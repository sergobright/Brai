import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('targeted infra apply is allowlisted, main-bound, and checks before applying', () => {
  const script = fs.readFileSync(new URL('./apply-main-infra.sh', import.meta.url), 'utf8');
  assert.match(script, /TARGET" != "brai-caddy" && "\$TARGET" != "brai-vault"/);
  assert.match(script, /branch --show-current/);
  assert.match(script, /status --porcelain/);
  assert.match(script, /rev-parse origin\/main/);
  assert.match(script, /safe\.directory=\$ROOT/);
  assert.match(script, /BRAI_ANSIBLE_INVENTORY:-localhost,/);
  assert.match(script, /\/srv\/opt\/ansible\/bin\/ansible-playbook/);
  const check = script.indexOf('--check --diff');
  const apply = script.indexOf('if [[ "$MODE" == "--apply" ]]');
  assert.ok(check > 0 && check < apply);
});
