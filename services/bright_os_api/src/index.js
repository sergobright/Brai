import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBrightOsServer } from './server.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const serviceRoot = path.resolve(dirname, '..');
const port = Number(process.env.PORT ?? 3020);
const dbPath = process.env.BRIGHT_OS_DB ?? path.join(serviceRoot, 'data', 'bright_os.sqlite');
const token = process.env.BRIGHT_OS_TOKEN;
const webPassword = process.env.BRIGHT_OS_WEB_PASSWORD;
const releasePassword = process.env.BRIGHT_OS_RELEASE_PASSWORD ?? webPassword;
const sessionSecret = process.env.BRIGHT_OS_SESSION_SECRET;
const inboundApiKey = process.env.BRIGHT_OS_INBOUND_API_KEY ?? process.env.BRIGHT_OS_INBOUND_TOKEN;
const inboundStorageRoot =
  process.env.BRIGHT_OS_INBOUND_STORAGE_ROOT ?? path.join(path.dirname(dbPath), 'inbox-attachments');
const codexBin = process.env.BRIGHT_OS_CODEX_BIN ?? 'codex';
const codexModel = process.env.BRIGHT_OS_CODEX_MODEL?.trim() || null;
const parsedCodexTimeoutMs = Number(process.env.BRIGHT_OS_CODEX_TIMEOUT_MS);
const codexTimeoutMs = Number.isFinite(parsedCodexTimeoutMs) ? parsedCodexTimeoutMs : null;
const releaseDir =
  process.env.BRIGHT_OS_RELEASE_DIR ?? path.resolve(serviceRoot, '..', '..', 'deploy', 'releases');

if (!token) {
  console.error('BRIGHT_OS_TOKEN is required');
  process.exit(1);
}

if (!webPassword) {
  console.error('BRIGHT_OS_WEB_PASSWORD is required');
  process.exit(1);
}

if (!sessionSecret) {
  console.error('BRIGHT_OS_SESSION_SECRET is required');
  process.exit(1);
}

const runtime = createBrightOsServer({
  dbPath,
  token,
  webPassword,
  releasePassword,
  sessionSecret,
  releaseDir,
  inboundApiKey,
  inboundStorageRoot,
  codexBin,
  codexModel,
  codexTimeoutMs
});
runtime.server.listen(port, '127.0.0.1', () => {
  console.log(`Bright OS API listening on 127.0.0.1:${port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await runtime.close();
    process.exit(0);
  });
}
