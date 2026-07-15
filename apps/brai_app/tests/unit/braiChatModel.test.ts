import { describe, expect, it } from "vitest";
import { attachmentReservationError, projectBraiChatArtifacts, splitSearchSnippet } from "@/features/app/sections/brai/braiChatModel";
import type { BraiChatEvent, BraiChatMessage } from "@/shared/types/braiChat";

describe("projectBraiChatArtifacts", () => {
  it("derives images, code, long markdown, diffs and tools with stable source links", () => {
    const messages: BraiChatMessage[] = [{
      version: 1,
      id: "message-1",
      thread_id: "thread-1",
      turn_id: "turn-1",
      role: "assistant",
      content: `\`\`\`ts\nconst ready = true\n\`\`\`\n${"x".repeat(2_001)}`,
      status: "completed",
      sequence: 1,
      attachments: [{
        version: 1,
        id: "attachment-1",
        thread_id: "thread-1",
        filename: "screen.png",
        media_type: "image/png",
        byte_size: 10,
        checksum_sha256: "hash",
        created_at_utc: "2026-07-15T00:00:00Z",
      }],
      created_at_utc: "2026-07-15T00:00:00Z",
    }];
    const events: BraiChatEvent[] = [
      event("event-1", "CUSTOM", custom("brai.artifact.v1", { kind: "file_change", source_event_id: "file-1", files: [{ name: "a.ts", kind: "update" }] }), 1),
      event("event-2", "CUSTOM", custom("brai.artifact.v1", { kind: "file_change", source_event_id: "file-1", files: [{ name: "a.ts", kind: "completed" }] }), 2),
      event("event-3", "CUSTOM", custom("brai.detail.v1", { kind: "commandExecution", source_event_id: "tool-1", status: "running" }), 3),
      event("event-4", "TOOL_CALL_RESULT", { type: "TOOL_CALL_RESULT", toolCallId: "tool-1", content: "ok" }, 4),
      event("event-5", "CUSTOM", custom("brai.detail.v1", { kind: "commandExecution", source_event_id: "tool-1", status: "completed", result: "ok" }), 5),
    ];

    const artifacts = projectBraiChatArtifacts(messages, events);
    expect(artifacts.map(({ kind, sourceMessageId, sourceEventId }) => ({ kind, sourceMessageId, sourceEventId }))).toEqual([
      { kind: "image", sourceMessageId: "message-1", sourceEventId: undefined },
      { kind: "code", sourceMessageId: "message-1", sourceEventId: undefined },
      { kind: "markdown", sourceMessageId: "message-1", sourceEventId: undefined },
      { kind: "diff", sourceMessageId: undefined, sourceEventId: "event-2" },
      { kind: "tool", sourceMessageId: undefined, sourceEventId: "event-5" },
    ]);
    expect(artifacts.find((artifact) => artifact.kind === "tool")?.content).toContain('"status": "completed"');
  });

  it("enforces five files and 50 MiB across the composed message", () => {
    expect(attachmentReservationError([1, 1, 1, 1, 1], 1)).toBe("count");
    expect(attachmentReservationError([30 * 1024 * 1024], 21 * 1024 * 1024)).toBe("size");
    expect(attachmentReservationError([30 * 1024 * 1024], 20 * 1024 * 1024)).toBeNull();
  });

  it("turns only literal search markers into highlight parts", () => {
    expect(splitSearchSnippet("до <mark>совпадение</mark> <script>x</script>")).toEqual([
      { text: "до ", highlighted: false },
      { text: "совпадение", highlighted: true },
      { text: " <script>x</script>", highlighted: false },
    ]);
  });
});

function event(id: string, type: string, safe_payload: Record<string, unknown>, sequence: number): BraiChatEvent {
  return { version: 1, id, thread_id: "thread-1", message_id: null, turn_id: "turn-1", sequence, type, safe_payload, truncated: false, created_at_utc: "2026-07-15T00:00:00Z" };
}

function custom(name: string, value: Record<string, unknown>): Record<string, unknown> {
  return { type: "CUSTOM", name, value };
}
