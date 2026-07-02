import Database from 'better-sqlite3';
import { betterAuth } from 'better-auth';
import { emailOTP } from 'better-auth/plugins';
import { Resend } from 'resend';

const DEFAULT_FROM = 'Brai <auth@mail.brightos.world>';
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
      subject: 'Код входа в Brai',
      html: `<p>Ваш код входа в Brai: <strong>${escapeHtml(otp)}</strong></p><p>Код действует несколько минут.</p>`
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

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
