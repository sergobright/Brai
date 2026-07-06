"use client";

import type { CSSProperties, KeyboardEvent, PointerEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { Bot, CheckCircle2, Clock3, FileJson, GitBranch, Terminal, X, XCircle } from "lucide-react";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { installAndroidBackHandler } from "@/shared/platform/platform";
import { cx } from "../../appUtils";
import { useMobileSheetDrag } from "../../hooks/useMobileSheetDrag";
import { useMobileSheetTop } from "../../hooks/useMobileSheetTop";
import { isMobileNavigationViewport } from "../../navigation/useSectionSwipeNavigation";
import { ACTIONS_SPLIT_DEFAULT_PERCENT, ACTIONS_SPLIT_MIN_PERCENT, clampActionsSplitPercent } from "../actions/constants";

type FactoryLogStatus = "done" | "failed";

type FactoryLog = {
  id: number;
  agent_id: string;
  agent_version: string;
  dt: string;
  status: FactoryLogStatus;
  ai_title: string;
  flow_id: string | null;
  flow_command: string | null;
  json_data: {
    inputs: Array<{ ref: string; value: string }>;
    outputs: Array<{ ref: string; value: string }>;
    usage?: { model: string; prompt_tokens: number; completion_tokens: number };
    timings_ms?: { total: number; model: number; postprocess?: number };
    error_code?: string;
  };
};

const FACTORY_LOGS: FactoryLog[] = [
  {
    id: 1482,
    agent_id: "inbound.inbox.title_generator",
    agent_version: "3",
    dt: "2026-07-05T13:42:18.000Z",
    status: "done",
    ai_title: "Сгенерирован заголовок для входящего",
    flow_id: "inbox-telegram-742",
    flow_command: "normalize_inbound",
    json_data: {
      inputs: [{ ref: "request.text", value: "Созвон с Павлом по складскому экрану, сегодня после 18:00" }],
      outputs: [{ ref: "inbox.title", value: "Созвон по складскому экрану" }],
      usage: { model: "gpt-5-mini", prompt_tokens: 418, completion_tokens: 42 },
      timings_ms: { total: 1280, model: 1034, postprocess: 74 },
    },
  },
  {
    id: 1481,
    agent_id: "brai-cmd.dictate.transcription",
    agent_version: "1",
    dt: "2026-07-05T13:37:04.000Z",
    status: "done",
    ai_title: "Расшифрована голосовая команда",
    flow_id: "cmd-mobile-911",
    flow_command: "dictate",
    json_data: {
      inputs: [{ ref: "request.audio", value: "12.4 сек, device Pixel 9" }],
      outputs: [{ ref: "response.text", value: "Добавь в Factory отдельный поток логов AI и открой детали справа." }],
      usage: { model: "gpt-4o-transcribe", prompt_tokens: 0, completion_tokens: 37 },
      timings_ms: { total: 2190, model: 2012 },
    },
  },
  {
    id: 1480,
    agent_id: "maintenance.daily_digest",
    agent_version: "2",
    dt: "2026-07-05T12:10:43.000Z",
    status: "failed",
    ai_title: "Дайджест остановлен на проверке источников",
    flow_id: "daily-digest-2026-07-05",
    flow_command: "summarize_day",
    json_data: {
      inputs: [{ ref: "table.activities", value: "34 записи за сутки" }],
      outputs: [{ ref: "response.error", value: "Недостаточно свежих подтверждённых источников для публикации." }],
      usage: { model: "gpt-5", prompt_tokens: 1834, completion_tokens: 96 },
      timings_ms: { total: 4280, model: 3988 },
      error_code: "source_quality_gate",
    },
  },
  {
    id: 1479,
    agent_id: "scheduler.goal_rebalancer",
    agent_version: "5",
    dt: "2026-07-05T11:58:12.000Z",
    status: "done",
    ai_title: "Пересчитан производственный фокус",
    flow_id: "focus-plan-391",
    flow_command: "rebalance_goal",
    json_data: {
      inputs: [{ ref: "timer.sessions", value: "7 фокус-сессий за последние 48 часов" }],
      outputs: [{ ref: "goal.recommendation", value: "Сместить 40 минут с админки на Factory preview." }],
      usage: { model: "gpt-5-mini", prompt_tokens: 721, completion_tokens: 88 },
      timings_ms: { total: 1660, model: 1392, postprocess: 45 },
    },
  },
  {
    id: 1478,
    agent_id: "inbound.link_context",
    agent_version: "2",
    dt: "2026-07-05T11:31:29.000Z",
    status: "done",
    ai_title: "Извлечён контекст из ссылки",
    flow_id: "link-pipeline-208",
    flow_command: "extract_context",
    json_data: {
      inputs: [{ ref: "request.url", value: "https://brightos.world/admin/ops" }],
      outputs: [{ ref: "inbox.description_md", value: "Техническая ссылка классифицирована как operational context." }],
      usage: { model: "gpt-5-nano", prompt_tokens: 332, completion_tokens: 61 },
      timings_ms: { total: 940, model: 811 },
    },
  },
];

export function FactorySection({ onMobileOverlayChange }: { onMobileOverlayChange: (open: boolean) => void }) {
  const [selectedLogId, setSelectedLogId] = useState<number | null>(null);
  const [mobileLogId, setMobileLogId] = useState<number | null>(null);
  const [splitPercent, setSplitPercent] = useState(ACTIONS_SPLIT_DEFAULT_PERCENT);
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const splitDragStyleRef = useRef<{ cursor: string; userSelect: string } | null>(null);
  const selectedLog = FACTORY_LOGS.find((log) => log.id === selectedLogId) ?? null;
  const mobileLog = FACTORY_LOGS.find((log) => log.id === mobileLogId) ?? null;

  useEffect(() => {
    onMobileOverlayChange(mobileLog != null);
    return () => onMobileOverlayChange(false);
  }, [mobileLog, onMobileOverlayChange]);

  function openLog(log: FactoryLog) {
    setSelectedLogId(log.id);
    if (isMobileNavigationViewport()) setMobileLogId(log.id);
  }

  function onSplitPointerDown(event: PointerEvent<HTMLButtonElement>) {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    event.preventDefault();
    splitDragStyleRef.current = {
      cursor: document.documentElement.style.cursor,
      userSelect: document.body.style.userSelect,
    };
    document.documentElement.style.cursor = "ew-resize";
    document.body.style.userSelect = "none";
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onSplitPointerMove(event: PointerEvent<HTMLButtonElement>) {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const bounds = workspace.getBoundingClientRect();
    setSplitPercent(clampActionsSplitPercent(((event.clientX - bounds.left) / bounds.width) * 100));
  }

  function onSplitPointerEnd(event: PointerEvent<HTMLButtonElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const previous = splitDragStyleRef.current;
    if (!previous) return;
    document.documentElement.style.cursor = previous.cursor;
    document.body.style.userSelect = previous.userSelect;
    splitDragStyleRef.current = null;
  }

  function onSplitKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setSplitPercent((current) => clampActionsSplitPercent(current - 2));
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      setSplitPercent((current) => clampActionsSplitPercent(current + 2));
    }
  }

  return (
    <section className="relative grid h-full min-h-0 grid-rows-[minmax(0,1fr)] gap-3.5 max-[860px]:gap-0" aria-label="Factory">
      <div
        ref={workspaceRef}
        className="relative grid h-full min-h-0 min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-0 overflow-hidden max-[860px]:block"
        style={{
          "--actions-list-percent": `${splitPercent}%`,
          gridTemplateColumns: "minmax(0,var(--actions-list-percent)) minmax(0,calc(100% - var(--actions-list-percent)))",
        } as CSSProperties}
      >
        <ScrollArea className="h-full min-h-0 min-w-0 max-[860px]:-mx-3.5 max-[860px]:[&>[data-slot=scroll-area-scrollbar]]:!right-0" contentInset="none">
          <div className="grid gap-3 pr-[18px] max-[860px]:px-3.5" aria-label="Поток AI_logs">
            <div className="sticky top-0 z-[2] flex items-center justify-between gap-3 bg-background/95 pb-3 backdrop-blur max-[860px]:hidden">
              <div className="min-w-0">
                <p className="m-0 text-sm font-medium">AI_logs/</p>
                <p className="m-0 text-xs text-muted-foreground">Последние производственные срабатывания</p>
              </div>
              <Badge variant="outline">{FACTORY_LOGS.length}</Badge>
            </div>
            {FACTORY_LOGS.map((log) => (
              <FactoryLogCard
                key={log.id}
                log={log}
                selected={selectedLogId === log.id}
                onOpen={() => openLog(log)}
              />
            ))}
          </div>
        </ScrollArea>

        <button
          type="button"
          className="group absolute inset-y-0 z-[5] hidden w-6 -translate-x-1/2 touch-none !cursor-ew-resize place-items-stretch justify-center border-0 bg-transparent px-[11px] py-0 max-[860px]:hidden min-[861px]:grid [&_*]:!cursor-ew-resize"
          style={{ left: `${splitPercent}%` }}
          aria-label="Изменить ширину панелей"
          aria-valuemin={ACTIONS_SPLIT_MIN_PERCENT}
          aria-valuemax={100 - ACTIONS_SPLIT_MIN_PERCENT}
          aria-valuenow={Math.round(splitPercent)}
          role="slider"
          onPointerDown={onSplitPointerDown}
          onPointerMove={onSplitPointerMove}
          onPointerUp={onSplitPointerEnd}
          onPointerCancel={onSplitPointerEnd}
          onKeyDown={onSplitKeyDown}
        >
          <span className="block h-full w-px bg-border transition-colors group-hover:bg-primary" aria-hidden="true" />
        </button>

        <FactoryDetailPanel log={selectedLog} />
      </div>

      {mobileLog ? <FactoryMobileDetail log={mobileLog} onClose={() => setMobileLogId(null)} /> : null}
    </section>
  );
}

