import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  SESSION_SECRET,
  WEB_PASSWORD,
  actionEvent,
  createFixture,
  inboxRequest,
  jsonRequest,
  request
} from '../test-support/api.js';
import { OTP_ALLOWED_ATTEMPTS, OTP_EMAIL_SUBJECT, OTP_EXPIRES_IN_SECONDS, OTP_RESEND_AFTER_SECONDS, OTP_RESEND_STRATEGY, renderOtpEmail } from '../src/auth.js';
import { createUserVaultPreparer } from '../src/server.js';

function seedPrimaryUser(fixture, id = 'test-user') {
  fixture.store.db
    .prepare(`
      INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt")
      VALUES (?, ?, ?, true, ?, ?)
    `)
    .run(id, 'Test User', `${id}@example.com`, '2026-07-01T09:00:00.000Z', '2026-07-01T09:00:00.000Z');
  fixture.store.db
    .prepare(`
      INSERT INTO app_settings (key, value, updated_at_utc)
      VALUES ('primary_user_id', ?, ?)
    `)
    .run(id, '2026-07-01T09:00:00.000Z');
}

test('email OTP message renders the reusable responsive card', () => {
  const message = renderOtpEmail({ otp: '<123456>' });

  assert.equal(OTP_EMAIL_SUBJECT, 'Код входа в Brai');
  assert.match(message.html, /Ваш одноразовый код/);
  assert.match(message.html, /Введите этот код в Brai, чтобы завершить вход\./);
  assert.match(message.html, /Код действует 5 минут\./);
  assert.match(message.html, /max-width:600px/);
  assert.match(message.html, /@media only screen and \(max-width: 620px\)/);
  assert.match(message.html, /<img src="https:\/\/brai\.one\/brai-logo-email-white-bg\.png"/);
  assert.match(message.html, /alt="Brai"/);
  assert.doesNotMatch(message.html, /cid:/);
  assert.doesNotMatch(message.html, /data:image/);
  assert.deepEqual(message.attachments, []);
  assert.match(message.html, /&lt;123456&gt;/);
  assert.doesNotMatch(message.html, /<123456>/);
  assert.match(message.text, /<123456>/);
  assert.match(message.text, /Brai · brai\.one/);
});

