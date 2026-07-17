"use client";

import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { Archive, ArchiveRestore, BookOpen, Code2, Eye, Pencil, Plus, Search, X } from "lucide-react";
import { BraiChatApi } from "@/shared/api/braiChatApi";
import { defaultApiBase } from "@/shared/config/runtime";
import type { BraiChatEvent, BraiChatMessage, BraiChatModel, BraiChatSearchHit, BraiChatThread } from "@/shared/types/braiChat";
import { getBraiLocalStorageItem, setBraiLocalStorageItem } from "@/shared/storage/localStorageKeys";
import { useRuntimeBearerToken } from "@/shared/auth/runtimeBearerToken";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/ui/select";
import { cx } from "../../appUtils";
import { IconButton, MobileContextSheet } from "../../chrome/AppChrome";
import type { ThemeMode } from "../../appModel";
import { requestMobileProfileDrawerClose } from "../../navigation/MobileProfileDrawer";
import { useMobileNavigationViewport } from "../../navigation/useSectionSwipeNavigation";
import { BraiChatWorkspace } from "./BraiChatInspector";
import {
  artifactWorkspaceMode,
  projectBraiChatArtifacts,
  splitSearchSnippet,
  type BraiChatArtifact,
  type BraiContextPanel,
  type BraiWorkspaceMode,
} from "./braiChatModel";

type PendingAnchor = { kind: "message" | "event"; id: string; threadId: string };
type RetryLast = () => Promise<void>;
const GENERATED_TITLE_REFRESH_DELAYS_MS = [2_000, 10_000, 35_000] as const;
const CONTEXT_PANEL_LABELS: Record<BraiWorkspaceMode, string> = {
  preview: "Preview",
  code: "Code",
  docs: "Docs",
};
const BraiCopilotSurface = dynamic(() => import("./BraiCopilotSurface").then((module) => module.BraiCopilotSurface), {
  ssr: false,
  loading: () => <div className="grid h-full place-items-center text-sm text-muted-foreground">Подключение к Браю</div>,
});