function FactoryLogCard({ log, selected, onOpen }: { log: FactoryLog; selected: boolean; onOpen: () => void }) {
  const output = log.json_data.outputs[0]?.value ?? "Нет output";
  const StatusIcon = log.status === "done" ? CheckCircle2 : XCircle;

  return (
    <Card
      render={<button type="button" onClick={onOpen} />}
      className={cx(
        "grid w-full min-w-0 gap-3 p-4 text-left transition-colors hover:bg-accent/40 focus-visible:outline-0 focus-visible:ring-2 focus-visible:ring-ring",
        selected && "border-primary bg-accent/35",
      )}
    >
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="m-0 truncate text-sm font-semibold">{log.ai_title}</p>
          <p className="m-0 mt-1 truncate text-xs text-muted-foreground">{log.agent_id}</p>
        </div>
        <Badge variant={log.status === "done" ? "secondary" : "destructive"} size="sm">
          <StatusIcon aria-hidden="true" />
          {log.status}
        </Badge>
      </div>
      <p className="m-0 line-clamp-2 text-sm text-muted-foreground">{output}</p>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <Clock3 className="size-3.5" aria-hidden="true" />
          {formatFactoryTime(log.dt)}
        </span>
        <span className="inline-flex items-center gap-1">
          <Bot className="size-3.5" aria-hidden="true" />v{log.agent_version}
        </span>
        {log.flow_command ? (
          <span className="inline-flex items-center gap-1">
            <Terminal className="size-3.5" aria-hidden="true" />
            {log.flow_command}
          </span>
        ) : null}
      </div>
    </Card>
  );
}