test('test email login creates or reuses the primary Better Auth user without sending OTP mail', async () => {
  const sentOtps = [];
  const fixture = await createFixture([
    '2026-07-01T09:00:00.000Z',
    '2026-07-01T09:00:01.000Z',
    '2026-07-01T09:00:02.000Z',
    '2026-07-01T09:00:03.000Z',
    '2026-07-01T09:00:04.000Z'
  ], {
    sessionSecret: SESSION_SECRET,
    testEmailLogin: true,
    sendOtp: ({ email, otp }) => sentOtps.push({ email, otp })
  });
  try {
    const session = await jsonRequest(fixture.url, '/auth/session');
    assert.equal(session.status, 200);
    assert.equal(session.body.authenticated, false);
    assert.equal(session.headers.get('set-cookie'), null);

    const unauthenticatedDeviceToken = await jsonRequest(fixture.url, '/v1/brai-cmd/device-token', {
      method: 'POST',
      headers: { origin: 'capacitor://localhost' },
      body: JSON.stringify({ deviceId: 'unauthenticated-install' })
    });
    assert.equal(unauthenticatedDeviceToken.status, 401);

    const empty = await jsonRequest(fixture.url, '/auth/test-email-login', {
      method: 'POST',
      headers: { origin: 'https://a.test.brightos.world' },
      body: JSON.stringify({ email: '' })
    });
    assert.equal(empty.status, 400);
    assert.equal(empty.headers.get('set-cookie'), null);

    const rejectedOrigin = await jsonRequest(fixture.url, '/auth/test-email-login', {
      method: 'POST',
      headers: { origin: 'https://app.brai.one' },
      body: JSON.stringify({ email: 'auth.user@example.test' })
    });
    assert.equal(rejectedOrigin.status, 403);
    assert.equal(rejectedOrigin.headers.get('set-cookie'), null);

    const first = await jsonRequest(fixture.url, '/auth/test-email-login', {
      method: 'POST',
      headers: { origin: 'capacitor://localhost' },
      body: JSON.stringify({ email: ' Auth.User@example.test ' })
    });
    assert.equal(first.status, 200);
    assert.equal(first.body.authenticated, true);
    assert.equal(first.body.user.email, 'auth.user@example.test');
    assert.equal(fixture.store.primaryUserId(), first.body.user.id);
    assert.equal(sentOtps.length, 0);
    const firstCookie = first.headers.get('set-cookie');
    assert.match(firstCookie, /better-auth\.session_token=/);
    assert.match(firstCookie, /SameSite=None/i);
    assert.match(firstCookie, /Secure/i);
    const firstBearer = first.headers.get('set-auth-token');
    assert.match(firstBearer, /^[^;\s]+\.[^;\s]+$/);
    assert.match(first.headers.get('access-control-expose-headers') ?? '', /(?:^|,)\s*set-auth-token\s*(?:,|$)/i);

    const restoredNativeSession = await jsonRequest(fixture.url, '/auth/session', {
      headers: { cookie: firstCookie, origin: 'https://localhost' }
    });
    assert.equal(restoredNativeSession.status, 200);
    assert.equal(restoredNativeSession.body.authenticated, true);
    const restoredBearer = restoredNativeSession.headers.get('set-auth-token');
    assert.equal(decodeURIComponent(restoredBearer), firstBearer);

    const bearerActivities = await jsonRequest(fixture.url, '/v1/activities', {
      headers: { authorization: `Bearer ${restoredBearer}`, origin: 'https://localhost' }
    });
    assert.equal(bearerActivities.status, 200);
    assert.equal(bearerActivities.headers.get('access-control-allow-origin'), 'https://localhost');

    const activities = await jsonRequest(fixture.url, '/v1/activities', {
      headers: { cookie: firstCookie, origin: 'capacitor://localhost' }
    });
    assert.equal(activities.status, 200);

    const forbiddenDeviceToken = await jsonRequest(fixture.url, '/v1/brai-cmd/device-token', {
      method: 'POST',
      headers: { cookie: firstCookie, origin: 'https://untrusted.example' },
      body: JSON.stringify({ deviceId: 'authenticated-install-1' })
    });
    assert.equal(forbiddenDeviceToken.status, 403);

    const invalidDeviceToken = await jsonRequest(fixture.url, '/v1/brai-cmd/device-token', {
      method: 'POST',
      headers: { cookie: firstCookie, origin: 'capacitor://localhost' },
      body: JSON.stringify({ deviceId: 'x'.repeat(201) })
    });
    assert.equal(invalidDeviceToken.status, 400);
    assert.equal(invalidDeviceToken.body.error, 'invalid_device_id');

    const anonymousFirstDevice = await jsonRequest(fixture.url, '/v1/access/request', {
      method: 'POST',
      body: JSON.stringify({ displayName: 'Before login', deviceId: 'authenticated-install-1' })
    });
    const anonymousSecondDevice = await jsonRequest(fixture.url, '/v1/access/request', {
      method: 'POST',
      body: JSON.stringify({ displayName: 'Before login', deviceId: 'authenticated-install-2' })
    });
    assert.equal(anonymousFirstDevice.status, 201);
    assert.equal(anonymousSecondDevice.status, 201);

    fixture.store.setBraiCmdSettings({ registrationEnabled: false });
    const deviceToken = await jsonRequest(fixture.url, '/v1/brai-cmd/device-token', {
      method: 'POST',
      headers: { cookie: firstCookie, origin: 'capacitor://localhost' },
      body: JSON.stringify({
        deviceId: 'authenticated-install-1',
        clientVersion: '60006',
        appPackage: 'world.brightos.brai.preview.b.work'
      })
    });
    assert.equal(deviceToken.status, 201);
    assert.match(deviceToken.body.token, /^bl_/);
    assert.equal(deviceToken.body.status, 'pending');
    assert.equal((await jsonRequest(fixture.url, '/v1/health', {
      headers: {
        authorization: `Bearer ${deviceToken.body.token}`,
        'x-brai-cmd-device-id': 'authenticated-install-1'
      }
    })).status, 401);

    const browserActivation = await jsonRequest(fixture.url, '/v1/brai-cmd/account-access/activate', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${anonymousFirstDevice.body.token}`,
        'x-brai-cmd-device-id': 'authenticated-install-1',
        origin: 'capacitor://localhost'
      },
      body: JSON.stringify({ link_token: deviceToken.body.token })
    });
    assert.equal(browserActivation.status, 403);
    assert.equal(browserActivation.body.error, 'native_transport_required');

    const activated = await jsonRequest(fixture.url, '/v1/brai-cmd/account-access/activate', {
      method: 'POST',
      headers: {
        'x-brai-cmd-device-id': 'authenticated-install-1'
      },
      body: JSON.stringify({ link_token: deviceToken.body.token })
    });
    assert.equal(activated.status, 201);
    assert.match(activated.body.token, /^aw_/);
    assert.equal(activated.body.account_user_id, first.body.user.id);
    const firstDeviceToken = fixture.store.db.prepare(`
      SELECT user_id, source, status, device_id_hash, token_hash, expires_at_utc
      FROM brai_cmd_access_tokens
      WHERE user_id = ? AND status = 'active'
    `).get(first.body.user.id);
    assert.equal(firstDeviceToken.user_id, first.body.user.id);
    assert.equal(firstDeviceToken.source, 'authenticated');
    assert.equal(firstDeviceToken.status, 'active');
    assert.notEqual(firstDeviceToken.device_id_hash, 'authenticated-install-1');
    assert.notEqual(firstDeviceToken.token_hash, activated.body.token);
    assert.ok(firstDeviceToken.expires_at_utc > '2026-07-01T09:00:00.000Z');

    const health = await jsonRequest(fixture.url, '/v1/health', {
      headers: {
        authorization: `Bearer ${activated.body.token}`,
        'x-brai-cmd-device-id': 'authenticated-install-1'
      }
    });
    assert.equal(health.status, 200);

    const replay = await jsonRequest(fixture.url, '/v1/brai-cmd/account-access/activate', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${activated.body.token}`,
        'x-brai-cmd-device-id': 'authenticated-install-1'
      },
      body: JSON.stringify({ link_token: deviceToken.body.token })
    });
    assert.equal(replay.status, 409);
    assert.equal(replay.body.error, 'link_token_used');

    const replacement = await jsonRequest(fixture.url, '/v1/brai-cmd/device-token', {
      method: 'POST',
      headers: { cookie: firstCookie, origin: 'capacitor://localhost' },
      body: JSON.stringify({ deviceId: 'authenticated-install-1' })
    });
    assert.equal(replacement.status, 201);
    assert.notEqual(replacement.body.token, deviceToken.body.token);
    const replacementActivation = await jsonRequest(fixture.url, '/v1/brai-cmd/account-access/activate', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${activated.body.token}`,
        'x-brai-cmd-device-id': 'authenticated-install-1'
      },
      body: JSON.stringify({ link_token: replacement.body.token })
    });
    assert.equal(replacementActivation.status, 201);
    const deviceTokenStatuses = fixture.store.db.prepare(`
      SELECT status FROM brai_cmd_access_tokens
      WHERE user_id = ?
      ORDER BY created_at_utc, id
    `).all(first.body.user.id).map((row) => row.status).sort();
    assert.deepEqual(deviceTokenStatuses, ['active', 'revoked']);

    const concurrentLinks = await Promise.all([
      jsonRequest(fixture.url, '/v1/brai-cmd/device-token', {
        method: 'POST',
        headers: { cookie: firstCookie, origin: 'capacitor://localhost' },
        body: JSON.stringify({ deviceId: 'authenticated-install-1' })
      }),
      jsonRequest(fixture.url, '/v1/brai-cmd/device-token', {
        method: 'POST',
        headers: { cookie: firstCookie, origin: 'capacitor://localhost' },
        body: JSON.stringify({ deviceId: 'authenticated-install-1' })
      })
    ]);
    assert.deepEqual(concurrentLinks.map((response) => response.status), [201, 201]);
    const concurrent = await Promise.all(concurrentLinks.map((response) => jsonRequest(
      fixture.url,
      '/v1/brai-cmd/account-access/activate',
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${replacementActivation.body.token}`,
          'x-brai-cmd-device-id': 'authenticated-install-1'
        },
        body: JSON.stringify({ link_token: response.body.token })
      }
    )));
    assert.equal(concurrent.filter((response) => response.status === 201).length, 1);
    assert.equal(fixture.store.db.prepare(`
      SELECT COUNT(*) AS count
      FROM brai_cmd_access_tokens
      WHERE user_id = ? AND status = 'active'
    `).get(first.body.user.id).count, 1);
    const activeConcurrentToken = concurrent.find((response) => response.status === 201).body.token;
    assert.equal((await jsonRequest(fixture.url, '/v1/health', {
        headers: {
          authorization: `Bearer ${activeConcurrentToken}`,
          'x-brai-cmd-device-id': 'authenticated-install-1'
        }
      })).status, 200);

    const secondDevice = await jsonRequest(fixture.url, '/v1/brai-cmd/device-token', {
      method: 'POST',
      headers: { cookie: firstCookie, origin: 'capacitor://localhost' },
      body: JSON.stringify({ deviceId: 'authenticated-install-2' })
    });
    assert.equal(secondDevice.status, 201);
    const secondDeviceActivation = await jsonRequest(fixture.url, '/v1/brai-cmd/account-access/activate', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${anonymousSecondDevice.body.token}`,
        'x-brai-cmd-device-id': 'authenticated-install-2'
      },
      body: JSON.stringify({ link_token: secondDevice.body.token })
    });
    assert.equal(secondDeviceActivation.status, 201);
    assert.equal(fixture.store.db.prepare(`
      SELECT COUNT(*) AS count
      FROM brai_cmd_access_tokens
      WHERE user_id = ? AND status = 'active'
    `).get(first.body.user.id).count, 2);

    const revoked = await jsonRequest(fixture.url, '/v1/brai-cmd/access/revoke-self', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${secondDeviceActivation.body.token}`,
        'x-brai-cmd-device-id': 'authenticated-install-2'
      },
      body: '{}'
    });
    assert.equal(revoked.status, 200);
    assert.equal((await jsonRequest(fixture.url, '/v1/health', {
      headers: {
        authorization: `Bearer ${secondDeviceActivation.body.token}`,
        'x-brai-cmd-device-id': 'authenticated-install-2'
      }
    })).status, 401);

    const repeat = await jsonRequest(fixture.url, '/auth/test-email-login', {
      method: 'POST',
      headers: { origin: 'https://a.test.brai.one' },
      body: JSON.stringify({ email: 'auth.user@example.test' })
    });
    assert.equal(repeat.status, 200);
    assert.equal(repeat.body.user.id, first.body.user.id);
    assert.equal(sentOtps.length, 0);

    const second = await jsonRequest(fixture.url, '/auth/test-email-login', {
      method: 'POST',
      headers: { origin: 'https://a.test.brai.one' },
      body: JSON.stringify({ email: 'second@example.com' })
    });
    assert.equal(second.status, 200);
    assert.equal(second.body.user.id, first.body.user.id);
    assert.equal(second.body.user.email, first.body.user.email);
    assert.equal(fixture.store.primaryUserId(), first.body.user.id);
    assert.equal(sentOtps.length, 0);
  } finally {
    await fixture.close();
  }
});

