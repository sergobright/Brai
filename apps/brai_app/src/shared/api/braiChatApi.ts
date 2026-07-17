import type {
  BraiChatAttachment,
  BraiChatEvent,
  BraiChatMessage,
  BraiChatModelCatalog,
  BraiChatSearchHit,
  BraiChatThread,
} from "@/shared/types/braiChat";

const REQUEST_TIMEOUT_MS = 20_000;
const UPLOAD_TIMEOUT_MS = 5 * 60_000;

/** Resolves a Brai API path for browser and Capacitor runtimes. */
export function resolveBraiChatUrl(baseUrl: string, path: string): string {
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  if (!baseUrl || baseUrl === "/") return cleanPath;
  return `${baseUrl.replace(/\/$/, "")}${cleanPath}`;
}

/** Typed client for the authenticated Brai chat product contract. */
export class BraiChatApi {
  constructor(
    private readonly baseUrl: string,
    private readonly expectedUserId?: string | null,
  ) {}

  runtimeUrl(): string {
    return resolveBraiChatUrl(this.baseUrl, "/v1/brai-chat/runtime");
  }

  async models(): Promise<BraiChatModelCatalog> {
    return this.request<BraiChatModelCatalog>("/v1/brai-chat/models");
  }

  async threads(archived = false): Promise<BraiChatThread[]> {
    return (await this.request<{ threads: BraiChatThread[] }>(`/v1/brai-chat/threads?archived=${archived ? "archived" : "active"}`)).threads;
  }

  async createThread(): Promise<BraiChatThread> {
    return (await this.request<{ thread: BraiChatThread }>("/v1/brai-chat/threads", { method: "POST" })).thread;
  }

  async updateThread(id: string, patch: Partial<Pick<BraiChatThread, "title" | "model" | "reasoning_effort">>): Promise<BraiChatThread> {
    return (await this.request<{ thread: BraiChatThread }>(`/v1/brai-chat/threads/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    })).thread;
  }

  async archiveThread(id: string): Promise<BraiChatThread> {
    return (await this.request<{ thread: BraiChatThread }>(`/v1/brai-chat/threads/${encodeURIComponent(id)}/archive`, { method: "POST" })).thread;
  }

  async restoreThread(id: string): Promise<BraiChatThread> {
    return (await this.request<{ thread: BraiChatThread }>(`/v1/brai-chat/threads/${encodeURIComponent(id)}/restore`, { method: "POST" })).thread;
  }

  async messages(threadId: string): Promise<BraiChatMessage[]> {
    const messages: BraiChatMessage[] = [];
    let cursor = "0";
    const seen = new Set<string>();
    while (!seen.has(cursor)) {
      seen.add(cursor);
      const page = await this.request<{ messages: BraiChatMessage[]; next_cursor: string | null }>(
        `/v1/brai-chat/threads/${encodeURIComponent(threadId)}/messages?cursor=${encodeURIComponent(cursor)}&limit=50`,
      );
      messages.push(...page.messages);
      if (!page.next_cursor) break;
      cursor = page.next_cursor;
    }
    return messages;
  }

  async events(threadId: string, after = 0): Promise<BraiChatEvent[]> {
    const events: BraiChatEvent[] = [];
    let cursor = String(after);
    const seen = new Set<string>();
    while (!seen.has(cursor)) {
      seen.add(cursor);
      const page = await this.request<{ events: BraiChatEvent[]; next_cursor: string | null }>(
        `/v1/brai-chat/threads/${encodeURIComponent(threadId)}/events?after=${encodeURIComponent(cursor)}&limit=200`,
      );
      events.push(...page.events);
      if (!page.next_cursor) break;
      cursor = page.next_cursor;
    }
    return events;
  }

  async steer(threadId: string, messageId: string, text: string): Promise<void> {
    await this.request<void>(`/v1/brai-chat/threads/${encodeURIComponent(threadId)}/steer`, {
      method: "POST",
      body: JSON.stringify({ message_id: messageId, text }),
    });
  }

  async search(query: string, includeArchived: boolean): Promise<BraiChatSearchHit[]> {
    const params = new URLSearchParams({ q: query, archived: includeArchived ? "all" : "active" });
    return (await this.request<{ results: BraiChatSearchHit[] }>(`/v1/brai-chat/search?${params}`)).results;
  }

  async uploadAttachment(threadId: string, file: File): Promise<BraiChatAttachment> {
    const form = new FormData();
    form.append("files", file);
    return (await this.request<{ attachments: BraiChatAttachment[] }>(`/v1/brai-chat/threads/${encodeURIComponent(threadId)}/attachments`, {
      method: "POST",
      body: form,
    }, UPLOAD_TIMEOUT_MS)).attachments[0];
  }

  async deleteUnlinkedAttachment(id: string): Promise<void> {
    await this.request<{ deleted: true }>(`/v1/brai-chat/attachments/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  }

  attachmentUrl(id: string): string {
    return resolveBraiChatUrl(this.baseUrl, `/v1/brai-chat/attachments/${encodeURIComponent(id)}`);
  }

  async attachmentBlob(id: string, download = false): Promise<Blob> {
    const suffix = download ? "?download=1" : "";
    return this.requestBlob(`/v1/brai-chat/attachments/${encodeURIComponent(id)}${suffix}`);
  }

  private async request<T>(path: string, init: RequestInit = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    const response = await this.requestResponse(path, init, timeoutMs);
    const body = await response.text();
    return (body ? JSON.parse(body) : undefined) as T;
  }

  private async requestBlob(path: string): Promise<Blob> {
    return (await this.requestResponse(path)).blob();
  }

  private async requestResponse(path: string, init: RequestInit = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
    const headers = new Headers(init.headers);
    if (typeof init.body === "string") headers.set("content-type", "application/json");
    if (this.expectedUserId) headers.set("x-brai-expected-user-id", this.expectedUserId);
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(resolveBraiChatUrl(this.baseUrl, path), {
        ...init,
        credentials: "include",
        headers,
        signal: controller.signal,
      });
      if (!response.ok) throw Object.assign(new Error(`brai_chat_api_${response.status}`), { status: response.status });
      return response;
    } finally {
      window.clearTimeout(timeout);
    }
  }
}
