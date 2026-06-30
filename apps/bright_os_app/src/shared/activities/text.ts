export const TITLE_MAX_LENGTH = 250;
export const TITLE_COUNTER_THRESHOLD = 50;

export function singleLineTitle(value: unknown): string {
  return typeof value === "string" ? value.replace(/[\r\n]+/g, " ") : "";
}

export function limitTitle(value: unknown): string {
  return singleLineTitle(value).slice(0, TITLE_MAX_LENGTH);
}

export function cleanTitle(value: unknown): string {
  return singleLineTitle(value).replace(/\s+/g, " ").trim().slice(0, TITLE_MAX_LENGTH);
}

export function normalizeDescription(value: unknown): string {
  return typeof value === "string" ? value.replace(/\r\n?/g, "\n") : "";
}

export function visibleDescriptionPreview(value: unknown): string {
  return markdownPreviewSource(value)
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

export function markdownPreviewSource(value: unknown): string {
  return normalizeDescription(value).replace(/^(#{1,6})([^\s#])/gm, "$1 $2");
}
