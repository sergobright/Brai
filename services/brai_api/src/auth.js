import { AsyncLocalStorage } from 'node:async_hooks';
import { betterAuth } from 'better-auth';
import { emailOTP } from 'better-auth/plugins';
import { Resend } from 'resend';
import { Pool } from 'pg';
import { isPostgresUrl, postgresPoolMax } from './postgres-sync-db.js';

const DEFAULT_FROM = 'Brai <auth@mail.brai.one>';
const OTP_EXPIRES_IN_SECONDS = 5 * 60;
const LOGO_URL = 'https://brai.one/brai-logo-email-white-bg.png';
const DEFAULT_ALLOWED_HOSTS = [
  'brai.one',
  'app.brai.one',
  'api.brai.one',
  'dev.brai.one',
  '*.test.brai.one',
  'localhost',
  '127.0.0.1'
];
const testOtpCapture = new AsyncLocalStorage();

export function createBraiAuth({
  databaseUrl,
  secret,
  baseURL,
  resendApiKey = null,
  fromEmail = DEFAULT_FROM,
  sendOtp = null
}) {
  if (!isPostgresUrl(databaseUrl)) throw new Error('BRAI_DATABASE_URL must be a postgres:// or postgresql:// URL');
  const db = new Pool({
    connectionString: databaseUrl,
    ssl: postgresSsl(databaseUrl),
    max: postgresPoolMax(process.env.BRAI_PG_POOL_MAX)
  });
  const resend = resendApiKey ? new Resend(resendApiKey) : null;
  const deliverySender = sendOtp ?? (async ({ email, otp }) => {
    if (!resend) {
      const error = new Error('resend_api_key_required');
      error.status = 503;
      throw error;
    }
    const result = await resend.emails.send({
      from: fromEmail,
      to: email,
      subject: 'Ваш одноразовый код Brai',
      ...renderOtpEmail({ otp })
    });
    if (result.error) {
      const error = new Error(result.error.message || 'resend_email_send_failed');
      error.status = result.error.statusCode ?? 502;
      throw error;
    }
  });
  const sender = async ({ email, otp, type }) => {
    const capture = testOtpCapture.getStore();
    if (capture) {
      capture.email = email;
      capture.otp = otp;
      capture.type = type;
      return;
    }
    await deliverySender({ email, otp, type });
  };

  const options = {
    database: db,
    secret,
    baseURL: baseURL ?? {
      allowedHosts: DEFAULT_ALLOWED_HOSTS,
      protocol: 'auto',
      fallback: 'https://app.brai.one'
    },
    advanced: {
      trustedProxyHeaders: true,
      cookies: {
        session_token: {
          attributes: {
            sameSite: 'none',
            secure: true
          }
        }
      }
    },
    plugins: [
      emailOTP({
        expiresIn: OTP_EXPIRES_IN_SECONDS,
        async sendVerificationOTP({ email, otp, type }) {
          await sender({ email, otp, type });
        }
      })
    ]
  };

  const auth = betterAuth(options);

  return {
    auth,
    testEmailLogin: async ({ email, name = email, headers }) => {
      const capture = {};
      const sendResponse = await testOtpCapture.run(capture, () => auth.api.sendVerificationOTP({
        body: { email, type: 'sign-in' },
        headers,
        asResponse: true
      }));
      if (!sendResponse.ok) return sendResponse;
      if (!capture.otp) {
        const error = new Error('test_otp_capture_failed');
        error.status = 503;
        throw error;
      }
      return auth.api.signInEmailOTP({
        body: { email, otp: capture.otp, name },
        headers,
        asResponse: true
      });
    },
    close: () => db.end()
  };
}

function postgresSsl(databaseUrl) {
  const override = process.env.BRAI_DATABASE_SSL;
  if (override === 'false' || override === '0') return false;
  if (override === 'true' || override === '1') return { rejectUnauthorized: false };
  return /supabase\.(?:co|com)|pooler\.supabase\.com/.test(databaseUrl) ? { rejectUnauthorized: false } : false;
}

export function renderOtpEmail({ otp }) {
  const safeOtp = escapeHtml(otp);
  return {
    text: [
      'Ваш одноразовый код',
      '',
      'Введите этот код в Brai, чтобы завершить вход.',
      '',
      otp,
      '',
      'Код действует 5 минут.',
      'Если вы не запрашивали код, просто проигнорируйте это письмо.',
      '',
      'Brai · brai.one'
    ].join('\n'),
    attachments: [],
    html: `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Ваш одноразовый код Brai</title>
    <style>
      @media only screen and (max-width: 620px) {
        .email-wrap { padding: 20px 12px !important; }
        .email-card { width: 100% !important; }
        .card-pad { padding: 30px 22px !important; }
        .otp-code { font-size: 40px !important; letter-spacing: 4px !important; }
      }
    </style>
  </head>
  <body style="margin:0;padding:0;background:#f4f4f5;color:#18181b;font-family:Arial,'Helvetica Neue',Helvetica,sans-serif;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">Введите одноразовый код Brai. Код действует 5 минут.</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;background:#f4f4f5;">
      <tr>
        <td class="email-wrap" align="center" style="padding:40px 16px;">
          <table role="presentation" class="email-card" width="100%" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;border-collapse:separate;background:#ffffff;border:1px solid #e4e4e7;border-radius:8px;box-shadow:0 18px 44px rgba(24,24,27,0.08);overflow:hidden;">
            <tr>
              <td class="card-pad" style="padding:40px 44px 34px;text-align:center;">
                <img src="${LOGO_URL}" width="150" height="80" alt="Brai" style="display:block;width:150px;height:auto;margin:0 auto 28px;border:0;">
                <h1 style="margin:0;color:#18181b;font-size:24px;line-height:1.25;font-weight:700;">Ваш одноразовый код</h1>
                <p style="margin:14px 0 0;color:#52525b;font-size:16px;line-height:1.55;">Введите этот код в Brai, чтобы завершить вход.</p>
                <div class="otp-code" style="margin:30px 0 24px;color:#18181b;font-family:'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace;font-size:48px;line-height:1.1;font-weight:800;letter-spacing:6px;white-space:nowrap;">${safeOtp}</div>
                <div style="width:56px;height:3px;margin:0 auto 24px;background:#ef3b2f;border-radius:999px;line-height:3px;font-size:3px;">&nbsp;</div>
                <p style="margin:0;color:#18181b;font-size:15px;line-height:1.55;font-weight:700;">Код действует 5 минут.</p>
                <p style="margin:12px 0 0;color:#71717a;font-size:14px;line-height:1.55;">Если вы не запрашивали код, просто проигнорируйте это письмо.</p>
              </td>
            </tr>
            <tr>
              <td style="padding:18px 24px;border-top:1px solid #f1f1f3;text-align:center;color:#a1a1aa;font-size:12px;line-height:1.5;">Brai · brai.one</td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`
  };
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
