import type { HistoryData } from "@/shared/types/timer";

export function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

export function fitTextareaHeight(node: HTMLTextAreaElement | null): void {
  if (!node) return;
  node.style.height = "auto";
  node.style.height = `${node.scrollHeight}px`;
}

export function setPlainEditableText(node: HTMLElement | null, value: string): void {
  if (!node || plainEditableText(node) === value) return;
  node.textContent = value;
}

export function plainEditableText(node: HTMLElement): string {
  return (node.innerText ?? node.textContent ?? "").replace(/\n$/, "");
}

export function focusEditableEnd(node: HTMLElement | null): void {
  if (!node) return;
  node.focus();
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(node);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

export function normalizeHistory(history: HistoryData): HistoryData {
  return {
    sessions: history.sessions ?? [],
    groups: history.groups ?? {},
  };
}

export function moscowTodayKey(): string {
  return new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
