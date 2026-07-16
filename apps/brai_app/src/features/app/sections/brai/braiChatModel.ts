import type { BraiChatEvent, BraiChatMessage } from "@/shared/types/braiChat";

export type BraiChatArtifact = {
  id: string;
  kind: "image" | "code" | "markdown" | "diff";
  label: string;
  content: string;
  attachmentId?: string;
  sourceMessageId?: string;
  sourceEventId?: string;
};

export type BraiWorkspaceMode = "preview" | "code" | "docs";
export type BraiContextPanel = "none" | BraiWorkspaceMode;

/** Assigns each persisted artifact projection to its Dojo workspace view. */
export function artifactWorkspaceMode(artifact: BraiChatArtifact): BraiWorkspaceMode {
  if (artifact.kind === "image") return "preview";
  if (artifact.kind === "markdown") return "docs";
  return "code";
}

/** Returns the artifacts visible in one Dojo workspace view. */
export function workspaceArtifacts(artifacts: BraiChatArtifact[], mode: BraiWorkspaceMode): BraiChatArtifact[] {
  return artifacts.filter((artifact) => artifactWorkspaceMode(artifact) === mode);
}

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
      const attachmentId = stringValue(custom.value.attachment_id);
      if (kind === "image" && !attachmentId) continue;
      const id = `artifact:${source}`;
      artifacts.set(id, {
        id,
        kind,
        label: stringValue(custom.value.name) ?? (kind === "diff" ? "Изменения файлов" : "Изображение"),
        content: JSON.stringify(custom.value, null, 2),
        attachmentId,
        sourceMessageId: stringValue(custom.value.source_message_id),
        sourceEventId: event.id,
      });
      continue;
    }

  }
  return [...artifacts.values()];
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
