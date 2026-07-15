import fs from 'node:fs';

const ALLOWED_HOSTS = new Set([
  'admin.brightos.world',
  'adr.brai.one',
  'sync.brai.one',
  'supabase.brai.one',
  'temporal.brai.one',
  'dev.brai.one',
  'a.test.brai.one',
  'b.test.brai.one',
  'c.test.brai.one',
  'd.test.brai.one',
  'e.test.brai.one',
  'app.brai.one',
]);

export function allowedCaddyUrl(rawUrl) {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname)) {
    throw new Error(`Caddy authentication is not allowed for ${url.hostname || 'this page'}.`);
  }
  return url;
}

export function readCaddyCredentials(filePath, rawUrl, euid = process.geteuid?.()) {
  allowedCaddyUrl(rawUrl); // Host denial must happen before touching the credential file.
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Caddy credential path must be a regular file.');
  if (euid !== undefined && stat.uid !== euid) throw new Error('Caddy credential file has the wrong owner.');
  if ((stat.mode & 0o077) !== 0) throw new Error('Caddy credential file must not grant group or other access.');
  const values = Object.fromEntries(fs.readFileSync(filePath, 'utf8').split(/\r?\n/).flatMap((line) => {
    const separator = line.indexOf(':');
    return separator > 0 ? [[line.slice(0, separator).trim(), line.slice(separator + 1).trim()]] : [];
  }));
  for (const key of ['Domain', 'Username', 'Password']) {
    if (!values[key]) throw new Error(`Caddy credential file is missing ${key}.`);
  }
  return { username: values.Username, password: values.Password };
}

async function selectedCaddyUrl(page) {
  const currentUrl = new URL(page.url());
  if (currentUrl.protocol !== 'chrome-error:') return allowedCaddyUrl(currentUrl.href);

  const session = await page.createCDPSession();
  try {
    const { currentIndex, entries } = await session.send('Page.getNavigationHistory');
    for (let index = currentIndex; index >= 0; index -= 1) {
      try {
        return allowedCaddyUrl(entries[index].url);
      } catch {
        // Keep looking only through the selected page's earlier navigation entries.
      }
    }
  } finally {
    await session.detach();
  }
  throw new Error('Caddy authentication is not allowed for chromewebdata.');
}

export async function applyCaddyAuthentication(page, action, credentialFile) {
  const failedNavigation = page.url().startsWith('chrome-error:');
  const url = await selectedCaddyUrl(page);
  if (action === 'clear') {
    await page.authenticate(null);
  } else {
    await page.authenticate(readCaddyCredentials(credentialFile, url.href));
  }
  const navigation = { waitUntil: 'domcontentloaded', timeout: 30_000 };
  if (failedNavigation) await page.goto(url.href, navigation);
  else await page.reload(navigation);
  return { host: url.hostname, action };
}
