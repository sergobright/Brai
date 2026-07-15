import type { BraiChatEvent, BraiChatMessage } from "@/shared/types/braiChat";

export type BraiChatArtifact = {
  id: string;
  kind: "image" | "code" | "markdown" | "diff" | "tool";
  label: string;
  content: string;
  attachmentId?: string;
  sourceMessageId?: string;
  sourceEventId?: string;
};

/** Derives the stable artifact inspector projection from persisted chat sources. */
export function projectBraiChatArtifacts(messages: BraiChatMessage[], events: BraiChatEvent[]): BraiChatArtifact[] {
  const artifacts = new Map<string, BraiChatArtifact>();
  for (const message of messages) {
    for (const attachment of message.attachments ?? []) {
      artifacts.set(`attachment:${attachment.id}`, {
        id: `attachment:${attachment.id}`,
        kind: "image",
        label: attachment.filename,
        content: JSON.stringify({ filename: attachment.filename, media_type: attachment.media_type, byte_size: attachment.byte_size }, null, 2),
        attachmentId: attachment.id,
        sourceMessageId: message.id,
      });
    }
    for (const [index, block] of [...message.content.matchAll(/```([^\n]*)\n([\s\S]*?)```/g)].entries()) {
      const id = `message:${message.id}:code:${index}`;
      artifacts.set(id, {
        id,
        kind: "code",
        label: block[1]?.trim() || "Код",
        content: block[2]?.trim() ?? "",
        sourceMessageId: message.id,
      });
    }
    if (message.content.length > 2_000) {
      const id = `message:${message.id}:markdown`;
      artifacts.set(id, { id, kind: "markdown", label: "Большой ответ", content: message.content, sourceMessageId: message.id });
    }
  }
  for (const event of events) {
    const custom = customEvent(event);
    if (custom?.name === "brai.artifact.v1") {
      const source = stringValue(custom.value.source_event_id) ?? event.id;
      const rawKind = stringValue(custom.value.kind);
      const kind = rawKind === "file_change" || rawKind === "diff" ? "diff" : rawKind === "image" ? "image" : null;
      if (!kind) continue;
      const id = `artifact:${source}`;
      artifacts.set(id, {
        id,
        kind,
        label: stringValue(custom.value.name) ?? (kind === "diff" ? "Изменения файлов" : "Изображение"),
        content: JSON.stringify(custom.value, null, 2),
        attachmentId: stringValue(custom.value.attachment_id),
        sourceEventId: event.id,
      });
      continue;
    }

    const detailValue = custom?.name === "brai.detail.v1" ? custom.value : null;
    const standardToolResult = event.type === "TOOL_CALL_RESULT" ? event.safe_payload : null;
    const result = detailValue?.result ?? standardToolResult?.content ?? standardToolResult?.result;
    if (typeof result !== "string") continue;
    const source = stringValue(detailValue?.source_event_id)
      ?? stringValue(standardToolResult?.toolCallId)
      ?? stringValue(standardToolResult?.tool_call_id)
      ?? event.id;
    const id = `tool:${source}`;
    artifacts.set(id, {
      id,
      kind: "tool",
      label: stringValue(detailValue?.label) ?? stringValue(detailValue?.kind) ?? "Результат инструмента",
      content: detailValue ? JSON.stringify(detailValue, null, 2) : eventPayloadText(event.safe_payload),
      sourceEventId: event.id,
    });
  }
  return [...artifacts.values()];
}

/** Formats the already-sanitized event payload for the details inspector. */
export function eventPayloadText(payload: Record<string, unknown>): string {
  return JSON.stringify(payload, null, 2);
}

export function eventLabel(event: BraiChatEvent): string {
  const custom = customEvent(event);
  const value = custom?.value.label ?? custom?.value.command ?? custom?.value.kind ?? custom?.name ?? event.safe_payload.label ?? event.safe_payload.command ?? event.type;
  return typeof value === "string" ? value : event.type;
}

/** Returns the composed-message attachment limit violation, if any. */
export function attachmentReservationError(reservedSizes: Iterable<number>, nextSize: number): "count" | "size" | null {
  const sizes = [...reservedSizes];
  if (sizes.length >= 5) return "count";
  return sizes.reduce((total, size) => total + size, 0) + nextSize > 50 * 1024 * 1024 ? "size" : null;
}

/** Splits trusted search highlight markers while leaving every other tag as inert text. */
export function splitSearchSnippet(snippet: string): Array<{ text: string; highlighted: boolean }> {
  const parts: Array<{ text: string; highlighted: boolean }> = [];
  let highlighted = false;
  for (const token of snippet.split(/(<mark>|<\/mark>)/g)) {
    if (token === "<mark>") highlighted = true;
    else if (token === "</mark>") highlighted = false;
    else if (token) parts.push({ text: token, highlighted });
  }
  return parts;
}

function customEvent(event: BraiChatEvent): { name: string; value: Record<string, unknown> } | null {
  const payload = event.safe_payload;
  if (event.type !== "CUSTOM" || payload.type !== "CUSTOM" || typeof payload.name !== "string" || !recordValue(payload.value)) return null;
  return { name: payload.name, value: payload.value };
}

function recordValue(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}
