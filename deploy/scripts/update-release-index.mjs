import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const args = parseArgs(process.argv.slice(2));
const root = process.env.BRIGHT_OS_ROOT ?? path.resolve(import.meta.dirname, "../..");
const releaseDir = process.env.BRIGHT_OS_RELEASE_TARGET ?? path.join(root, "deploy/releases");
const indexPath = path.join(releaseDir, "releases.json");
const environments = JSON.parse(fs.readFileSync(path.join(root, "deploy/environments.json"), "utf8")).environments;
const releaseKey = required(args, "release");
const fileName = required(args, "file");
const filePath = path.join(releaseDir, fileName);
const env = Object.values(environments).find((candidate) => candidate.releaseKey === releaseKey);

if (!env) throw new Error(`unknown release section: ${releaseKey}`);
if (!fs.existsSync(filePath)) throw new Error(`missing APK file: ${fileName}`);

const data = readIndex();
data.sections[releaseKey] = {
  title: env.displayName,
  androidApp: env.androidApp,
  applicationId: env.applicationId,
  file: fileName,
  version: required(args, "version"),
  versionCode: Number(required(args, "version-code")),
  publishedAt: required(args, "published-at"),
  sizeBytes: fs.statSync(filePath).size,
  sha256: sha256(filePath),
};

writeJson(indexPath, data);
renderReleasePage(data, path.join(releaseDir, "index.html"));

function readIndex() {
  if (fs.existsSync(indexPath)) return JSON.parse(fs.readFileSync(indexPath, "utf8"));
  return {
    schemaVersion: 1,
    sections: Object.fromEntries(
      ["production", "a", "b", "c", "d", "e"].map((key) => {
        const sectionEnv = Object.values(environments).find((candidate) => candidate.releaseKey === key);
        return [
          key,
          {
            title: sectionEnv.displayName,
            androidApp: sectionEnv.androidApp,
            applicationId: sectionEnv.applicationId,
            file: null,
            version: null,
            versionCode: null,
            publishedAt: null,
            sizeBytes: null,
            sha256: null,
          },
        ];
      }),
    ),
  };
}

function renderReleasePage(data, htmlPath) {
  const order = ["production", "a", "b", "c", "d", "e"];
  const cards = order.map((key) => sectionCard(data.sections[key])).join("\n");
  fs.writeFileSync(
    htmlPath,
    `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Bright OS: APK-релизы</title>
    <style>
      :root { color-scheme: dark; --bg: #0c1110; --panel: #121a18; --line: #2a3935; --text: #edf7f4; --muted: #9fb0ab; --accent: #4cc3ad; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100dvh; background: var(--bg); color: var(--text); padding: 28px 18px; }
      main { width: min(1080px, 100%); margin: 0 auto; }
      h1 { margin: 0 0 8px; font-size: 32px; letter-spacing: 0; }
      .lead { margin: 0 0 22px; color: var(--muted); }
      .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 12px; }
      section { border: 1px solid var(--line); border-radius: 8px; background: var(--panel); padding: 16px; }
      h2 { margin: 0 0 4px; font-size: 20px; }
      .app { margin: 0 0 14px; color: var(--muted); }
      dl { display: grid; gap: 8px; margin: 0 0 14px; }
      dt { color: var(--muted); font-size: 12px; text-transform: uppercase; }
      dd { margin: 2px 0 0; overflow-wrap: anywhere; }
      a, .missing { display: inline-flex; min-height: 42px; align-items: center; border-radius: 8px; padding: 0 14px; font-weight: 800; }
      a { background: var(--accent); color: #06110f; text-decoration: none; }
      .missing { border: 1px solid var(--line); color: var(--muted); }
    </style>
  </head>
  <body>
    <main>
      <h1>APK-релизы Bright OS</h1>
      <p class="lead">Production и preview A-E устанавливаются как отдельные Android-приложения.</p>
      <div class="grid">${cards}</div>
    </main>
  </body>
</html>
`,
  );
}

function sectionCard(section) {
  const download = section.file
    ? `<a href="./${escapeHtml(section.file)}">Скачать APK</a>`
    : `<span class="missing">APK ещё не опубликован</span>`;
  return `<section>
  <h2>${escapeHtml(section.title)}</h2>
  <p class="app">${escapeHtml(section.androidApp)}</p>
  <dl>
    <div><dt>APK version</dt><dd>${escapeHtml(section.version ?? "нет")}</dd></div>
    <div><dt>versionCode</dt><dd>${escapeHtml(section.versionCode ?? "нет")}</dd></div>
    <div><dt>applicationId</dt><dd>${escapeHtml(section.applicationId)}</dd></div>
    <div><dt>published</dt><dd>${escapeHtml(section.publishedAt ?? "нет")}</dd></div>
    <div><dt>file</dt><dd>${escapeHtml(section.file ?? "нет")}</dd></div>
  </dl>
  ${download}
</section>`;
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    if (!key?.startsWith("--")) throw new Error(`invalid argument: ${key}`);
    parsed[key.slice(2)] = values[index + 1] ?? "";
  }
  return parsed;
}

function required(values, key) {
  const value = values[key];
  if (!value) throw new Error(`missing --${key}`);
  return value;
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
