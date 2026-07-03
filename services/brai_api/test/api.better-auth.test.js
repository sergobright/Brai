import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SESSION_SECRET,
  actionEvent,
  createFixture,
  inboundRequest,
  jsonRequest,
  request
} from '../test-support/api.js';
import { renderOtpEmail } from '../src/auth.js';

test('email OTP message renders the reusable responsive card', () => {
  const message = renderOtpEmail({ otp: '<123456>' });

  assert.match(message.html, /Ваш одноразовый код/);
  assert.match(message.html, /Введите этот код в Brai, чтобы завершить вход\./);
  assert.match(message.html, /Код действует 5 минут\./);
  assert.match(message.html, /max-width:600px/);
  assert.match(message.html, /@media only screen and \(max-width: 620px\)/);
  assert.match(message.html, /<span style="color:#000000;">Br<\/span><span style="color:#ef3b2f;">ai<\/span>/);
  assert.doesNotMatch(message.html, /<img/);
  assert.match(message.html, /&lt;123456&gt;/);
  assert.doesNotMatch(message.html, /<123456>/);
  assert.match(message.text, /<123456>/);
  assert.match(message.text, /Brai · brightos\.world/);
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
    sendOtp: ({ email, otp }) => sentOtps.set(email, otp),
    inboundTitleGenerator: async () => 'Attachment'
  });

  async function otpLogin(email) {
    const send = await jsonRequest(fixture.url, '/auth/otp/send', {
      method: 'POST',
      body: JSON.stringify({ email })
    });
    assert.equal(send.status, 200);
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
      fixture.store.db.prepare('SELECT COUNT(*) AS count FROM timer_events WHERE user_id = ?').get(first.user.id).count,
      2
    );

    const second = await otpLogin('second@example.com');
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
      headers: { cookie: second.cookie },
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
    sendOtp: ({ email, otp }) => sentOtps.set(email, otp),
    inboundTitleGenerator: async () => 'Attachment'
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
    const inbound = await inboundRequest(fixture.url, '/v1/', {
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
    assert.equal(inbound.status, 201);
    const attachmentPath = inbound.body.attachment_links[0];
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
