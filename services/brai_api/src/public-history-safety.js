const REDACTIONS = [
  [/\/(?:srv|home|tmp|etc|var|opt|run)(?:\/[^\s"'<>\\)\],}]+)+/g, '[local path]'],
  [/postgres(?:ql)?:\/\/[^\s"'<>]+/gi, '[database URL]'],
  [/https?:\/\/[^\s/@:]+:[^\s/@]+@[^\s"'<>]+/gi, '[credentialed URL]'],
  [/\bAuthorization\s*:\s*(?:Bearer|Basic)\s+[^\s,;"'<>]+/gi, 'Authorization: [credential]'],
  [/\bBearer\s+[A-Za-z0-9._~+\/-]{20,}=*/gi, 'Bearer [credential]'],
  [/\b(?:Cookie|Set-Cookie)\s*:\s*[^\r\n]+/gi, 'Cookie: [credential]'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[private key]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[credential]'],
  [/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{35}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g, '[credential]'],
  [/(?:["']?)\b([A-Za-z0-9_.-]*(?:password|passwd|secret|token|credential|authorization|api[_-]?key|access[_-]?key|private[_-]?key|ssh[_-]?key)[A-Za-z0-9_.-]*)\b(?:["']?)\s*[:=]\s*(?!\[credential\])(?:"[^"\r\n]*"|'[^'\r\n]*'|`[^`\r\n]*`|[^\s,;"'<>]+)/giu, '$1=[credential]'],
  [new RegExp(['Ser', 'gey'].join(''), 'gi'), '[private name]'],
  [new RegExp(['Сер', 'гей'].join(''), 'giu'), '[private name]'],
];

export function publicHistoryText(value) {
  if (value == null) return value;
  return REDACTIONS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), String(value));
}

export function assertPublicHistorySafe(value) {
  walkStrings(value, (text) => {
    if (publicHistoryText(text) !== text) throw new Error('public version history contains private runtime data');
  });
  return value;
}

function walkStrings(value, visit) {
  if (typeof value === 'string') visit(value);
  else if (Array.isArray(value)) value.forEach((item) => walkStrings(item, visit));
  else if (value && typeof value === 'object') Object.values(value).forEach((item) => walkStrings(item, visit));
}