test('email login finalizes preliminary Brai Cmd users without renaming existing accounts', async () => {
  const fixture = await createFixture([
    '2026-07-01T09:30:00.000Z',
    '2026-07-01T09:30:01.000Z',
    '2026-07-01T09:30:02.000Z',
    '2026-07-01T09:30:03.000Z',
    '2026-07-01T09:30:04.000Z',
    '2026-07-01T09:30:05.000Z'
  ], {
    sessionSecret: SESSION_SECRET,
    testEmailLogin: true
  });
  try {
    const existing = await jsonRequest(fixture.url, '/auth/test-email-login', {
      method: 'POST',
      headers: { origin: 'capacitor://localhost' },
      body: JSON.stringify({ email: 'existing@example.com', name: 'Existing Account' })
    });
    assert.equal(existing.status, 200);
    assert.equal(existing.body.user.name, 'Existing Account');

    const preliminary = await jsonRequest(fixture.url, '/v1/brai-cmd/preliminary-profile', {
      method: 'POST',
      body: JSON.stringify({
        displayName: 'Preliminary Name',
        deviceFingerprint: 'auth-fingerprint-1',
        deviceId: 'install-1'
      })
    });
    assert.equal(preliminary.status, 201);

    const reused = await jsonRequest(fixture.url, '/auth/test-email-login', {
      method: 'POST',
      headers: { origin: 'capacitor://localhost' },
      body: JSON.stringify({
        email: 'existing@example.com',
        name: 'Typed Later',
        preliminaryUserId: preliminary.body.preliminaryUserId,
        preliminaryClaimToken: preliminary.body.preliminaryClaimToken,
        deviceFingerprint: 'auth-fingerprint-1'
      })
    });
    assert.equal(reused.status, 200);
    assert.equal(reused.body.user.id, existing.body.user.id);
    assert.equal(reused.body.user.name, 'Existing Account');

    const row = fixture.store.db.prepare('SELECT display_name, status, user_id FROM preliminary_users WHERE id = ?').get(preliminary.body.preliminaryUserId);
    assert.deepEqual(row, {
      display_name: 'Preliminary Name',
      status: 'converted',
      user_id: existing.body.user.id
    });
    assert.equal(
      fixture.store.db.prepare('SELECT name FROM "user" WHERE id = ?').get(existing.body.user.id).name,
      'Existing Account'
    );
  } finally {
    await fixture.close();
  }
});

