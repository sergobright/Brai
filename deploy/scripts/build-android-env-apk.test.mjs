import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('local Android mode is debug-only and exits before release publication', () => {
  const build = fs.readFileSync(new URL('./build-android-env-apk.sh', import.meta.url), 'utf8');
  const unit = fs.readFileSync(new URL('../../scripts/brai-android-test.sh', import.meta.url), 'utf8');
  assert.match(build, /--local-debug/);
  assert.match(build, /GRADLE_TASK="\$\{GRADLE_TASK%Release\}Debug"/);
  assert.match(build, /BRAI_APP_VERSION:-0\.0\.0/);
  assert.match(build, /LOCAL_DEBUG" != "true" && -f "\$SIGNING_ENV/);
  assert.match(build, /unset BRAI_ANDROID_KEYSTORE_PATH BRAI_ANDROID_STORE_PASSWORD BRAI_ANDROID_KEY_ALIAS BRAI_ANDROID_KEY_PASSWORD/);
  assert.match(build, /run_capacitor_sync/);
  assert.ok(build.indexOf('local-debug-apk=') < build.indexOf('publish-capacitor-apk.sh'));
  assert.match(unit, /:app:testProductionDebugUnitTest/);
  assert.match(unit, /BRAI_APP_VERSION:-0\.0\.0/);
  assert.match(unit, /unset BRAI_ANDROID_KEYSTORE_PATH BRAI_ANDROID_STORE_PASSWORD BRAI_ANDROID_KEY_ALIAS BRAI_ANDROID_KEY_PASSWORD/);
  assert.match(unit, /npm run app:build/);
  assert.match(unit, /run_capacitor_sync/);
  assert.match(unit, /\/srv\/opt\/android-build-env\/build-android\.sh/);
});
