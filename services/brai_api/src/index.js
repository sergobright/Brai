import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { braiCmdConfigFromEnv } from './brai-cmd.js';
import { isPostgresUrl } from './postgres-sync-db.js';
import { createBraiServer } from './server.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const serviceRoot = path.resolve(dirname, '..');
const port = Number(process.env.PORT ?? 3020);
const databaseUrl = process.env.BRAI_DATABASE_URL?.trim() || null;
if (!databaseUrl || !isPostgresUrl(databaseUrl)) {
  console.error('BRAI_DATABASE_URL must be a postgres:// or postgresql:// URL');
  process.exit(1);
}
const dataRoot = process.env.BRAI_DATA_ROOT ?? path.join(serviceRoot, 'data');
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
  process.env.BRAI_INBOUND_STORAGE_ROOT ?? path.join(dataRoot, 'inbox-attachments');
const vaultRoot = process.env.BRAI_VAULT_ROOT ?? '';
const syncthingGuiAddress = process.env.BRAI_SYNCTHING_GUI_ADDRESS ?? '127.0.0.1:8384';
const syncthingApiKey = process.env.BRAI_SYNCTHING_API_KEY ?? '';
const syncthingFolderIdPrefix = process.env.BRAI_SYNCTHING_FOLDER_ID_PREFIX ?? 'vault-user-';
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
  databaseUrl,
  dataRoot,
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
  vaultRoot,
  syncthingGuiAddress,
  syncthingApiKey,
  syncthingFolderIdPrefix,
  codexBin,
  codexModel,
  codexTimeoutMs,
  braiCmd: {
    config: braiCmdConfigFromEnv(process.env)
  }
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