test('email login can claim an unlinked duplicate preliminary device by fingerprint', async () => {
  const fixture = await createFixture([
    '2026-07-01T09:40:00.000Z',
    '2026-07-01T09:40:01.000Z',
    '2026-07-01T09:40:02.000Z',
    '2026-07-01T09:40:03.000Z'
  ], {
    sessionSecret: SESSION_SECRET,
    testEmailLogin: true
  });
  try {
    const preliminary = await jsonRequest(fixture.url, '/v1/brai-cmd/preliminary-profile', {
      method: 'POST',
      body: JSON.stringify({
        displayName: 'Old Fingerprint',
        deviceFingerprint: 'duplicate-fingerprint',
        deviceId: 'install-old'
      })
    });
    assert.equal(preliminary.status, 201);

    const duplicate = await jsonRequest(fixture.url, '/v1/brai-cmd/preliminary-profile', {
      method: 'POST',
      body: JSON.stringify({
        displayName: 'Fresh Attempt',
        deviceFingerprint: 'duplicate-fingerprint',
        deviceId: 'install-new'
      })
    });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.preliminaryUserId, preliminary.body.preliminaryUserId);

    const login = await jsonRequest(fixture.url, '/auth/test-email-login', {
      method: 'POST',
      headers: { origin: 'capacitor://localhost' },
      body: JSON.stringify({
        email: 'fresh@example.com',
        name: 'Fresh Attempt',
        preliminaryUserId: duplicate.body.preliminaryUserId,
        deviceFingerprint: 'duplicate-fingerprint'
      })
    });
    assert.equal(login.status, 200);

    const row = fixture.store.db.prepare('SELECT display_name, status, user_id FROM preliminary_users WHERE id = ?').get(preliminary.body.preliminaryUserId);
    assert.deepEqual(row, {
      display_name: 'Old Fingerprint',
      status: 'converted',
      user_id: login.body.user.id
    });
  } finally {
    await fixture.close();
  }
});

