"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type MouseEvent } from "react";
import dynamic from "next/dynamic";
import { Maximize2, Minimize2, PanelLeftClose, PanelLeftOpen, Plus } from "lucide-react";
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { ThemeMode } from "../../appModel";
import { BraiApi, type BraiApiError, type DrawSceneSummary } from "@/shared/api/braiApi";
import { defaultApiBase } from "@/shared/config/runtime";
import { Button } from "@/shared/ui/button";
import { Card, CardPanel } from "@/shared/ui/card";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { cx, plainEditableText, setPlainEditableText } from "../../appUtils";
import { isMobileNavigationViewport } from "../../navigation/useSectionSwipeNavigation";

type SaveStatus = "loading" | "idle" | "saving" | "saved" | "error";

const DEFAULT_DRAW_NAME = "Новый рисунок.excalidraw";
const DrawsCanvas = dynamic(() => import("./DrawsCanvas").then((module) => module.DrawsCanvas), {
  ssr: false,
  loading: () => <div className="grid h-full place-items-center text-sm text-muted-foreground">Загрузка редактора</div>,
});

const emptyScene = (): Record<string, unknown> => ({
  type: "excalidraw",
  version: 2,
  source: "brai",
  elements: [],
  appState: { viewBackgroundColor: "#ffffff" },
  files: {},
});

