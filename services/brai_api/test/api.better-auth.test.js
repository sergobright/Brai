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
import { renderOtpEmail } from '../src/auth.js';
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

  assert.match(message.html, /Ваш одноразовый код/);
  assert.match(message.html, /Введите этот код в Brai, чтобы завершить вход\./);
  assert.match(message.html, /Код действует 5 минут\./);
  assert.match(message.html, /max-width:600px/);
  assert.match(message.html, /@media only screen and \(max-width: 620px\)/);
  assert.match(message.html, /<img src="https:\/\/brai\.one\/brai-logo\.png"/);
  assert.match(message.html, /alt="Brai"/);
  assert.doesNotMatch(message.html, /data:image/);
  assert.deepEqual(message.attachments, []);
  assert.doesNotMatch(message.html, /cid:/);
  assert.match(message.html, /&lt;123456&gt;/);
  assert.doesNotMatch(message.html, /<123456>/);
  assert.match(message.text, /<123456>/);
  assert.match(message.text, /Brai · brai\.one/);
});

test('test email login creates or reuses a Better Auth user without sending OTP mail', async () => {
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

    const activities = await jsonRequest(fixture.url, '/v1/activities', {
      headers: { cookie: firstCookie, origin: 'capacitor://localhost' }
    });
    assert.equal(activities.status, 200);

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
    assert.notEqual(second.body.user.id, first.body.user.id);
    assert.equal(fixture.store.primaryUserId(), first.body.user.id);
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
      ['syncthing', 'cli', '--gui-address=127.0.0.1:8384', '--gui-apikey=test-key', 'config', 'folders', 'add', '--id=vault-user-user_123', '--label=sergey@example.com', `--path=${userPath}`, '--type=sendreceive']
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