test('password login requires the configured password and opens the primary account', async () => {
  const fixture = await createFixture([
    '2026-07-01T09:00:00.000Z',
    '2026-07-01T09:00:01.000Z'
  ], {
    sessionSecret: SESSION_SECRET,
    webPassword: WEB_PASSWORD
  });
  try {
    seedPrimaryUser(fixture, 'primary-user');
    const rejected = await jsonRequest(fixture.url, '/auth/login', {
      method: 'POST',
      body: JSON.stringify({ password: 'wrong' })
    });
    assert.equal(rejected.status, 401);
    assert.equal(rejected.headers.get('set-cookie'), null);

    const accepted = await jsonRequest(fixture.url, '/auth/login', {
      method: 'POST',
      body: JSON.stringify({ password: WEB_PASSWORD })
    });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.user.id, 'primary-user');
    assert.match(accepted.headers.get('set-cookie'), /^brai_session=/);
  } finally {
    await fixture.close();
  }
});

test('test email login is unavailable unless explicitly enabled', async () => {
  const fixture = await createFixture(['2026-07-01T09:00:00.000Z'], {
    sessionSecret: SESSION_SECRET
  });
  try {
    seedPrimaryUser(fixture);
    const response = await jsonRequest(fixture.url, '/auth/test-email-login', {
      method: 'POST',
      headers: { origin: 'https://a.test.brightos.world' },
      body: JSON.stringify({ email: 'test-user@example.com' })
    });
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('set-cookie'), null);
  } finally {
    await fixture.close();
  }
});