export function DrawsSection({ theme, onFullscreenChange }: { theme: ThemeMode; onFullscreenChange?: (fullScreen: boolean) => void }) {
  const api = useMemo(() => new BraiApi(defaultApiBase()), []);
  const [draws, setDraws] = useState<DrawSceneSummary[]>([]);
  const [activeName, setActiveName] = useState(DEFAULT_DRAW_NAME);
  const [scene, setScene] = useState<Record<string, unknown> | null>(null);
  const [status, setStatus] = useState<SaveStatus>("loading");
  const [listOpen, setListOpen] = useState(true);
  const [fullScreen, setFullScreen] = useState(false);
  const [editingName, setEditingName] = useState<string | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const loadedRef = useRef(false);
  const pendingSceneRef = useRef<Record<string, unknown> | null>(null);

  const saveScene = useCallback(async (name: string, nextScene: Record<string, unknown>) => {
    setStatus("saving");
    try {
      const saved = await api.saveDraw(name, nextScene);
      setDraws((current) => upsertDraw(current, saved));
      setStatus("saved");
    } catch {
      setStatus("error");
    }
  }, [api]);

  const loadScene = useCallback(async (name: string) => {
    loadedRef.current = false;
    setStatus("loading");
    try {
      const loaded = await api.draw(name);
      setScene(loaded.scene);
      setDraws((current) => upsertDraw(current, loaded));
      setStatus("idle");
    } catch (error) {
      if ((error as BraiApiError).status !== 404) {
        setScene(null);
        setStatus("error");
        return;
      }
      const nextScene = emptyScene();
      setScene(nextScene);
      setStatus("idle");
    } finally {
      loadedRef.current = true;
    }
  }, [api]);

  useEffect(() => {
    let cancelled = false;
    void api.draws().then(({ draws: nextDraws }) => {
      if (cancelled) return;
      setDraws(nextDraws);
      setActiveName(nextDraws[0]?.name ?? DEFAULT_DRAW_NAME);
    }).catch(() => {
      if (!cancelled) setStatus("error");
    });
    return () => {
      cancelled = true;
    };
  }, [api]);

  useEffect(() => {
    const timeout = window.setTimeout(() => void loadScene(activeName), 0);
    return () => window.clearTimeout(timeout);
  }, [activeName, loadScene]);

  useEffect(() => () => {
    if (saveTimerRef.current != null) window.clearTimeout(saveTimerRef.current);
  }, []);

  useEffect(() => {
    onFullscreenChange?.(fullScreen);
    return () => onFullscreenChange?.(false);
  }, [fullScreen, onFullscreenChange]);

  const createDraw = useCallback(() => {
    const name = toDrawFileName(defaultUntitledName(draws));
    setActiveName(name);
    setEditingName(name);
    setDraws((current) => upsertDraw(current, {
      name,
      title: name.replace(/\.excalidraw$/, ""),
      updated_at_utc: new Date().toISOString(),
      size_bytes: 0,
    }));
  }, [draws]);

  const renameDraw = useCallback(async (name: string, title: string) => {
    const nextName = toDrawFileName(title);
    if (nextName === name) return;
    if (saveTimerRef.current != null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    setStatus("saving");
    try {
      if (name === activeName) {
        await api.saveDraw(name, pendingSceneRef.current ?? scene ?? emptyScene());
        pendingSceneRef.current = null;
      }
      const renamed = await api.renameDraw(name, nextName);
      setDraws((currentDraws) => upsertDraw(currentDraws.filter((draw) => draw.name !== name), renamed));
      if (name === activeName) {
        setActiveName(renamed.name);
        setScene(renamed.scene);
      }
      setStatus("saved");
    } catch {
      setStatus("error");
    }
  }, [activeName, api, scene]);

  const onChange = useCallback((elements: readonly ExcalidrawElement[], appState: AppState, files: BinaryFiles) => {
    if (!loadedRef.current) return;
    const nextScene = {
      type: "excalidraw",
      version: 2,
      source: "brai",
      elements,
      appState,
      files,
    } as Record<string, unknown>;
    pendingSceneRef.current = nextScene;
    if (saveTimerRef.current != null) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      void saveScene(activeName, nextScene).then(() => {
        if (pendingSceneRef.current === nextScene) pendingSceneRef.current = null;
      });
    }, 700);
    setStatus("saving");
  }, [activeName, saveScene]);

  const showList = listOpen && !fullScreen;

  return (
    <div
      className={cx(
        "grid h-full min-h-0 gap-3",
        showList ? "grid-cols-[13rem_minmax(0,1fr)] max-[860px]:grid-cols-1 max-[860px]:grid-rows-[auto_minmax(0,1fr)]" : "grid-cols-1",
        fullScreen && "gap-0",
      )}
    >
      {showList ? (
        <Card className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden">
          <div className="flex items-center justify-between gap-3 border-b border-border p-4">
            <div className="min-w-0">
              <h2 className="m-0 truncate text-lg font-semibold leading-none">Draws</h2>
              <p className="m-0 mt-1 truncate text-sm text-muted-foreground">{saveStatusLabel(status)}</p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Button type="button" size="icon-sm" variant="ghost" aria-label="Создать сцену" title="Создать сцену" onClick={createDraw}>
                <Plus className="size-4" aria-hidden="true" />
              </Button>
            </div>
          </div>
          <ScrollArea className="min-h-0 [&>[data-slot=scroll-area-scrollbar]]:!right-1" contentInset="none">
            <div className="grid gap-2 p-4">
              {draws.length ? draws.map((draw) => (
                <div
                  key={draw.name}
                  role="button"
                  tabIndex={0}
                  className={cx(
                    "group grid min-h-[72px] min-w-0 cursor-pointer content-center rounded-lg border border-transparent px-3 py-2.5 text-left transition-colors hover:bg-accent/60 hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                    draw.name === activeName && "border-primary/20 bg-primary/10 text-accent-foreground",
                  )}
                  onClick={() => setActiveName(draw.name)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    setActiveName(draw.name);
                  }}
                >
                  <div className="min-w-0">
                    <span className="block truncate font-medium">{draw.title}</span>
                    <span className="block truncate text-xs text-muted-foreground">{formatUpdatedAt(draw.updated_at_utc)}</span>
                  </div>
                </div>
              )) : (
                <button
                  type="button"
                  className="min-h-[72px] rounded-lg px-3 py-2.5 text-left text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                  onClick={() => setActiveName(DEFAULT_DRAW_NAME)}
                >
                  Новый рисунок
                </button>
              )}
            </div>
          </ScrollArea>
        </Card>
      ) : null}
      <Card className={cx("grid min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden", fullScreen && "rounded-none border-0 shadow-none before:hidden")} data-nav-swipe-exclusion>
        <div className="flex min-h-14 items-center justify-between gap-3 border-b border-border px-3 py-2">
          {!fullScreen ? (
            <Button type="button" size="icon-sm" variant="ghost" aria-label={listOpen ? "Скрыть список рисунков" : "Показать список рисунков"} title={listOpen ? "Скрыть список рисунков" : "Показать список рисунков"} onClick={() => setListOpen((open) => !open)}>
              {listOpen ? <PanelLeftClose className="size-4" aria-hidden="true" /> : <PanelLeftOpen className="size-4" aria-hidden="true" />}
            </Button>
          ) : null}
          <div className="min-w-0 flex-1">
            <DrawTitleEditor
              editing={editingName === activeName}
              label={`Название рисунка: ${activeName.replace(/\.excalidraw$/, "")}`}
              title={activeName.replace(/\.excalidraw$/, "")}
              onCommit={(title) => renameDraw(activeName, title)}
              onEditDone={() => setEditingName(null)}
              onEditStart={() => setEditingName(activeName)}
            />
            <p className="truncate text-xs text-muted-foreground">{saveStatusLabel(status)}</p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button type="button" size="icon-sm" variant="ghost" aria-label={fullScreen ? "Выйти из полноэкранного режима" : "На весь экран"} title={fullScreen ? "Выйти из полноэкранного режима" : "На весь экран"} onClick={() => setFullScreen((open) => !open)}>
              {fullScreen ? <Minimize2 className="size-4" aria-hidden="true" /> : <Maximize2 className="size-4" aria-hidden="true" />}
            </Button>
          </div>
        </div>
        <CardPanel className={cx("min-h-0", fullScreen ? "p-0" : "p-3")}>
          <div className={cx("h-full min-h-0 overflow-hidden bg-background", !fullScreen && "rounded-xl border border-border")}>
            {scene ? (
              <DrawsCanvas
                key={activeName}
                initialData={scene}
                name={activeName}
                onChange={onChange}
                theme={theme}
              />
            ) : (
              <div className="grid h-full place-items-center text-sm text-muted-foreground">Загрузка</div>
            )}
          </div>
        </CardPanel>
      </Card>
    </div>
  );
}