function FactoryDetailPanel({ log }: { log: FactoryLog | null }) {
  return (
    <aside className="grid h-full min-h-0 min-w-0 grid-rows-[minmax(0,1fr)] overflow-hidden pl-7 max-[860px]:hidden" aria-label="Подробности AI log" data-nav-swipe-exclusion>
      <ScrollArea className="min-h-0">
        {log ? <FactoryLogDetails log={log} /> : <FactoryEmptyPanel />}
      </ScrollArea>
    </aside>
  );
}

function FactoryEmptyPanel() {
  return (
    <Card className="min-h-40 p-5">
      <p className="m-0 text-sm font-normal text-muted-foreground">Выберите запись из AI_logs/, чтобы открыть производственные подробности.</p>
    </Card>
  );
}

function FactoryMobileDetail({ log, onClose }: { log: FactoryLog; onClose: () => void }) {
  const suppressPopRef = useRef(false);
  const mobileSheetTop = useMobileSheetTop();
  const { sheetDragHandlers, sheetRef, sheetStyle } = useMobileSheetDrag({ onClose });

  useEffect(() => {
    if (window.history.state?.braiFactoryLog) {
      window.history.replaceState({ ...window.history.state, braiFactoryLog: log.id }, "", window.location.href);
    } else {
      window.history.pushState({ ...window.history.state, braiFactoryLog: log.id }, "", window.location.href);
    }

    function onPopState() {
      if (suppressPopRef.current) {
        suppressPopRef.current = false;
        return;
      }
      onClose();
    }

    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [log.id, onClose]);

  useEffect(() => installAndroidBackHandler(() => {
    if (window.history.state?.braiFactoryLog === log.id) {
      suppressPopRef.current = true;
      window.history.back();
    }
    onClose();
    return true;
  }), [log.id, onClose]);

  function close() {
    if (window.history.state?.braiFactoryLog === log.id) {
      suppressPopRef.current = true;
      window.history.back();
    }
    onClose();
  }

  return (
    <div className="fixed inset-x-0 bottom-0 z-[80] hidden bg-foreground/25 max-[860px]:block dark:bg-background/80" style={{ top: mobileSheetTop } as CSSProperties} data-nav-swipe-exclusion>
      <aside
        ref={sheetRef}
        className="absolute inset-x-0 bottom-0 grid max-h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-t-2xl border-t border-border bg-card pb-[env(safe-area-inset-bottom)] pt-2 shadow-xl animate-[mobile-detail-sheet-in_180ms_ease-out] will-change-transform"
        style={sheetStyle}
        aria-label="Подробности AI log"
        {...sheetDragHandlers}
      >
        <div className="relative min-h-12 border-b border-border px-5">
          <div className="absolute left-1/2 top-0 flex h-6 w-32 -translate-x-1/2 touch-none cursor-grab items-start justify-center pt-1.5 active:cursor-grabbing">
            <span className="h-1.5 w-12 rounded-full bg-muted-foreground/30" aria-hidden="true" />
          </div>
          <Button type="button" variant="ghost" size="icon-sm" className="absolute right-4 top-2.5" aria-label="Закрыть подробности" onClick={close}>
            <X aria-hidden="true" />
          </Button>
        </div>
        <ScrollArea className="min-h-0" contentInset="balanced">
          <FactoryLogDetails log={log} mobile />
        </ScrollArea>
      </aside>
    </div>
  );
}

function FactoryLogDetails({ log, mobile = false }: { log: FactoryLog; mobile?: boolean }) {
  const StatusIcon = log.status === "done" ? CheckCircle2 : XCircle;

  return (
    <div className={cx("grid gap-4", mobile ? "py-4" : "pb-4")}>
      <div className="grid gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={log.status === "done" ? "secondary" : "destructive"}>
            <StatusIcon aria-hidden="true" />
            {log.status}
          </Badge>
          <Badge variant="outline">{formatFactoryTime(log.dt)}</Badge>
        </div>
        <h2 className="m-0 text-lg font-semibold leading-tight">{log.ai_title}</h2>
        <p className="m-0 text-sm text-muted-foreground">{log.agent_id} · v{log.agent_version}</p>
      </div>

      <DetailGrid
        items={[
          ["flow_id", log.flow_id ?? "—"],
          ["flow_command", log.flow_command ?? "—"],
          ["model", log.json_data.usage?.model ?? "—"],
          ["duration", `${log.json_data.timings_ms?.total ?? 0} ms`],
        ]}
      />

      {log.flow_id ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <GitBranch className="size-4" aria-hidden="true" />
          <span className="truncate">{log.flow_id}</span>
        </div>
      ) : null}

      <FactoryIoBlock title="Inputs" rows={log.json_data.inputs} />
      <FactoryIoBlock title="Outputs" rows={log.json_data.outputs} />

      <section className="grid gap-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <FileJson className="size-4" aria-hidden="true" />
          json_data
        </div>
        <pre className="max-h-72 overflow-auto rounded-md border border-border bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground">{JSON.stringify(log.json_data, null, 2)}</pre>
      </section>
    </div>
  );
}

function DetailGrid({ items }: { items: Array<[string, string]> }) {
  return (
    <dl className="grid grid-cols-2 gap-2">
      {items.map(([label, value]) => (
        <div key={label} className="min-w-0 rounded-md border border-border bg-muted/30 p-3">
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd className="m-0 mt-1 truncate text-sm font-medium">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function FactoryIoBlock({ title, rows }: { title: string; rows: Array<{ ref: string; value: string }> }) {
  return (
    <section className="grid gap-2">
      <h3 className="m-0 text-sm font-medium">{title}</h3>
      <div className="grid gap-2">
        {rows.map((row) => (
          <div key={row.ref} className="grid gap-1 rounded-md border border-border bg-background p-3">
            <span className="text-xs font-medium text-muted-foreground">{row.ref}</span>
            <p className="m-0 text-sm">{row.value}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function formatFactoryTime(value: string) {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