test('email OTP signs in, claims legacy data, and isolates the next user', async () => {
  const sentOtps = new Map();
  const fixture = await createFixture([
    '2026-07-01T10:00:00.000Z',
    '2026-07-01T10:00:01.000Z',
    '2026-07-01T10:10:00.000Z',
    '2026-07-01T10:10:01.000Z',
    '2026-07-01T10:20:00.000Z',
    '2026-07-01T10:20:01.000Z',
    '2026-07-01T10:20:02.000Z'
  ], {
    sessionSecret: SESSION_SECRET,
    sendOtp: ({ email, otp }) => sentOtps.set(email, otp)
  });

  async function otpLogin(email) {
    const send = await jsonRequest(fixture.url, '/auth/otp/send', {
      method: 'POST',
      body: JSON.stringify({ email })
    });
    assert.equal(send.status, 200);
    assert.equal(send.body.success, true);
    assert.equal(send.body.expires_in_seconds, OTP_EXPIRES_IN_SECONDS);
    assert.equal(send.body.resend_after_seconds, OTP_RESEND_AFTER_SECONDS);
    assert.equal(send.body.resend_strategy, OTP_RESEND_STRATEGY);
    const otp = sentOtps.get(email);
    assert.ok(otp);
    const verify = await jsonRequest(fixture.url, '/auth/otp/verify', {
      method: 'POST',
      body: JSON.stringify({ email, otp })
    });
    assert.equal(verify.status, 200);
    assert.equal(verify.body.authenticated, true);
    assert.equal(verify.body.user.email, email);
    return { cookie: verify.headers.get('set-cookie'), user: verify.body.user };
  }

  try {
    await request(fixture.url, '/v1/activities/events/sync', {
      method: 'POST',
      body: JSON.stringify({
        device: { device_id: 'legacy-web', platform: 'web' },
        events: [
          actionEvent('legacy-action-create', 1, 'create', 'legacy-action', '2026-07-01T09:00:00.000Z', {
            title: 'Legacy action'
          })
        ]
      })
    });
    await request(fixture.url, '/v1/timer/start', { method: 'POST' });
    await request(fixture.url, '/v1/timer/stop', { method: 'POST' });

    const first = await otpLogin('sergey@example.com');
    assert.equal(fixture.store.primaryUserId(), first.user.id);
    assert.equal(
      fixture.store.db
        .prepare("SELECT COUNT(*) AS count FROM activities WHERE user_id = ? AND activity_type_id = 'action'")
        .get(first.user.id).count,
      1
    );
    assert.equal(
      fixture.store.db.prepare("SELECT COUNT(*) AS count FROM events WHERE event_domain = 'timer' AND user_id = ?").get(first.user.id).count,
      2
    );

    const second = await otpLogin('second@example.com');
    assert.notEqual(second.user.id, first.user.id);
    assert.equal(
      fixture.store.db.prepare('SELECT COUNT(*) AS count FROM "user"').get().count,
      2
    );
    const firstActivities = await jsonRequest(fixture.url, '/v1/activities', {
      headers: { cookie: first.cookie }
    });
    const secondActivities = await jsonRequest(fixture.url, '/v1/activities', {
      headers: { cookie: second.cookie }
    });
    assert.equal(firstActivities.body.activities.length, 1);
    assert.equal(secondActivities.body.activities.length, 0);

    await jsonRequest(fixture.url, '/v1/activities/events/sync', {
      method: 'POST',
      headers: { cookie: second.cookie, origin: 'https://app.brai.one' },
      body: JSON.stringify({
        device: { device_id: 'second-web', platform: 'web' },
        events: [
          actionEvent('second-action-create', 1, 'create', 'second-action', '2026-07-01T10:25:00.000Z', {
            title: 'Second action'
          })
        ]
      })
    });
    const firstAfterSecondWrite = await jsonRequest(fixture.url, '/v1/activities', {
      headers: { cookie: first.cookie }
    });
    const secondAfterWrite = await jsonRequest(fixture.url, '/v1/activities', {
      headers: { cookie: second.cookie }
    });
    assert.deepEqual(firstAfterSecondWrite.body.activities.map((item) => item.id), ['legacy-action']);
    assert.deepEqual(secondAfterWrite.body.activities.map((item) => item.id), ['second-action']);
  } finally {
    await fixture.close();
  }
});