export function BraiChatSection({
  contextPanel,
  onContextPanelChange,
  theme = "dark",
  userId,
  onRailContent,
}: {
  contextPanel: BraiContextPanel;
  onContextPanelChange: (panel: BraiContextPanel) => void;
  theme?: ThemeMode;
  userId?: string | null;
  onRailContent?: (content: ReactNode | null) => void;
}) {
  const api = useMemo(() => new BraiChatApi(defaultApiBase(), userId), [userId]);
  const runtimeBearerToken = useRuntimeBearerToken();
  const lastThreadStorageKey = useMemo(
    () => `brai_chat_last_thread:${encodeURIComponent(userId ?? "anonymous")}:${encodeURIComponent(defaultApiBase() || "same-origin")}`,
    [userId],
  );
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
  const [pendingAnchor, setPendingAnchor] = useState<PendingAnchor | null>(null);
  const [workspaceTargetId, setWorkspaceTargetId] = useState<string | null>(null);
  const activeThreadIdRef = useRef<string | null>(null);
  const archivedRef = useRef(false);
  const generatedTitleRefreshTimersRef = useRef<number[]>([]);
  const retryLastRef = useRef<RetryLast | null>(null);
  const mobileViewport = useMobileNavigationViewport();
  const activeThread = threads.find((thread) => thread.id === activeThreadId) ?? null;
  const artifacts = useMemo(() => projectBraiChatArtifacts(messages, events), [events, messages]);
  const loadAttachment = useCallback(
    (id: string, download?: boolean) => api.attachmentBlob(id, download),
    [api],
  );

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
    setPendingAnchor(null);
    setWorkspaceTargetId(null);
    retryLastRef.current = null;
    setRetryAvailable(false);
  }, []);

  const activateThread = useCallback((id: string | null) => {
    activeThreadIdRef.current = id;
    setActiveThreadId(id);
    if (id && !archivedRef.current) {
      try {
        setBraiLocalStorageItem(lastThreadStorageKey, id);
      } catch {
        // localStorage is optional in constrained WebViews.
      }
    }
  }, [lastThreadStorageKey]);

  const setArchivedMode = useCallback((value: boolean) => {
    archivedRef.current = value;
    setArchived(value);
  }, []);

  const clearGeneratedTitleRefreshTimers = useCallback(() => {
    for (const timer of generatedTitleRefreshTimersRef.current) window.clearTimeout(timer);
    generatedTitleRefreshTimersRef.current = [];
  }, []);

  useEffect(() => clearGeneratedTitleRefreshTimers, [activeThreadId, archived, clearGeneratedTitleRefreshTimers]);

  const chooseWorkspaceMode = useCallback((mode: BraiWorkspaceMode, targetId: string | null = null) => {
    setWorkspaceTargetId(targetId);
    onContextPanelChange(mode);
    requestMobileProfileDrawerClose();
  }, [onContextPanelChange]);

  const openArtifact = useCallback((artifact: BraiChatArtifact) => {
    chooseWorkspaceMode(artifactWorkspaceMode(artifact), artifact.id);
  }, [chooseWorkspaceMode]);

  const loadThreads = useCallback(async (showArchived: boolean) => {
    setStatus("Загрузка чатов");
    try {
      const next = await api.threads(showArchived);
      const current = activeThreadIdRef.current;
      let remembered: string | null = null;
      if (!showArchived) {
        try {
          remembered = getBraiLocalStorageItem(lastThreadStorageKey);
        } catch {
          // localStorage is optional in constrained WebViews.
        }
      }
      const nextId = next.some((thread) => thread.id === current)
        ? current
        : next.some((thread) => thread.id === remembered) ? remembered : next[0]?.id ?? null;
      if (nextId !== current) resetProjections();
      setThreads(next);
      activateThread(nextId);
      setStatus(next.length > 0 ? "" : showArchived ? "Архив пуст" : "Создайте первый чат");
      return true;
    } catch {
      if (!activeThreadIdRef.current) setStatus("Брай временно недоступен");
      reportChatError("Брай временно недоступен");
      return false;
    }
  }, [activateThread, api, lastThreadStorageKey, reportChatError, resetProjections]);

  useEffect(() => {
    const timeout = window.setTimeout(() => void loadThreads(archived), 0);
    return () => window.clearTimeout(timeout);
  }, [archived, loadThreads]);

  useEffect(() => {
    let cancelled = false;
    void api.models().then((catalog) => { if (!cancelled) setModels(catalog.models); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [api]);

  useEffect(() => {
    if (!activeThreadId) return;
    let cancelled = false;
    void Promise.allSettled([api.messages(activeThreadId), api.events(activeThreadId)]).then(([messageResult, eventResult]) => {
      if (cancelled) return;
      if (messageResult.status === "fulfilled") setMessages(messageResult.value);
      if (eventResult.status === "fulfilled") setEvents(eventResult.value);
      if (messageResult.status === "rejected" || eventResult.status === "rejected") {
        reportChatError("Часть истории временно не загрузилась. Уже полученные сообщения сохранены");
      }
    });
    return () => { cancelled = true; };
  }, [activeThreadId, api, reportChatError]);

  useEffect(() => {
    if (!pendingAnchor || pendingAnchor.kind !== "event" || pendingAnchor.threadId !== activeThreadId) return;
    const event = events.find((item) => item.id === pendingAnchor.id);
    if (!event) return;
    const timeout = window.setTimeout(() => {
      const artifact = artifacts.find((item) => item.sourceEventId === event.id);
      if (artifact) {
        openArtifact(artifact);
        setPendingAnchor(null);
      }
      else if (event.message_id) setPendingAnchor({ kind: "message", id: event.message_id, threadId: activeThreadId });
      else setPendingAnchor(null);
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [activeThreadId, artifacts, events, openArtifact, pendingAnchor]);

  useEffect(() => {
    if (!pendingAnchor || pendingAnchor.kind !== "message" || pendingAnchor.threadId !== activeThreadId) return;
    if (!messages.some((message) => message.id === pendingAnchor.id)) return;
    const scroll = () => {
      const element = document.getElementById(`brai-message-${pendingAnchor.id}`);
      if (!element) return false;
      element.scrollIntoView({ block: "center" });
      setPendingAnchor(null);
      return true;
    };
    if (scroll()) return;
    const observer = new MutationObserver(() => { if (scroll()) observer.disconnect(); });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [activeThreadId, messages, pendingAnchor]);

  const createThread = useCallback(async () => {
    try {
      const thread = await api.createThread();
      setArchivedMode(false);
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
  }, [activateThread, api, clearChatError, reportChatError, resetProjections, setArchivedMode]);

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
      setArchivedMode(targetArchived);
      setThreads(nextThreads);
      if (hit.thread_id !== activeThreadId) resetProjections();
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
  }, [activateThread, activeThreadId, api, archived, clearChatError, reportChatError, resetProjections, setArchivedMode, threads]);

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
    const completedThreadId = activeThreadId;
    const completedArchived = archived;
    const [messageResult, eventResult, threadResult] = await Promise.allSettled([
      api.messages(completedThreadId),
      api.events(completedThreadId),
      api.threads(completedArchived),
    ]);
    if (activeThreadIdRef.current !== completedThreadId || archivedRef.current !== completedArchived) return;
    if (messageResult.status === "fulfilled") setMessages(messageResult.value);
    if (eventResult.status === "fulfilled") setEvents(eventResult.value);
    if (threadResult.status === "fulfilled") setThreads(threadResult.value);
    const failed = [messageResult, eventResult, threadResult].some((result) => result.status === "rejected");
    if (failed) {
      reportChatError("Ответ завершён. Часть обновлений временно недоступна, уже полученные данные сохранены");
    } else {
      clearChatError();
    }
    if (threadResult.status === "fulfilled") {
      clearGeneratedTitleRefreshTimers();
      for (const delayMs of GENERATED_TITLE_REFRESH_DELAYS_MS) {
        const timer = window.setTimeout(() => {
          generatedTitleRefreshTimersRef.current = generatedTitleRefreshTimersRef.current.filter((candidate) => candidate !== timer);
          if (activeThreadIdRef.current !== completedThreadId || archivedRef.current !== completedArchived) return;
          void api.threads(completedArchived).then((latestThreads) => {
            if (activeThreadIdRef.current === completedThreadId && archivedRef.current === completedArchived) {
              setThreads(latestThreads);
            }
          }).catch(() => undefined);
        }, delayMs);
        generatedTitleRefreshTimersRef.current.push(timer);
      }
    }
  }, [activeThreadId, api, archived, clearChatError, clearGeneratedTitleRefreshTimers, reportChatError]);

  const steer = useCallback(async (messageId: string, text: string) => {
    if (!activeThreadId) throw new Error("brai_chat_thread_missing");
    await api.steer(activeThreadId, messageId, text);
  }, [activeThreadId, api]);

  const navigateToSource = useCallback((artifact: BraiChatArtifact) => {
    const messageId = artifact.sourceMessageId
      ?? events.find((event) => event.id === artifact.sourceEventId)?.message_id
      ?? undefined;
    if (!messageId || !activeThreadId) return;
    if (mobileViewport) onContextPanelChange("none");
    setPendingAnchor({ kind: "message", id: messageId, threadId: activeThreadId });
  }, [activeThreadId, events, mobileViewport, onContextPanelChange]);

  const rail = useMemo(() => (
    <BraiThreadRail
      activeThreadId={activeThreadId}
      archived={archived}
      searchResults={searchResults}
      status={status}
      threads={threads}
      onArchive={toggleArchive}
      onArchived={setArchivedMode}
      onCreate={createThread}
      onRename={renameThread}
      onSearch={search}
      onSearchHit={openSearchHit}
      onSelect={selectThread}
    />
  ), [activeThreadId, archived, createThread, openSearchHit, renameThread, search, searchResults, selectThread, setArchivedMode, status, threads, toggleArchive]);

  useEffect(() => {
    if (!onRailContent) return;
    onRailContent(rail);
    return () => onRailContent(null);
  }, [onRailContent, rail]);

  const selectedModel = models.find((model) => model.id === activeThread?.model) ?? null;
  const reasoningEfforts = selectedModel?.reasoning_efforts ?? [];
  const providerHeaders = {
    ...(userId ? { "x-brai-expected-user-id": userId } : {}),
    "x-brai-chat-replay-mode": "full",
  };

  return (
    <div
      className={cx(
        "brai-chat-workspace grid h-full min-h-0 gap-7 overflow-hidden max-[860px]:grid max-[860px]:grid-cols-[minmax(0,1fr)]",
        contextPanel === "none" ? "grid-cols-[minmax(0,1fr)]" : "grid-cols-[minmax(0,1fr)_minmax(0,1fr)]",
      )}
      data-nav-swipe-exclusion
    >
      <section className="brai-chat-pane grid h-full min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] bg-background" aria-label="Чат с Браем">
        <div className="flex min-h-12 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
          <p className="m-0 min-w-24 flex-1 truncate text-sm font-semibold">{activeThread?.title ?? "Брай"}</p>
          <Select value={activeThread?.model ?? ""} disabled={!activeThread || models.length === 0} onValueChange={(model) => void updateSettings({ model })}>
            <SelectTrigger size="sm" aria-label="Модель Брая"><SelectValue placeholder="Модель" /></SelectTrigger>
            <SelectContent>{models.map((model) => <SelectItem key={model.id} value={model.id}>{model.display_name || model.id}</SelectItem>)}</SelectContent>
          </Select>
          <Select value={activeThread?.reasoning_effort ?? ""} disabled={!activeThread || reasoningEfforts.length === 0} onValueChange={(reasoning_effort) => void updateSettings({ reasoning_effort })}>
            <SelectTrigger size="sm" aria-label="Глубина рассуждений Брая"><SelectValue placeholder="Рассуждения" /></SelectTrigger>
            <SelectContent>{reasoningEfforts.map((effort) => <SelectItem key={effort} value={effort}>{effort}</SelectItem>)}</SelectContent>
          </Select>
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
              theme={theme}
              runtimeUrl={api.runtimeUrl()}
              threadId={activeThread.id}
              headers={providerHeaders}
              runtimeBearerToken={runtimeBearerToken}
              onError={reportChatError}
              onRetryChange={handleRetryChange}
              onRunFinished={refreshAfterRun}
              onSteer={steer}
              onDeleteAttachment={(id) => api.deleteUnlinkedAttachment(id)}
              onUpload={async (file) => {
                const attachment = await api.uploadAttachment(activeThread.id, file);
                clearChatError();
                return { id: attachment.id, mediaType: attachment.media_type, url: api.attachmentUrl(attachment.id) };
              }}
              loadAttachment={loadAttachment}
              draftStorageKey={`brai_chat_draft:${encodeURIComponent(userId ?? "anonymous")}:${encodeURIComponent(defaultApiBase() || "same-origin")}:${activeThread.id}`}
            />
          ) : (
            <div className="grid h-full place-items-center px-6 text-center"><div><p className="text-sm text-muted-foreground">{status}</p>{!archived ? <Button type="button" className="mt-3" onClick={() => void createThread()}><Plus aria-hidden="true" />Новый чат</Button> : null}</div></div>
          )}
        </div>
      </section>
      {contextPanel !== "none" ? (
      <aside className="relative z-10 hidden h-full min-h-0 min-w-0 min-[861px]:block" aria-label={`Панель ${CONTEXT_PANEL_LABELS[contextPanel]}`} data-galaxy-interaction-block>
        <BraiChatWorkspace
          instance="desktop"
          mode={contextPanel}
          artifacts={artifacts}
          targetId={workspaceTargetId}
          loadAttachment={loadAttachment}
          onSource={navigateToSource}
        />
      </aside>
      ) : null}
      {contextPanel !== "none" && mobileViewport ? (
        <MobileContextSheet label={CONTEXT_PANEL_LABELS[contextPanel]} variant="detail" scroll={false} onClose={() => onContextPanelChange("none")}>
          <BraiChatWorkspace
            instance="mobile"
            mode={contextPanel}
            artifacts={artifacts}
            targetId={workspaceTargetId}
            loadAttachment={loadAttachment}
            onSource={navigateToSource}
          />
        </MobileContextSheet>
      ) : null}
    </div>
  );
}

export function BraiContextPanelActions({ panel, onPanelChange }: {
  panel: BraiContextPanel;
  onPanelChange: (panel: BraiContextPanel) => void;
}) {
  const toggle = (next: BraiWorkspaceMode) => onPanelChange(panel === next ? "none" : next);
  return (
    <>
      <IconButton icon={Eye} label="Preview" active={panel === "preview"} onClick={() => toggle("preview")} />
      <IconButton icon={Code2} label="Code" active={panel === "code"} onClick={() => toggle("code")} />
      <IconButton icon={BookOpen} label="Docs" active={panel === "docs"} className="min-[861px]:mr-5" onClick={() => toggle("docs")} />
    </>
  );
}

function BraiThreadRail({ activeThreadId, archived, searchResults, status, threads, onArchive, onArchived, onCreate, onRename, onSearch, onSearchHit, onSelect }: {
  activeThreadId: string | null;
  archived: boolean;
  searchResults: BraiChatSearchHit[];
  status: string;
  threads: BraiChatThread[];
  onArchive: (thread: BraiChatThread) => Promise<void>;
  onArchived: (archived: boolean) => void;
  onCreate: () => Promise<void>;
  onRename: (id: string, title: string) => Promise<void>;
  onSearch: (query: string, includeArchived: boolean) => Promise<void>;
  onSearchHit: (hit: BraiChatSearchHit) => Promise<void>;
  onSelect: (id: string) => void;
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
      <section className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)]" aria-labelledby="brai-thread-list-label">
        <h2 id="brai-thread-list-label" className="m-0 px-4 pb-1 pt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Чаты</h2>
        <ScrollArea className="min-h-0" contentInset="none"><div className="grid gap-1 p-2">
          {searchResults.length > 0 ? searchResults.map((hit) => (
            <button key={hit.id} type="button" className="rounded-md px-3 py-2 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => void onSearchHit(hit)}><span className="block truncate text-sm font-medium">{hit.thread_title}</span><SearchSnippet snippet={hit.snippet} /></button>
          )) : threads.map((thread) => (
            <div key={thread.id} className={cx("group grid grid-cols-[minmax(0,1fr)_auto] items-center rounded-md", activeThreadId === thread.id && "bg-accent") }>
              {editing === thread.id ? <Input autoFocus defaultValue={thread.title} aria-label={`Название чата: ${thread.title}`} className="m-1" onBlur={(event) => { void onRename(thread.id, event.target.value); setEditing(null); }} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") setEditing(null); }} /> : <button type="button" className="min-w-0 truncate px-3 py-2 text-left text-sm" onClick={() => onSelect(thread.id)}>{thread.title}</button>}
              <div className="flex pr-1"><Button type="button" size="icon-xs" variant="ghost" aria-label={`Переименовать: ${thread.title}`} onClick={() => setEditing(thread.id)}><Pencil aria-hidden="true" /></Button><Button type="button" size="icon-xs" variant="ghost" aria-label={`${archived ? "Восстановить" : "Архивировать"}: ${thread.title}`} onClick={() => void onArchive(thread)}>{archived ? <ArchiveRestore aria-hidden="true" /> : <Archive aria-hidden="true" />}</Button></div>
            </div>
          ))}
          {searchResults.length === 0 && threads.length === 0 ? <p className="px-3 py-4 text-sm text-muted-foreground">{status}</p> : null}
        </div></ScrollArea>
      </section>
    </div>
  );
}

function SearchSnippet({ snippet }: { snippet: string }) {
  return (
    <span className="mt-1 block line-clamp-2 text-xs text-muted-foreground">
      {splitSearchSnippet(snippet).map((part, index) => part.highlighted ? <mark key={index} className="bg-accent text-accent-foreground">{part.text}</mark> : part.text)}
    </span>
  );
}
