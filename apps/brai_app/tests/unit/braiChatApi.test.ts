import { beforeEach, describe, expect, it, vi } from "vitest";
import { BraiChatApi, resolveBraiChatUrl } from "@/shared/api/braiChatApi";

describe("BraiChatApi", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("uses the protected snake-case chat contract and expected-user boundary", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(init).toBeDefined();
      const url = String(input);
      if (url.includes("/models")) return json({ models: [] });
      if (url.includes("/search")) return json({ results: [] });
      if (url.includes("/messages")) return json({ messages: [], next_cursor: null });
      return json({ threads: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const api = new BraiChatApi("/api", "user-1");

    await api.threads(true);
    await api.messages("thread/a");
    await api.search("проверка", true);
    await api.models();

    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      "/api/v1/brai-chat/threads?archived=archived",
      "/api/v1/brai-chat/threads/thread%2Fa/messages?cursor=0&limit=50",
      "/api/v1/brai-chat/search?q=%D0%BF%D1%80%D0%BE%D0%B2%D0%B5%D1%80%D0%BA%D0%B0&archived=all",
      "/api/v1/brai-chat/models",
    ]);
    for (const [, init] of fetchMock.mock.calls) {
      expect(new Headers(init?.headers).get("x-brai-expected-user-id")).toBe("user-1");
      expect(init?.credentials).toBe("include");
    }
    expect(api.runtimeUrl()).toBe("/api/v1/brai-chat/runtime");
  });

  it("loads every message/event cursor and sends a stable steer contract", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/messages?cursor=0")) return json({ messages: [{ id: "message-1" }], next_cursor: "1" });
      if (url.includes("/messages?cursor=1")) return json({ messages: [{ id: "message-2" }], next_cursor: null });
      if (url.includes("/events?after=3")) return json({ events: [{ id: "event-4" }], next_cursor: "4" });
      if (url.includes("/events?after=4")) return json({ events: [{ id: "event-5" }], next_cursor: null });
      if (url.endsWith("/steer")) {
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({ message_id: "message-3", text: "Уточнение" });
        return new Response(null, { status: 202 });
      }
      throw new Error(`unexpected_url:${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const api = new BraiChatApi("/api");

    await expect(api.messages("thread-1")).resolves.toEqual([{ id: "message-1" }, { id: "message-2" }]);
    await expect(api.events("thread-1", 3)).resolves.toEqual([{ id: "event-4" }, { id: "event-5" }]);
    await expect(api.steer("thread-1", "message-3", "Уточнение")).resolves.toBeUndefined();
  });

  it("uploads the selected image as multipart files", async () => {
    const attachment = { id: "attachment-1" };
    const timeoutSpy = vi.spyOn(window, "setTimeout");
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.body).toBeInstanceOf(FormData);
      expect((init?.body as FormData).get("files")).toBeInstanceOf(File);
      expect(new Headers(init?.headers).has("content-type")).toBe(false);
      return json({ attachments: [attachment] });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(new BraiChatApi("/api").uploadAttachment("thread-1", new File(["x"], "x.png", { type: "image/png" }))).resolves.toEqual(attachment);
    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 5 * 60_000);
  });

  it("deletes only an unlinked uploaded attachment through the protected contract", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("/api/v1/brai-chat/attachments/attachment%2F1");
      expect(init?.method).toBe("DELETE");
      return json({ deleted: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(new BraiChatApi("/api").deleteUnlinkedAttachment("attachment/1")).resolves.toBeUndefined();
  });

  it("resolves relative and external API bases", () => {
    expect(resolveBraiChatUrl("/api/", "/v1/brai-chat/runtime")).toBe("/api/v1/brai-chat/runtime");
    expect(resolveBraiChatUrl("https://api.brai.one", "v1/brai-chat/runtime")).toBe("https://api.brai.one/v1/brai-chat/runtime");
  });
});

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}