test('email OTP resend reuses the active code instead of rotating it', async () => {
  const sentOtps = [];
  const fixture = await createFixture([
    '2026-07-01T10:00:00.000Z',
    '2026-07-01T10:00:20.000Z',
    '2026-07-01T10:00:21.000Z'
  ], {
    sessionSecret: SESSION_SECRET,
    sendOtp: ({ email, otp }) => sentOtps.push({ email, otp })
  });

  try {
    for (let index = 0; index < 2; index += 1) {
      const send = await jsonRequest(fixture.url, '/auth/otp/send', {
        method: 'POST',
        body: JSON.stringify({ email: 'reuse@example.com' })
      });
      assert.equal(send.status, 200);
      assert.equal(send.body.resend_strategy, OTP_RESEND_STRATEGY);
    }
    assert.equal(sentOtps.length, 2);
    assert.equal(sentOtps[1].otp, sentOtps[0].otp);

    const verify = await jsonRequest(fixture.url, '/auth/otp/verify', {
      method: 'POST',
      body: JSON.stringify({ email: 'reuse@example.com', otp: sentOtps[0].otp })
    });
    assert.equal(verify.status, 200);
    assert.equal(verify.body.authenticated, true);
    assert.equal(OTP_ALLOWED_ATTEMPTS, 5);
  } finally {
    await fixture.close();
  }
});

test('email OTP prepares per-user vault folder on successful sign-in', async () => {
  const sentOtps = new Map();
  const prepared = [];
  const fixture = await createFixture([
    '2026-07-01T10:00:00.000Z',
    '2026-07-01T10:00:01.000Z'
  ], {
    sessionSecret: SESSION_SECRET,
    sendOtp: ({ email, otp }) => sentOtps.set(email, otp),
    prepareUserVault: async (user) => prepared.push(user)
  });

  try {
    await jsonRequest(fixture.url, '/auth/otp/send', {
      method: 'POST',
      body: JSON.stringify({ email: 'sergey@example.com' })
    });
    const verify = await jsonRequest(fixture.url, '/auth/otp/verify', {
      method: 'POST',
      body: JSON.stringify({ email: 'sergey@example.com', otp: sentOtps.get('sergey@example.com') })
    });
    assert.equal(verify.status, 200);
    assert.deepEqual(prepared, [{
      userId: verify.body.user.id,
      email: 'sergey@example.com'
    }]);
  } finally {
    await fixture.close();
  }
});

test('email OTP sign-in survives vault preparation failure after consuming OTP', async () => {
  const sentOtps = new Map();
  const errors = [];
  const fixture = await createFixture([
    '2026-07-01T10:00:00.000Z',
    '2026-07-01T10:00:01.000Z',
    '2026-07-01T10:00:02.000Z'
  ], {
    sessionSecret: SESSION_SECRET,
    sendOtp: ({ email, otp }) => sentOtps.set(email, otp),
    prepareUserVault: async () => {
      throw new Error('syncthing unavailable');
    },
    logger: { error: (...args) => errors.push(args) }
  });

  try {
    await jsonRequest(fixture.url, '/auth/otp/send', {
      method: 'POST',
      body: JSON.stringify({ email: 'sergey@example.com' })
    });
    const verify = await jsonRequest(fixture.url, '/auth/otp/verify', {
      method: 'POST',
      body: JSON.stringify({ email: 'sergey@example.com', otp: sentOtps.get('sergey@example.com') })
    });

    assert.equal(verify.status, 200);
    assert.equal(verify.body.authenticated, true);
    assert.equal(verify.body.user.email, 'sergey@example.com');
    assert.match(verify.headers.get('set-cookie'), /better-auth\.session_token=/);
    assert.equal(errors.length, 1);

    const logs = fixture.store.db
      .prepare("SELECT operation, status, reason, json_data FROM logs WHERE source = 'auth' ORDER BY id ASC")
      .all();
    assert.equal(logs.some((log) => log.reason === 'vault_prepare_failed'), true);
    const completed = logs.findLast((log) => log.operation === 'auth.otp_verify');
    assert.equal(completed.status, 'done');
    assert.equal(JSON.parse(completed.json_data).vault_prepared, false);
  } finally {
    await fixture.close();
  }
});

