export function renderReleasePage(data, { downloadBase = "." } = {}) {
  const cards = Object.entries(data.sections ?? {})
    .filter(([, section]) => Boolean(section))
    .map(([releaseKey, section]) => sectionCard(section, releaseKey, downloadBase))
    .join("\n");
  return `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Brai: APK-релизы</title>
    <style>
      :root { color-scheme: dark; --bg: #0c1110; --panel: #121a18; --line: #2a3935; --text: #edf7f4; --muted: #9fb0ab; --accent: #4cc3ad; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100dvh; background: var(--bg); color: var(--text); padding: 24px 16px; }
      main { width: min(920px, 100%); margin: 0 auto; }
      h1 { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
      .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; }
      section { border: 1px solid var(--line); border-radius: 8px; background: var(--panel); padding: 12px; }
      h2 { margin: 0 0 8px; font-size: 18px; line-height: 1.2; }
      .version-row { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin: -2px 0 8px; }
      .version { margin: 0; color: var(--text); font-weight: 800; }
      .size { color: var(--muted); font-size: 13px; font-weight: 300; opacity: .7; white-space: nowrap; }
      time, .unpublished { display: block; min-height: 40px; margin: 0 0 12px; color: var(--muted); line-height: 1.35; }
      time { font-size: 15px; white-space: nowrap; }
      .download { display: inline-flex; min-height: 38px; align-items: center; border-radius: 8px; padding: 0 14px; font-weight: 800; }
      a.download { background: var(--accent); color: #06110f; text-decoration: none; }
      .download[aria-disabled="true"] { border: 1px solid var(--line); color: var(--muted); }
    </style>
  </head>
  <body>
    <main>
      <h1>APK-релизы Brai</h1>
      <div class="grid">${cards}</div>
    </main>
  </body>
</html>
`;
}

function sectionCard(section, releaseKey, downloadBase) {
  const target = downloadBase === "/releases/download" ? releaseKey : section.file;
  const href = downloadBase === "." ? `./${target}` : `${downloadBase}/${target}`;
  const download = section.file
    ? `<a class="download" href="${escapeHtml(href)}">Скачать</a>`
    : `<span class="download" aria-disabled="true">Скачать</span>`;
  const published = formatPublishedAt(section.publishedAt);
  const version = section.apkBuildKind === "preview" && section.previewIteration
    ? `v${section.apkVersion}-preview${section.previewIteration}`
    : section.apkVersion ? `v${section.apkVersion}` : "";
  return `<section>
  <h2>${escapeHtml(section.title)}</h2>
  ${version ? `<div class="version-row"><p class="version">${escapeHtml(version)}</p>${section.sizeBytes ? `<span class="size">${escapeHtml(formatFileSize(section.sizeBytes))}</span>` : ""}</div>` : ""}
  ${section.publishedAt ? `<time datetime="${escapeHtml(section.publishedAt)}">${escapeHtml(published)}</time>` : `<span class="unpublished">${escapeHtml(published)}</span>`}
  ${download}
</section>`;
}

function formatFileSize(value) {
  const megabytes = Number(value) / 1_000_000;
  return `${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(megabytes)} МБ`;
}

function formatPublishedAt(value) {
  if (!value) return "Не опубликовано";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Не опубликовано";
  const datePart = new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(date).replace(" г.", "");
  const timePart = new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
  return `${datePart}, ${timePart} МСК`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
