import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBraiServer } from './server.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const serviceRoot = path.resolve(dirname, '..');
const port = Number(process.env.PORT ?? 3020);
const dbPath = process.env.BRAI_DB ?? path.join(serviceRoot, 'data', 'brai.sqlite');
const token = process.env.BRAI_TOKEN;
const webPassword = process.env.BRAI_WEB_PASSWORD;
const releasePassword = process.env.BRAI_RELEASE_PASSWORD ?? webPassword;
const sessionSecret = process.env.BRAI_SESSION_SECRET;
const betterAuthSecret = process.env.BETTER_AUTH_SECRET ?? sessionSecret;
const betterAuthUrl = process.env.BETTER_AUTH_URL ?? null;
const resendApiKey = process.env.RESEND_API_KEY ?? null;
const authFromEmail = process.env.BRAI_AUTH_FROM ?? 'Brai <auth@mail.brightos.world>';
const inboundApiKey = process.env.BRAI_INBOUND_API_KEY ?? process.env.BRAI_INBOUND_TOKEN;
const inboundStorageRoot =
  process.env.BRAI_INBOUND_STORAGE_ROOT ?? path.join(path.dirname(dbPath), 'inbox-attachments');
const codexBin = process.env.BRAI_CODEX_BIN ?? 'codex';
const codexModel = process.env.BRAI_CODEX_MODEL?.trim() || null;
const parsedCodexTimeoutMs = Number(process.env.BRAI_CODEX_TIMEOUT_MS);
const codexTimeoutMs = Number.isFinite(parsedCodexTimeoutMs) ? parsedCodexTimeoutMs : null;
const releaseDir =
  process.env.BRAI_RELEASE_DIR ?? path.resolve(serviceRoot, '..', '..', 'deploy', 'releases');

if (!token) {
  console.error('BRAI_TOKEN is required');
  process.exit(1);
}

if (!webPassword) {
  console.error('BRAI_WEB_PASSWORD is required');
  process.exit(1);
}

if (!sessionSecret) {
  console.error('BRAI_SESSION_SECRET is required');
  process.exit(1);
}

const runtime = createBraiServer({
  dbPath,
  token,
  webPassword,
  releasePassword,
  sessionSecret,
  betterAuthSecret,
  betterAuthUrl,
  resendApiKey,
  authFromEmail,
  releaseDir,
  inboundApiKey,
  inboundStorageRoot,
  codexBin,
  codexModel,
  codexTimeoutMs
});
runtime.server.listen(port, '127.0.0.1', () => {
  console.log(`Brai API listening on 127.0.0.1:${port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await runtime.close();
    process.exit(0);
  });
}