test('user vault preparer creates per-user subfolder and sync folder label by email', async () => {
  const root = await fs.promises.mkdtemp(path.join(process.env.TMPDIR || '/tmp', 'brai-vault-'));
  const commands = [];
  const runSyncthingCli = async (command) => {
    commands.push(command);
    return command.at(-1) === 'list' ? '' : '';
  };
  const prepare = createUserVaultPreparer({
    vaultRoot: root,
    syncthingGuiAddress: '127.0.0.1:8384',
    syncthingApiKey: 'test-key',
    runSyncthingCli
  });

  try {
    await prepare({ userId: 'user_123', email: 'sergey@example.com' });
    const userPath = path.join(root, 'user_123');
    assert.equal(fs.existsSync(userPath), true);
    assert.equal(fs.statSync(userPath).isDirectory(), true);
    assert.deepEqual(commands, [
      ['syncthing', 'cli', '--gui-address=127.0.0.1:8384', '--gui-apikey=test-key', 'config', 'folders', 'list'],
      ['syncthing', 'cli', '--gui-address=127.0.0.1:8384', '--gui-apikey=test-key', 'config', 'folders', 'add', '--id=vault-user-user_123', '--label=sergey@example.com', `--path=${userPath}`, '--type=sendreceive', '--ignore-perms']
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('user vault preparer keeps shared folders from syncing restrictive permissions', async () => {
  const root = await fs.promises.mkdtemp(path.join(process.env.TMPDIR || '/tmp', 'brai-vault-'));
  const commands = [];
  const runSyncthingCli = async (command) => {
    commands.push(command);
    return command.at(-1) === 'list' ? 'vault-user-user_123\n' : '';
  };
  const prepare = createUserVaultPreparer({
    vaultRoot: root,
    syncthingGuiAddress: '127.0.0.1:8384',
    syncthingApiKey: 'test-key',
    runSyncthingCli
  });

  try {
    await prepare({ userId: 'user_123', email: 'sergey@example.com' });
    assert.deepEqual(commands.at(-1), [
      'syncthing', 'cli', '--gui-address=127.0.0.1:8384', '--gui-apikey=test-key',
      'config', 'folders', 'vault-user-user_123', 'ignore-perms', 'set', 'true'
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('inbox attachment created for primary user is hidden from another user', async () => {
  const sentOtps = new Map();
  const fixture = await createFixture([
    '2026-07-01T11:00:00.000Z',
    '2026-07-01T11:00:01.000Z',
    '2026-07-01T11:00:02.000Z',
    '2026-07-01T11:00:03.000Z',
    '2026-07-01T11:00:04.000Z'
  ], {
    sessionSecret: SESSION_SECRET,
    sendOtp: ({ email, otp }) => sentOtps.set(email, otp)
  });

  async function otpLogin(email) {
    await jsonRequest(fixture.url, '/auth/otp/send', {
      method: 'POST',
      body: JSON.stringify({ email })
    });
    const verify = await jsonRequest(fixture.url, '/auth/otp/verify', {
      method: 'POST',
      body: JSON.stringify({ email, otp: sentOtps.get(email) })
    });
    assert.equal(verify.status, 200);
    return verify.headers.get('set-cookie');
  }

  try {
    const primaryCookie = await otpLogin('sergey@example.com');
    const secondaryCookie = await otpLogin('second@example.com');
    const inbox = await inboxRequest(fixture.url, '/v1/', {
      method: 'POST',
      body: JSON.stringify({
        text: 'Attachment body',
        attachments: [
          {
            mime: 'text/plain',
            file_base64: Buffer.from('secret attachment').toString('base64')
          }
        ]
      })
    });
    assert.equal(inbox.status, 201);
    const attachmentPath = inbox.body.attachment_links[0];
    assert.match(attachmentPath, /^\/v1\/inbox\/attachments\//);

    const primaryDownload = await fetch(`${fixture.url}${attachmentPath}`, {
      headers: { cookie: primaryCookie }
    });
    assert.equal(primaryDownload.status, 200);
    assert.equal(await primaryDownload.text(), 'secret attachment');

    const secondaryDownload = await fetch(`${fixture.url}${attachmentPath}`, {
      headers: { cookie: secondaryCookie }
    });
    assert.equal(secondaryDownload.status, 404);
  } finally {
    await fixture.close();
  }
});
