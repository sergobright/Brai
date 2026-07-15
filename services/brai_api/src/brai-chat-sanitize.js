import path from 'node:path';

export const BRAI_CHAT_OUTPUT_LIMIT_BYTES = 64 * 1024;
export const BRAI_CHAT_TRUNCATION_MARKER = '\n\n[Вывод обрезан: превышен лимит 64 КиБ]';

const REDACTED = '[скрыто]';

const PREFIXED_SECRET_PATTERNS = [
  /\b((?:(?:proxy-)?authorization|cookie|set-cookie|x-api-key|x-auth-token)\s*:\s*)[^\r\n]+/gi,
  /\b((?:[A-Za-z_][A-Za-z0-9_-]*)?(?:token|secret|password|passwd|credential|api[_-]?key|access[_-]?key|private[_-]?key)[A-Za-z0-9_-]*\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi,
  /([?&#](?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|code|state|secret|password|passwd|api[_-]?key|key|credential)=)[^&#\s"'<>]+/gi
];

const WHOLE_SECRET_PATTERNS = [
  /\b(?:[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi,
  /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/g,
  /\b(?:ghp_|github_pat_|glpat-|xox[baprs]-)[A-Za-z0-9_-]{12,}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /-----BEGIN [^-]*(?:PRIVATE KEY|OPENSSH PRIVATE KEY)-----[\s\S]*?-----END [^-]*(?:PRIVATE KEY|OPENSSH PRIVATE KEY)-----/g
];

const SERVER_PATH_PATTERNS = [
  /(?:^|[\s"'=(])\/(?:home|root|srv|var\/lib|run|etc|opt|tmp)(?:\/[A-Za-z0-9._@%+,:=-]+)+/g,
  /(?:^|[\s"'=(])\/vault\/(?:[A-Za-z0-9._@%+,:=-]+\/)+[A-Za-z0-9._@%+,:=-]+/g
];

function redactServerPath(match) {
  const prefix = /^[\s"'=(]/.test(match) ? match[0] : '';
  return `${prefix}[путь скрыт]`;
}

function truncateUtf8(value, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) return '';
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;

  const markerBytes = Buffer.byteLength(BRAI_CHAT_TRUNCATION_MARKER, 'utf8');
  const contentLimit = Math.max(0, maxBytes - markerBytes);
  const truncated = Buffer.from(value, 'utf8').subarray(0, contentLimit).toString('utf8').replace(/\uFFFD$/u, '');
  return `${truncated}${BRAI_CHAT_TRUNCATION_MARKER}`;
}

export function sanitizeBraiChatText(value, { maxBytes = BRAI_CHAT_OUTPUT_LIMIT_BYTES } = {}) {
  let safe = typeof value === 'string' ? value : String(value ?? '');
  safe = safe.replaceAll('\0', '');

  for (const pattern of PREFIXED_SECRET_PATTERNS) safe = safe.replace(pattern, (_match, prefix) => `${prefix}${REDACTED}`);
  for (const pattern of WHOLE_SECRET_PATTERNS) safe = safe.replace(pattern, REDACTED);
  for (const pattern of SERVER_PATH_PATTERNS) safe = safe.replace(pattern, redactServerPath);

  return truncateUtf8(safe, maxBytes);
}

export function sanitizeBraiChatFilename(value) {
  const basename = path.basename(typeof value === 'string' ? value : 'attachment');
  return sanitizeBraiChatText(basename, { maxBytes: 255 });
}

export function safeBraiChatError(error) {
  const message = sanitizeBraiChatText(error?.message ?? error ?? 'Ошибка Codex', { maxBytes: 2_048 });
  const normalized = message.toLowerCase();
  if (/auth|unauthor|forbidden|login|credential/.test(normalized)) {
    return { code: 'upstream_auth', message: 'Авторизация Codex недоступна. Попробуйте позже.' };
  }
  if (/rate.?limit|too many requests|quota/.test(normalized)) {
    return { code: 'upstream_rate_limit', message: 'Codex временно ограничил частоту запросов. Попробуйте позже.' };
  }
  if (/overload|capacity|busy|resource exhausted/.test(normalized)) {
    return { code: 'upstream_overloaded', message: 'Codex временно перегружен. Попробуйте позже.' };
  }
  if (/timeout|timed out|deadline/.test(normalized)) {
    return { code: 'turn_timeout', message: 'Ответ не завершился за 15 минут и был остановлен.' };
  }
  return { code: 'upstream_unavailable', message: 'Codex временно недоступен. Попробуйте позже.' };
}
