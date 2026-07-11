"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { Edit3, Maximize2, Minimize2, PanelLeftClose, PanelLeftOpen, Plus } from "lucide-react";
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { ThemeMode } from "../../appModel";
import { BraiApi, type BraiApiError, type DrawSceneSummary } from "@/shared/api/braiApi";
import { defaultApiBase } from "@/shared/config/runtime";
import { Button } from "@/shared/ui/button";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { cx } from "../../appUtils";

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

export function DrawsSection({ theme }: { theme: ThemeMode }) {
  const api = useMemo(() => new BraiApi(defaultApiBase()), []);
  const [draws, setDraws] = useState<DrawSceneSummary[]>([]);
  const [activeName, setActiveName] = useState(DEFAULT_DRAW_NAME);
  const [scene, setScene] = useState<Record<string, unknown> | null>(null);
  const [status, setStatus] = useState<SaveStatus>("loading");
  const [listOpen, setListOpen] = useState(true);
  const [fullScreen, setFullScreen] = useState(false);
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

  const createDraw = useCallback(() => {
    const title = window.prompt("Название сцены", defaultUntitledName(draws));
    if (!title) return;
    const name = toDrawFileName(title);
    setActiveName(name);
    setDraws((current) => upsertDraw(current, {
      name,
      title: name.replace(/\.excalidraw$/, ""),
      updated_at_utc: new Date().toISOString(),
      size_bytes: 0,
    }));
  }, [draws]);

  const renameDraw = useCallback(async (name: string) => {
    const current = draws.find((draw) => draw.name === name);
    const title = window.prompt("Новое название", current?.title ?? name.replace(/\.excalidraw$/, ""));
    if (!title) return;
    const nextName = toDrawFileName(title);
    if (nextName === name) return;
    if (saveTimerRef.current != null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    setStatus("saving");
    try {
      if (name === activeName && pendingSceneRef.current) {
        await api.saveDraw(name, pendingSceneRef.current);
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
  }, [activeName, api, draws]);

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
        fullScreen && "fixed inset-0 z-[120] bg-background p-2",
      )}
    >
      {showList ? (
      <aside className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] rounded-md border border-border bg-card">
        <div className="flex items-center justify-between gap-2 border-b border-border p-2">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold leading-5">Draws</h2>
            <p className="truncate text-xs text-muted-foreground">{saveStatusLabel(status)}</p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button type="button" size="icon-sm" variant="ghost" aria-label="Скрыть список рисунков" title="Скрыть список рисунков" onClick={() => setListOpen(false)}>
              <PanelLeftClose className="size-4" aria-hidden="true" />
            </Button>
            <Button type="button" size="icon-sm" variant="ghost" aria-label="Создать сцену" title="Создать сцену" onClick={createDraw}>
              <Plus className="size-4" aria-hidden="true" />
            </Button>
          </div>
        </div>
        <ScrollArea className="min-h-0">
          <div className="grid gap-1 p-2">
            {draws.length ? draws.map((draw) => (
              <div
                key={draw.name}
                className={cx(
                  "grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center rounded-md hover:bg-accent hover:text-accent-foreground",
                  draw.name === activeName && "bg-accent text-accent-foreground",
                )}
                onContextMenu={(event) => {
                  event.preventDefault();
                  void renameDraw(draw.name);
                }}
              >
                <button type="button" className="grid min-w-0 px-2 py-2 text-left text-sm" onClick={() => setActiveName(draw.name)}>
                  <span className="truncate font-medium">{draw.title}</span>
                  <span className="truncate text-xs text-muted-foreground">{formatUpdatedAt(draw.updated_at_utc)}</span>
                </button>
                <Button type="button" size="icon-xs" variant="ghost" aria-label={`Переименовать ${draw.title}`} title="Переименовать" onClick={() => void renameDraw(draw.name)}>
                  <Edit3 className="size-3" aria-hidden="true" />
                </Button>
              </div>
            )) : (
              <button
                type="button"
                className="rounded-md px-2 py-2 text-left text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                onClick={() => setActiveName(DEFAULT_DRAW_NAME)}
              >
                Новый рисунок
              </button>
            )}
          </div>
        </ScrollArea>
      </aside>
      ) : null}
      <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-md border border-border bg-background" data-nav-swipe-exclusion>
        <div className="flex min-h-10 items-center justify-between gap-2 border-b border-border bg-card/80 px-2 py-1">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{activeName.replace(/\.excalidraw$/, "")}</p>
            <p className="truncate text-xs text-muted-foreground">{saveStatusLabel(status)}</p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button type="button" size="icon-sm" variant="ghost" aria-label={listOpen ? "Скрыть список рисунков" : "Показать список рисунков"} title={listOpen ? "Скрыть список рисунков" : "Показать список рисунков"} disabled={fullScreen} onClick={() => setListOpen((open) => !open)}>
              {listOpen ? <PanelLeftClose className="size-4" aria-hidden="true" /> : <PanelLeftOpen className="size-4" aria-hidden="true" />}
            </Button>
            <Button type="button" size="icon-sm" variant="ghost" aria-label="Переименовать рисунок" title="Переименовать рисунок" onClick={() => void renameDraw(activeName)}>
              <Edit3 className="size-4" aria-hidden="true" />
            </Button>
            <Button type="button" size="icon-sm" variant="ghost" aria-label={fullScreen ? "Выйти из полноэкранного режима" : "На весь экран"} title={fullScreen ? "Выйти из полноэкранного режима" : "На весь экран"} onClick={() => setFullScreen((open) => !open)}>
              {fullScreen ? <Minimize2 className="size-4" aria-hidden="true" /> : <Maximize2 className="size-4" aria-hidden="true" />}
            </Button>
          </div>
        </div>
        <div className="min-h-0 overflow-hidden">
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
      </div>
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

function toDrawFileName(title: string): string {
  const trimmed = title.trim().replace(/[\\/\0]/g, " ").replace(/\.+/g, ".").slice(0, 96) || "Новый рисунок";
  const name = trimmed.endsWith(".excalidraw") ? trimmed : `${trimmed}.excalidraw`;
  return name.includes("..") ? name.replace(/\.\./g, ".") : name;
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
