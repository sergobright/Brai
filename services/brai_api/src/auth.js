import { betterAuth } from 'better-auth';
import { emailOTP } from 'better-auth/plugins';
import { Resend } from 'resend';
import { Pool } from 'pg';
import { isPostgresUrl, postgresPoolMax } from './postgres-sync-db.js';

const DEFAULT_FROM = 'Brai <auth@mail.brightos.world>';
const OTP_EXPIRES_IN_SECONDS = 5 * 60;
const LOGO_CONTENT_ID = 'brai-logo';
const LOGO_ATTACHMENT_CONTENT = [
  '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'
].join('');
const DEFAULT_ALLOWED_HOSTS = [
  'brightos.world',
  'app.brightos.world',
  'api.brightos.world',
  'dev.brightos.world',
  '*.test.brightos.world',
  'localhost',
  '127.0.0.1'
];

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
  const sender = sendOtp ?? (async ({ email, otp }) => {
    if (!resend) {
      const error = new Error('resend_api_key_required');
      error.status = 503;
      throw error;
    }
    await resend.emails.send({
      from: fromEmail,
      to: email,
      subject: 'Ваш одноразовый код Brai',
      ...renderOtpEmail({ otp })
    });
  });

  const options = {
    database: db,
    secret,
    baseURL: baseURL ?? {
      allowedHosts: DEFAULT_ALLOWED_HOSTS,
      protocol: 'auto',
      fallback: 'https://app.brightos.world'
    },
    advanced: {
      trustedProxyHeaders: true
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
      'Brai · brightos.world'
    ].join('\n'),
    attachments: [
      {
        content: LOGO_ATTACHMENT_CONTENT,
        filename: 'brai-logo.png',
        contentId: LOGO_CONTENT_ID,
        contentType: 'image/png'
      }
    ],
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
                <img src="cid:${LOGO_CONTENT_ID}" width="150" height="80" alt="Brai" style="display:block;width:150px;height:auto;margin:0 auto 28px;border:0;">
                <h1 style="margin:0;color:#18181b;font-size:24px;line-height:1.25;font-weight:700;">Ваш одноразовый код</h1>
                <p style="margin:14px 0 0;color:#52525b;font-size:16px;line-height:1.55;">Введите этот код в Brai, чтобы завершить вход.</p>
                <div class="otp-code" style="margin:30px 0 24px;color:#18181b;font-family:'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace;font-size:48px;line-height:1.1;font-weight:800;letter-spacing:6px;white-space:nowrap;">${safeOtp}</div>
                <div style="width:56px;height:3px;margin:0 auto 24px;background:#ef3b2f;border-radius:999px;line-height:3px;font-size:3px;">&nbsp;</div>
                <p style="margin:0;color:#18181b;font-size:15px;line-height:1.55;font-weight:700;">Код действует 5 минут.</p>
                <p style="margin:12px 0 0;color:#71717a;font-size:14px;line-height:1.55;">Если вы не запрашивали код, просто проигнорируйте это письмо.</p>
              </td>
            </tr>
            <tr>
              <td style="padding:18px 24px;border-top:1px solid #f1f1f3;text-align:center;color:#a1a1aa;font-size:12px;line-height:1.5;">Brai · brightos.world</td>
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
