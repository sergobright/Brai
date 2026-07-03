import Database from 'better-sqlite3';
import { betterAuth } from 'better-auth';
import { emailOTP } from 'better-auth/plugins';
import { Resend } from 'resend';

const DEFAULT_FROM = 'Brai <auth@mail.brightos.world>';
const OTP_EXPIRES_IN_SECONDS = 5 * 60;
const DEFAULT_ALLOWED_HOSTS = [
  'app.brightos.world',
  'api.brightos.world',
  'dev.brightos.world',
  '*.test.brightos.world',
  'localhost',
  '127.0.0.1'
];

export function createBraiAuth({
  dbPath,
  secret,
  baseURL,
  resendApiKey = null,
  fromEmail = DEFAULT_FROM,
  sendOtp = null
}) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
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
    close: () => db.close()
  };
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
                <table role="presentation" align="center" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 auto 28px;">
                  <tr>
                    <td style="padding:0 10px 0 0;vertical-align:middle;">
                      <div style="width:36px;height:36px;border-radius:7px;background:#ef3b2f;color:#ffffff;font-size:20px;line-height:36px;font-weight:800;text-align:center;">B</div>
                    </td>
                    <td style="vertical-align:middle;text-align:left;font-size:30px;line-height:1;font-weight:800;letter-spacing:0;">
                      <span style="color:#000000;">Br</span><span style="color:#ef3b2f;">ai</span>
                    </td>
                  </tr>
                </table>
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
