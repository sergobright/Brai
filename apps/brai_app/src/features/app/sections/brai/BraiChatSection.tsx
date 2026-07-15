"use client";

import type { KeyboardEvent, PointerEvent, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { Archive, ArchiveRestore, Boxes, FileCode2, LockKeyhole, Pencil, Plus, Search, X } from "lucide-react";
import { BraiChatApi } from "@/shared/api/braiChatApi";
import { defaultApiBase } from "@/shared/config/runtime";
import type { BraiChatEvent, BraiChatMessage, BraiChatModel, BraiChatSearchHit, BraiChatThread } from "@/shared/types/braiChat";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/ui/select";
import { cx } from "../../appUtils";
import { MobileContextSheet } from "../../chrome/AppChrome";
import { requestMobileProfileDrawerClose } from "../../navigation/MobileProfileDrawer";
import { useMobileNavigationViewport } from "../../navigation/useSectionSwipeNavigation";
import { BraiChatInspector, inspectorEventAnchorId, type InspectorInstance, type InspectorSelection } from "./BraiChatInspector";
import { projectBraiChatArtifacts, splitSearchSnippet } from "./braiChatModel";

const MIN_INSPECTOR_WIDTH = 280;
const MAX_INSPECTOR_WIDTH = 480;
const THREAD_RAIL_WIDTH = 256;
const LIVE_EVENT_POLL_MS = 1_000;
type PendingAnchor = { kind: "message" | "event"; id: string; threadId: string };
type RetryLast = () => Promise<void>;
const BraiCopilotSurface = dynamic(() => import("./BraiCopilotSurface").then((module) => module.BraiCopilotSurface), {
  ssr: false,
  loading: () => <div className="grid h-full place-items-center text-sm text-muted-foreground">Подключение к Браю</div>,
});

export function BraiChatSection({
  userId,
  onRailContent,
}: {
  userId?: string | null;
  onRailContent?: (content: ReactNode | null) => void;
}) {
  const api = useMemo(() => new BraiChatApi(defaultApiBase(), userId), [userId]);
  const [threads, setThreads] = useState<BraiChatThread[]>([]);
  const [archived, setArchived] = useState(false);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [models, setModels] = useState<BraiChatModel[]>([]);
  const [messages, setMessages] = useState<BraiChatMessage[]>([]);
  const [events, setEvents] = useState<BraiChatEvent[]>([]);
  const [searchResults, setSearchResults] = useState<BraiChatSearchHit[]>([]);
  const [status, setStatus] = useState("Загрузка чатов");
  const [chatError, setChatError] = useState("");
  const [retryableError, setRetryableError] = useState(false);
  const [retryAvailable, setRetryAvailable] = useState(false);
  const [runActive, setRunActive] = useState(false);
  const [selection, setSelection] = useState<InspectorSelection | null>(null);
  const [pendingAnchor, setPendingAnchor] = useState<PendingAnchor | null>(null);
  const [inspectorWidth, setInspectorWidth] = useState(360);
  const [maxInspectorWidth, setMaxInspectorWidth] = useState(MAX_INSPECTOR_WIDTH);
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const inspectorRef = useRef<HTMLElement | null>(null);
  const desktopInspectorFocusRef = useRef<HTMLElement | null>(null);
  const mobileInspectorFocusRef = useRef<HTMLElement | null>(null);
  const inspectorOpenerRef = useRef<HTMLElement | null>(null);
  const inspectorWasOpen = useRef(false);
  const dragStart = useRef<{ x: number; width: number } | null>(null);
  const activeThreadIdRef = useRef<string | null>(null);
  const eventsRef = useRef<BraiChatEvent[]>([]);
  const retryLastRef = useRef<RetryLast | null>(null);
  const mobileViewport = useMobileNavigationViewport();
  const activeThread = threads.find((thread) => thread.id === activeThreadId) ?? null;
  const artifacts = useMemo(() => projectBraiChatArtifacts(messages, events), [events, messages]);

  const openInspector = useCallback((next: InspectorSelection) => {
    setSelection((current) => {
      if (!current && document.activeElement instanceof HTMLElement) inspectorOpenerRef.current = document.activeElement;
      return next;
    });
  }, []);

  const closeInspector = useCallback(() => {
    setSelection(null);
    window.requestAnimationFrame(() => {
      if (inspectorOpenerRef.current?.isConnected) inspectorOpenerRef.current.focus();
      inspectorOpenerRef.current = null;
    });
  }, []);

  const reportChatError = useCallback((message: string, retryable = false) => {
    setChatError(message);
    setRetryableError(retryable);
  }, []);

  const clearChatError = useCallback(() => {
    setChatError("");
    setRetryableError(false);
  }, []);

  const handleRetryChange = useCallback((retry: RetryLast | null) => {
    retryLastRef.current = retry;
    setRetryAvailable(Boolean(retry));
  }, []);

  const resetProjections = useCallback(() => {
    setMessages([]);
    setEvents([]);
    setSelection(null);
    setPendingAnchor(null);
    retryLastRef.current = null;
    setRetryAvailable(false);
    setRunActive(false);
  }, []);

  const activateThread = useCallback((id: string | null) => {
    activeThreadIdRef.current = id;
    setActiveThreadId(id);
  }, []);

  const loadThreads = useCallback(async (showArchived: boolean) => {
    setStatus("Загрузка чатов");
    try {
      const next = await api.threads(showArchived);
      const current = activeThreadIdRef.current;
      const nextId = next.some((thread) => thread.id === current) ? current : next[0]?.id ?? null;
      if (nextId !== current) resetProjections();
      setThreads(next);
      activateThread(nextId);
      setStatus(next.length > 0 ? "" : showArchived ? "Архив пуст" : "Создайте первый чат");
      return true;
    } catch {
      resetProjections();
      setThreads([]);
      activateThread(null);
      setStatus("Брай временно недоступен");
      reportChatError("Брай временно недоступен");
      return false;
    }
  }, [activateThread, api, reportChatError, resetProjections]);

  useEffect(() => {
    const timeout = window.setTimeout(() => void loadThreads(archived), 0);
    return () => window.clearTimeout(timeout);
  }, [archived, loadThreads]);

  useEffect(() => {
    let cancelled = false;
    void api.models().then((next) => { if (!cancelled) setModels(next); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [api]);

  useEffect(() => {
    if (!activeThreadId) return;
    let cancelled = false;
    void Promise.all([api.messages(activeThreadId), api.events(activeThreadId)]).then(([nextMessages, nextEvents]) => {
      if (cancelled) return;
      setMessages(nextMessages);
      setEvents(nextEvents);
      setSelection((current) => reconcileSelection(current, nextMessages, nextEvents));
    }).catch(() => {
      if (!cancelled) reportChatError("Историю не удалось загрузить. Попробуйте переключить чат");
    });
    return () => {
      cancelled = true;
    };
  }, [activeThreadId, api, reportChatError]);

  useEffect(() => {
    eventsRef.current = events;
  }, [events]);

  useEffect(() => {
    if (!activeThreadId || !runActive) return;
    let cancelled = false;
    let timer: number | null = null;

    const poll = async () => {
      const after = eventsRef.current.reduce((sequence, event) => Math.max(sequence, event.sequence), 0);
      try {
        const incoming = await api.events(activeThreadId, after);
        if (!cancelled && incoming.length > 0) setEvents((current) => mergeEvents(current, incoming));
      } catch {
        // The terminal refresh remains authoritative; transient polling failures stay quiet.
      } finally {
        if (!cancelled) timer = window.setTimeout(() => void poll(), LIVE_EVENT_POLL_MS);
      }
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer != null) window.clearTimeout(timer);
    };
  }, [activeThreadId, api, runActive]);

  useEffect(() => {
    if (!pendingAnchor || pendingAnchor.kind !== "event" || pendingAnchor.threadId !== activeThreadId) return;
    const event = events.find((item) => item.id === pendingAnchor.id);
    if (event) openInspector({ kind: "event", event });
  }, [activeThreadId, events, openInspector, pendingAnchor]);

  useEffect(() => {
    if (!pendingAnchor || pendingAnchor.threadId !== activeThreadId) return;
    const ready = pendingAnchor.kind === "message"
      ? messages.some((message) => message.id === pendingAnchor.id)
      : selection?.kind === "event" && selection.event.id === pendingAnchor.id;
    if (!ready) return;

    const scroll = () => {
      const id = pendingAnchor.kind === "message"
        ? `brai-message-${pendingAnchor.id}`
        : inspectorEventAnchorId(pendingAnchor.id, activeInspectorInstance());
      const element = document.getElementById(id);
      if (!element) return false;
      element.scrollIntoView({ block: "center" });
      if (pendingAnchor.kind === "event") element.focus();
      setPendingAnchor(null);
      return true;
    };
    if (scroll()) return;
    const observer = new MutationObserver(() => { if (scroll()) observer.disconnect(); });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [activeThreadId, messages, pendingAnchor, selection]);

  useEffect(() => {
    if (selection && !inspectorWasOpen.current) {
      window.requestAnimationFrame(() => {
        const target = activeInspectorInstance() === "mobile" ? mobileInspectorFocusRef.current : desktopInspectorFocusRef.current;
        target?.focus();
      });
    }
    inspectorWasOpen.current = Boolean(selection);
  }, [selection]);

  useEffect(() => {
    const update = () => {
      const workspaceWidth = workspaceRef.current?.getBoundingClientRect().width || window.innerWidth;
      const next = Math.max(200, Math.min(MAX_INSPECTOR_WIDTH, Math.floor((workspaceWidth - THREAD_RAIL_WIDTH) / 2)));
      setMaxInspectorWidth(next);
      setInspectorWidth((width) => clampInspectorWidth(width, next));
    };
    update();
    window.addEventListener("resize", update);
    const observer = typeof ResizeObserver === "undefined" || !workspaceRef.current ? null : new ResizeObserver(update);
    observer?.observe(workspaceRef.current!);
    return () => { window.removeEventListener("resize", update); observer?.disconnect(); };
  }, []);

  const createThread = useCallback(async () => {
    try {
      const thread = await api.createThread();
      setArchived(false);
      setThreads((current) => [thread, ...current.filter((item) => item.id !== thread.id)]);
      resetProjections();
      activateThread(thread.id);
      setStatus("");
      clearChatError();
      requestMobileProfileDrawerClose();
    } catch {
      setStatus("Новый чат не создан");
      reportChatError("Новый чат не создан");
    }
  }, [activateThread, api, clearChatError, reportChatError, resetProjections]);

  const selectThread = useCallback((id: string) => {
    resetProjections();
    clearChatError();
    activateThread(id);
    requestMobileProfileDrawerClose();
  }, [activateThread, clearChatError, resetProjections]);

  const renameThread = useCallback(async (id: string, title: string) => {
    const cleanTitle = title.trim();
    if (!cleanTitle) return;
    try {
      const updated = await api.updateThread(id, { title: cleanTitle });
      setThreads((current) => current.map((thread) => thread.id === id ? updated : thread));
      clearChatError();
    } catch {
      setStatus("Название не сохранено");
      reportChatError("Название не сохранено");
    }
  }, [api, clearChatError, reportChatError]);

  const toggleArchive = useCallback(async (thread: BraiChatThread) => {
    try {
      if (archived) await api.restoreThread(thread.id);
      else await api.archiveThread(thread.id);
      if (!await loadThreads(archived)) return;
      clearChatError();
    } catch {
      setStatus(archived ? "Чат не восстановлен" : "Чат не архивирован");
      reportChatError(archived ? "Чат не восстановлен" : "Чат не архивирован");
    }
  }, [api, archived, clearChatError, loadThreads, reportChatError]);

  const search = useCallback(async (query: string, includeArchived: boolean) => {
    if (!query.trim()) return setSearchResults([]);
    try {
      setSearchResults(await api.search(query.trim(), includeArchived));
      clearChatError();
    } catch {
      setStatus("Поиск временно недоступен");
      reportChatError("Поиск временно недоступен");
    }
  }, [api, clearChatError, reportChatError]);

  const openSearchHit = useCallback(async (hit: BraiChatSearchHit) => {
    try {
      const targetArchived = Boolean(hit.archived_at_utc);
      const nextThreads = targetArchived === archived ? threads : await api.threads(targetArchived);
      setArchived(targetArchived);
      setThreads(nextThreads);
      if (hit.thread_id !== activeThreadId) resetProjections();
      setSelection(null);
      activateThread(hit.thread_id);
      setPendingAnchor(hit.source_message_id
        ? { kind: "message", id: hit.source_message_id, threadId: hit.thread_id }
        : hit.source_event_id ? { kind: "event", id: hit.source_event_id, threadId: hit.thread_id } : null);
      setSearchResults([]);
      clearChatError();
      requestMobileProfileDrawerClose();
    } catch {
      reportChatError("Результат поиска не открыт. Попробуйте ещё раз");
    }
  }, [activateThread, activeThreadId, api, archived, clearChatError, reportChatError, resetProjections, threads]);

  const updateSettings = useCallback(async (patch: Partial<Pick<BraiChatThread, "model" | "reasoning_effort">>) => {
    if (!activeThread) return;
    try {
      const updated = await api.updateThread(activeThread.id, patch);
      setThreads((current) => current.map((thread) => thread.id === updated.id ? updated : thread));
      clearChatError();
    } catch {
      setStatus("Настройки чата не сохранены");
      reportChatError("Настройки чата не сохранены");
    }
  }, [activeThread, api, clearChatError, reportChatError]);

  const refreshAfterRun = useCallback(async () => {
    if (!activeThreadId) return;
    try {
      const [nextMessages, nextEvents, nextThreads] = await Promise.all([api.messages(activeThreadId), api.events(activeThreadId), api.threads(archived)]);
      setMessages(nextMessages);
      setEvents(nextEvents);
      setThreads(nextThreads);
      setSelection((current) => reconcileSelection(current, nextMessages, nextEvents));
      clearChatError();
    } catch {
      reportChatError("Ответ завершён, но историю не удалось обновить. Переключите чат для повтора");
    }
  }, [activeThreadId, api, archived, clearChatError, reportChatError]);

  const steer = useCallback(async (messageId: string, text: string) => {
    if (!activeThreadId) throw new Error("brai_chat_thread_missing");
    await api.steer(activeThreadId, messageId, text);
  }, [activeThreadId, api]);

  const navigateToSource = useCallback((current: InspectorSelection) => {
    const messageId = current.kind === "artifact" ? current.artifact.sourceMessageId : current.event.message_id ?? undefined;
    if (messageId && activeThreadId) {
      setPendingAnchor({ kind: "message", id: messageId, threadId: activeThreadId });
      return;
    }
    const eventId = current.kind === "artifact" ? current.artifact.sourceEventId : current.event.id;
    const event = events.find((item) => item.id === eventId);
    if (event && activeThreadId) {
      setSelection({ kind: "event", event });
      setPendingAnchor({ kind: "event", id: event.id, threadId: activeThreadId });
    }
  }, [activeThreadId, events]);

  const rail = useMemo(() => (
    <BraiThreadRail activeThreadId={activeThreadId} archived={archived} searchResults={searchResults} status={status} threads={threads}
      onArchive={toggleArchive} onArchived={setArchived} onCreate={createThread} onRename={renameThread} onSearch={search} onSearchHit={openSearchHit} onSelect={selectThread} />
  ), [activeThreadId, archived, createThread, openSearchHit, renameThread, search, searchResults, selectThread, status, threads, toggleArchive]);

  useEffect(() => {
    if (!onRailContent) return;
    onRailContent(rail);
    return () => onRailContent(null);
  }, [onRailContent, rail]);

  function startResize(event: PointerEvent<HTMLButtonElement>) {
    if (!inspectorRef.current) return;
    dragStart.current = { x: event.clientX, width: inspectorRef.current.getBoundingClientRect().width };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function resize(event: PointerEvent<HTMLButtonElement>) {
    if (!dragStart.current || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    setInspectorWidth(clampInspectorWidth(dragStart.current.width + dragStart.current.x - event.clientX, maxInspectorWidth));
  }

  function finishResize(event: PointerEvent<HTMLButtonElement>) {
    dragStart.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function resizeWithKeyboard(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowLeft") setInspectorWidth((width) => clampInspectorWidth(width + 8, maxInspectorWidth));
    else if (event.key === "ArrowRight") setInspectorWidth((width) => clampInspectorWidth(width - 8, maxInspectorWidth));
    else if (event.key === "Home") setInspectorWidth(Math.min(MIN_INSPECTOR_WIDTH, maxInspectorWidth));
    else if (event.key === "End") setInspectorWidth(maxInspectorWidth);
    else return;
    event.preventDefault();
  }

  const selectedModel = models.find((model) => model.id === activeThread?.model) ?? null;
  const reasoningEfforts = selectedModel?.reasoning_efforts ?? [];
  const providerHeaders = userId ? { "x-brai-expected-user-id": userId } : undefined;

  return (
    <div ref={workspaceRef} className="brai-chat-workspace grid h-full min-h-0 grid-cols-[16rem_minmax(0,1fr)_auto] overflow-hidden border-t border-border max-[860px]:grid-cols-1" data-nav-swipe-exclusion>
      <aside className="min-h-0 border-r border-border bg-card max-[860px]:hidden" aria-label="Чаты Брая">{rail}</aside>
      <section className="brai-chat-pane grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] bg-background" aria-label="Чат с Браем">
        <div className="flex min-h-12 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
          <Select value={activeThread?.model ?? ""} disabled={!activeThread || models.length === 0} onValueChange={(model) => void updateSettings({ model })}>
            <SelectTrigger size="sm" aria-label="Модель"><SelectValue placeholder="Модель" /></SelectTrigger>
            <SelectContent>{models.map((model) => <SelectItem key={model.id} value={model.id}>{model.display_name || model.id}</SelectItem>)}</SelectContent>
          </Select>
          <Select value={activeThread?.reasoning_effort ?? ""} disabled={!activeThread || reasoningEfforts.length === 0} onValueChange={(reasoning_effort) => void updateSettings({ reasoning_effort })}>
            <SelectTrigger size="sm" aria-label="Глубина рассуждений"><SelectValue placeholder="Рассуждения" /></SelectTrigger>
            <SelectContent>{reasoningEfforts.map((effort) => <SelectItem key={effort} value={effort}>{effort}</SelectItem>)}</SelectContent>
          </Select>
          <Badge variant="secondary" className="gap-1"><LockKeyhole className="size-3" aria-hidden="true" />Только чтение</Badge>
          <div className="ml-auto flex items-center gap-1">
            <Button type="button" size="icon-sm" variant="ghost" disabled={artifacts.length === 0} aria-label="Открыть артефакты" title="Артефакты" onClick={() => artifacts[0] && openInspector({ kind: "artifact", artifact: artifacts[0] })}><Boxes aria-hidden="true" /></Button>
            <Button type="button" size="icon-sm" variant="ghost" disabled={events.length === 0} aria-label="Открыть детали" title="Детали" onClick={() => events.at(-1) && openInspector({ kind: "event", event: events.at(-1)! })}><FileCode2 aria-hidden="true" /></Button>
          </div>
        </div>
        <div className="relative min-h-0 overflow-hidden">
          {chatError ? (
            <div role="alert" className="absolute inset-x-3 top-3 z-20 flex items-center gap-2 rounded-md border border-destructive/40 bg-background px-3 py-2 text-sm text-destructive shadow-sm">
              <span className="min-w-0 flex-1">{chatError}</span>
              {retryableError && retryAvailable ? (
                <Button type="button" size="sm" variant="ghost" onClick={() => {
                  const retry = retryLastRef.current;
                  if (!retry) return;
                  clearChatError();
                  void retry().catch(() => reportChatError("Повторный ответ не запущен. Попробуйте ещё раз", true));
                }}>Повторить</Button>
              ) : null}
              <Button type="button" size="icon-xs" variant="ghost" aria-label="Скрыть сообщение об ошибке" onClick={clearChatError}><X aria-hidden="true" /></Button>
            </div>
          ) : null}
          {activeThread ? (
            <BraiCopilotSurface
              key={activeThread.id}
              runtimeUrl={api.runtimeUrl()} threadId={activeThread.id} headers={providerHeaders}
              onError={reportChatError} onRetryChange={handleRetryChange} onRunFinished={refreshAfterRun} onRunStateChange={setRunActive} onSteer={steer}
              onDeleteAttachment={(id) => api.deleteUnlinkedAttachment(id)}
              onUpload={async (file) => {
                const attachment = await api.uploadAttachment(activeThread.id, file);
                clearChatError();
                return { id: attachment.id, mediaType: attachment.media_type, url: api.attachmentUrl(attachment.id) };
              }}
            />
          ) : (
            <div className="grid h-full place-items-center px-6 text-center"><div><p className="text-sm text-muted-foreground">{status}</p>{!archived ? <Button type="button" className="mt-3" onClick={() => void createThread()}><Plus aria-hidden="true" />Новый чат</Button> : null}</div></div>
          )}
        </div>
      </section>
      {selection ? (
        <aside ref={inspectorRef} className="relative hidden min-h-0 border-l border-border bg-card min-[861px]:block" style={{ width: Math.min(inspectorWidth, maxInspectorWidth) }} aria-label="Инспектор чата">
          <button type="button" className="absolute inset-y-0 left-0 z-10 w-2 -translate-x-1/2 cursor-ew-resize border-0 bg-transparent outline-none focus-visible:bg-primary/25"
            role="slider" aria-label="Изменить ширину инспектора" aria-valuemin={Math.min(MIN_INSPECTOR_WIDTH, maxInspectorWidth)} aria-valuemax={maxInspectorWidth} aria-valuenow={Math.min(inspectorWidth, maxInspectorWidth)}
            onPointerDown={startResize} onPointerMove={resize} onPointerUp={finishResize} onPointerCancel={finishResize} onKeyDown={resizeWithKeyboard} />
          <BraiChatInspector instance="desktop" selection={selection} artifacts={artifacts} events={events} attachmentUrl={(id) => api.attachmentUrl(id)} focusRef={desktopInspectorFocusRef} onSelect={setSelection} onSource={navigateToSource} onClose={closeInspector} />
        </aside>
      ) : null}
      {selection && mobileViewport ? (
        <MobileContextSheet label={selection.kind === "artifact" ? "Артефакты" : "Детали"} variant="detail" scroll={false} onClose={closeInspector}>
          <BraiChatInspector instance="mobile" mobile selection={selection} artifacts={artifacts} events={events} attachmentUrl={(id) => api.attachmentUrl(id)} focusRef={mobileInspectorFocusRef} onSelect={setSelection} onSource={navigateToSource} onClose={closeInspector} />
        </MobileContextSheet>
      ) : null}
    </div>
  );
}

function BraiThreadRail({ activeThreadId, archived, searchResults, status, threads, onArchive, onArchived, onCreate, onRename, onSearch, onSearchHit, onSelect }: {
  activeThreadId: string | null; archived: boolean; searchResults: BraiChatSearchHit[]; status: string; threads: BraiChatThread[];
  onArchive: (thread: BraiChatThread) => Promise<void>; onArchived: (archived: boolean) => void; onCreate: () => Promise<void>;
  onRename: (id: string, title: string) => Promise<void>; onSearch: (query: string, includeArchived: boolean) => Promise<void>;
  onSearchHit: (hit: BraiChatSearchHit) => Promise<void>; onSelect: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [includeArchived, setIncludeArchived] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  return (
    <div className="grid h-full min-h-0 grid-rows-[auto_auto_minmax(0,1fr)]">
      <div className="flex items-center gap-2 border-b border-border p-3">
        <Button type="button" className="flex-1" size="sm" onClick={() => void onCreate()}><Plus aria-hidden="true" />Новый чат</Button>
        <Button type="button" size="icon-sm" variant={archived ? "secondary" : "ghost"} aria-label={archived ? "Показать активные чаты" : "Показать архив чатов"} onClick={() => onArchived(!archived)}><Archive aria-hidden="true" /></Button>
      </div>
      <form className="grid gap-2 border-b border-border p-3" onSubmit={(event) => { event.preventDefault(); void onSearch(query, includeArchived); }}>
        <div className="flex gap-1"><Input id="brai-chat-search" name="query" type="search" value={query} aria-label="Поиск по чатам" placeholder="Поиск" onChange={(event) => setQuery(event.target.value)} /><Button type="submit" size="icon-sm" variant="ghost" aria-label="Найти"><Search aria-hidden="true" /></Button></div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground"><input type="checkbox" checked={includeArchived} onChange={(event) => setIncludeArchived(event.target.checked)} />Искать в архиве</label>
      </form>
      <ScrollArea className="min-h-0" contentInset="none"><div className="grid gap-1 p-2">
        {searchResults.length > 0 ? searchResults.map((hit) => (
          <button key={hit.id} type="button" className="rounded-md px-3 py-2 text-left hover:bg-accent" onClick={() => void onSearchHit(hit)}><span className="block truncate text-sm font-medium">{hit.thread_title}</span><SearchSnippet snippet={hit.snippet} /></button>
        )) : threads.map((thread) => (
          <div key={thread.id} className={cx("group grid grid-cols-[minmax(0,1fr)_auto] items-center rounded-md", activeThreadId === thread.id && "bg-accent") }>
            {editing === thread.id ? <Input autoFocus defaultValue={thread.title} aria-label={`Название чата: ${thread.title}`} className="m-1" onBlur={(event) => { void onRename(thread.id, event.target.value); setEditing(null); }} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") setEditing(null); }} /> : <button type="button" className="min-w-0 truncate px-3 py-2 text-left text-sm" onClick={() => onSelect(thread.id)}>{thread.title}</button>}
            <div className="flex pr-1"><Button type="button" size="icon-xs" variant="ghost" aria-label={`Переименовать: ${thread.title}`} onClick={() => setEditing(thread.id)}><Pencil aria-hidden="true" /></Button><Button type="button" size="icon-xs" variant="ghost" aria-label={`${archived ? "Восстановить" : "Архивировать"}: ${thread.title}`} onClick={() => void onArchive(thread)}>{archived ? <ArchiveRestore aria-hidden="true" /> : <Archive aria-hidden="true" />}</Button></div>
          </div>
        ))}
        {searchResults.length === 0 && threads.length === 0 ? <p className="px-3 py-4 text-sm text-muted-foreground">{status}</p> : null}
      </div></ScrollArea>
    </div>
  );
}

function clampInspectorWidth(width: number, max: number): number {
  return Math.round(Math.max(Math.min(MIN_INSPECTOR_WIDTH, max), Math.min(max, width)));
}

function activeInspectorInstance(): InspectorInstance {
  return typeof window.matchMedia === "function" && window.matchMedia("(max-width: 860px)").matches ? "mobile" : "desktop";
}

function SearchSnippet({ snippet }: { snippet: string }) {
  return (
    <span className="mt-1 block line-clamp-2 text-xs text-muted-foreground">
      {splitSearchSnippet(snippet).map((part, index) => part.highlighted ? <mark key={index} className="bg-accent text-accent-foreground">{part.text}</mark> : part.text)}
    </span>
  );
}

function reconcileSelection(current: InspectorSelection | null, messages: BraiChatMessage[], events: BraiChatEvent[]): InspectorSelection | null {
  if (!current) return null;
  if (current.kind === "event") {
    const event = events.find((item) => item.id === current.event.id);
    return event ? { kind: "event", event } : null;
  }
  const artifact = projectBraiChatArtifacts(messages, events).find((item) => item.id === current.artifact.id);
  return artifact ? { kind: "artifact", artifact } : null;
}

function mergeEvents(current: BraiChatEvent[], incoming: BraiChatEvent[]): BraiChatEvent[] {
  const events = new Map(current.map((event) => [event.id, event]));
  for (const event of incoming) events.set(event.id, event);
  return [...events.values()].sort((left, right) => left.sequence - right.sequence);
}