function upsertDraw(draws: DrawSceneSummary[], next: DrawSceneSummary): DrawSceneSummary[] {
  const rest = draws.filter((draw) => draw.name !== next.name);
  return [next, ...rest].sort((left, right) => right.updated_at_utc.localeCompare(left.updated_at_utc) || left.name.localeCompare(right.name));
}

function defaultUntitledName(draws: DrawSceneSummary[]): string {
  const existing = new Set(draws.map((draw) => draw.name));
  for (let index = 1; index < 1000; index += 1) {
    const title = index === 1 ? "Новый рисунок" : `Новый рисунок ${index}`;
    if (!existing.has(`${title}.excalidraw`)) return title;
  }
  return `Новый рисунок ${Date.now()}`;
}

function DrawTitleEditor({
  editing,
  label,
  title,
  onCommit,
  onEditDone,
  onEditStart,
}: {
  editing: boolean;
  label: string;
  title: string;
  onCommit: (title: string) => Promise<void>;
  onEditDone: () => void;
  onEditStart: () => void;
}) {
  const titleRef = useRef<HTMLSpanElement | null>(null);
  const mobile = useHydratedMobileNavigationViewport();

  useLayoutEffect(() => {
    if (!editing || !titleRef.current || document.activeElement === titleRef.current) return;
    setPlainEditableText(titleRef.current, title);
  }, [editing, title]);

  useEffect(() => {
    if (!editing || !titleRef.current) return;
    titleRef.current.focus();
    const range = document.createRange();
    range.selectNodeContents(titleRef.current);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, [editing]);

  async function saveTitle() {
    const nextTitle = cleanDrawTitle(titleRef.current ? plainEditableText(titleRef.current) : "");
    if (!nextTitle) {
      setPlainEditableText(titleRef.current, title);
      onEditDone();
      return;
    }
    if (nextTitle !== title) await onCommit(nextTitle);
    onEditDone();
  }

  function onInput() {
    const nextTitle = limitDrawTitle(titleRef.current ? plainEditableText(titleRef.current) : "");
    setPlainEditableText(titleRef.current, nextTitle);
  }

  function onKeyDown(event: KeyboardEvent<HTMLSpanElement>) {
    event.stopPropagation();
    if (event.key === "Enter") {
      event.preventDefault();
      titleRef.current?.blur();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setPlainEditableText(titleRef.current, title);
      onEditDone();
      titleRef.current?.blur();
    }
  }

  function onClick(event: MouseEvent<HTMLSpanElement>) {
    event.stopPropagation();
    if (mobile && !editing) event.preventDefault();
    onEditStart();
  }

  if (!editing) {
    return (
      <button
        type="button"
        className="inline-block max-w-full truncate border-0 bg-transparent p-0 text-left align-top font-medium text-inherit hover:text-primary focus:text-primary focus:outline-0"
        aria-label={label}
        onClick={(event) => {
          event.stopPropagation();
          onEditStart();
        }}
      >
        {title}
      </button>
    );
  }

  return (
    <span
      ref={titleRef}
      className="inline-block max-w-full truncate align-top font-medium focus:text-primary focus:outline-0"
      contentEditable={!mobile || editing}
      suppressContentEditableWarning
      tabIndex={0}
      role="textbox"
      aria-label={label}
      onClick={onClick}
      onBlur={() => void saveTitle()}
      onInput={onInput}
      onKeyDown={onKeyDown}
    />
  );
}

function useHydratedMobileNavigationViewport(): boolean {
  return useSyncExternalStore(subscribeMobileNavigationViewport, isMobileNavigationViewport, () => false);
}

function subscribeMobileNavigationViewport(onStoreChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => undefined;
  const query = window.matchMedia("(max-width: 860px)");
  query.addEventListener("change", onStoreChange);
  return () => query.removeEventListener("change", onStoreChange);
}

function toDrawFileName(title: string): string {
  const trimmed = cleanDrawTitle(title) || "Новый рисунок";
  const name = trimmed.endsWith(".excalidraw") ? trimmed : `${trimmed}.excalidraw`;
  return name.includes("..") ? name.replace(/\.\./g, ".") : name;
}

function cleanDrawTitle(title: string): string {
  return limitDrawTitle(title).trim().replace(/[\\/\0]/g, " ").replace(/\.+/g, ".").replace(/\.excalidraw$/, "").trim();
}

function limitDrawTitle(title: string): string {
  return title.replace(/\s+/g, " ").slice(0, 96);
}

function saveStatusLabel(status: SaveStatus): string {
  if (status === "loading") return "Загрузка";
  if (status === "saving") return "Сохранение";
  if (status === "saved") return "Сохранено";
  if (status === "error") return "Ошибка сохранения";
  return "Локально в Vault/Draws";
}

function formatUpdatedAt(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}
