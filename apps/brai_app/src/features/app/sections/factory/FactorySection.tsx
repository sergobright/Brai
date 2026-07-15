"use client";

import { useEffect, useState } from "react";
import { Bot, CheckCircle2, Clock3, Database, FileJson, GitBranch, Terminal, XCircle } from "lucide-react";
import { BraiApi, type AiLog } from "@/shared/api/braiApi";
import { defaultApiBase } from "@/shared/config/runtime";
import { Badge } from "@/shared/ui/badge";
import { Card } from "@/shared/ui/card";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { MobileContextSheet } from "../../chrome/AppChrome";
import { PageWorkspace } from "../../chrome/PageWorkspace";
import { cx } from "../../appUtils";
import { isMobileNavigationViewport } from "../../navigation/useSectionSwipeNavigation";
import { DetailPanelTabBar } from "../DetailPanelTabs";

type FactoryDetailTab = "info" | "db" | "logs";
const FACTORY_DETAIL_TABS: Array<{ id: FactoryDetailTab; label: string }> = [
  { id: "info", label: "Инфо" },
  { id: "db", label: "БД" },
  { id: "logs", label: "Логи" },
];

export function FactorySection({ onMobileOverlayChange }: { onMobileOverlayChange: (open: boolean) => void }) {
  const [logs, setLogs] = useState<AiLog[]>([]);
  const [selectedLogId, setSelectedLogId] = useState<number | null>(null);
  const [mobileLogId, setMobileLogId] = useState<number | null>(null);
  const [detailTab, setDetailTab] = useState<FactoryDetailTab>("info");
  const selectedLog = logs.find((log) => log.id === selectedLogId) ?? null;
  const mobileLog = logs.find((log) => log.id === mobileLogId) ?? null;

  useEffect(() => {
    let mounted = true;
    new BraiApi(defaultApiBase())
      .aiLogs()
      .then(({ logs: nextLogs }) => {
        if (!mounted) return;
        setLogs(nextLogs);
        setSelectedLogId((current) => (current != null && nextLogs.some((log) => log.id === current) ? current : null));
      })
      .catch(() => {
        if (!mounted) return;
        setLogs([]);
      });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    onMobileOverlayChange(mobileLog != null);
    return () => onMobileOverlayChange(false);
  }, [mobileLog, onMobileOverlayChange]);

  function openLog(log: AiLog) {
    setSelectedLogId(log.id);
    if (isMobileNavigationViewport()) setMobileLogId(log.id);
  }

  return (
    <section className="relative grid h-full min-h-0 grid-rows-[minmax(0,1fr)] gap-3.5 max-[860px]:gap-0" aria-label="Factory">
      <PageWorkspace
        className="relative"
        mainScroll={false}
        panelScroll={false}
        main={<ScrollArea className="h-full min-h-0 min-w-0 max-[860px]:-mx-3.5 max-[860px]:[&>[data-slot=scroll-area-scrollbar]]:!right-0" contentInset="none">
          <div className="grid gap-3 pr-[18px] max-[860px]:px-3.5" aria-label="Поток AI_logs">
            <div className="sticky top-0 z-[2] flex items-center justify-between gap-3 bg-background/95 pb-3 backdrop-blur max-[860px]:hidden">
              <div className="min-w-0">
                <p className="m-0 text-sm font-medium">AI_logs/</p>
                <p className="m-0 text-xs text-muted-foreground">Последние производственные срабатывания</p>
              </div>
              <Badge variant="outline">{logs.length}</Badge>
            </div>
            {logs.map((log) => (
              <FactoryLogCard
                key={log.id}
                log={log}
                selected={selectedLogId === log.id}
                onOpen={() => openLog(log)}
              />
            ))}
          </div>
        </ScrollArea>}
        temporaryPanel={selectedLog ? <FactoryDetailPanel activeTab={detailTab} log={selectedLog} onTabChange={setDetailTab} /> : undefined}
      />

      {mobileLog ? <FactoryMobileDetail activeTab={detailTab} log={mobileLog} onClose={() => setMobileLogId(null)} onTabChange={setDetailTab} /> : null}
    </section>
  );
}

function FactoryLogCard({ log, selected, onOpen }: { log: AiLog; selected: boolean; onOpen: () => void }) {
  const output = ioRows(log.json_data.outputs)[0]?.value;
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
      {output == null ? null : <p className="m-0 line-clamp-2 text-sm text-muted-foreground">{formatLogValue(output)}</p>}
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

function FactoryDetailPanel({ activeTab, log, onTabChange }: { activeTab: FactoryDetailTab; log: AiLog; onTabChange: (tab: FactoryDetailTab) => void }) {
  return (
    <div className="grid h-full min-h-0 min-w-0 grid-rows-[minmax(0,1fr)] overflow-hidden pl-7" aria-label="Подробности AI log">
      <FactoryLogDetails activeTab={activeTab} log={log} onTabChange={onTabChange} />
    </div>
  );
}

function FactoryMobileDetail({ activeTab, log, onClose, onTabChange }: { activeTab: FactoryDetailTab; log: AiLog; onClose: () => void; onTabChange: (tab: FactoryDetailTab) => void }) {
  return (
    <MobileContextSheet label="Подробности AI log" onClose={onClose} scroll={false} variant="detail">
      <FactoryLogDetails activeTab={activeTab} log={log} mobile onTabChange={onTabChange} />
    </MobileContextSheet>
  );
}

function FactoryLogDetails({ activeTab, log, mobile = false, onTabChange }: { activeTab: FactoryDetailTab; log: AiLog; mobile?: boolean; onTabChange: (tab: FactoryDetailTab) => void }) {
  const content =
    activeTab === "db" ? <FactoryDbDetails log={log} /> : activeTab === "logs" ? <FactoryRawLogs log={log} /> : <FactoryInfoDetails log={log} />;

  return (
    <div className={cx("grid h-full min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)]", mobile && "px-[18px]")}>
      <DetailPanelTabBar activeTab={activeTab} className="mt-0" onChange={onTabChange} tabs={FACTORY_DETAIL_TABS} />
      <ScrollArea className="min-h-0 w-full min-w-0" contentInset="none">
        <div className="grid gap-4 py-4">{content}</div>
      </ScrollArea>
    </div>
  );
}

function FactoryInfoDetails({ log }: { log: AiLog }) {
  const StatusIcon = log.status === "done" ? CheckCircle2 : XCircle;
  const duration = formatDuration(log.json_data.timings_ms?.total);

  return (
    <>
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
        items={presentRows([
          ["flow_id", log.flow_id],
          ["flow_command", log.flow_command],
          ["model", log.json_data.usage?.model],
          ["duration", duration],
        ])}
      />

      {log.flow_id ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <GitBranch className="size-4" aria-hidden="true" />
          <span className="truncate">{log.flow_id}</span>
        </div>
      ) : null}

      <FactoryIoBlock title="Inputs" rows={ioRows(log.json_data.inputs)} />
      <FactoryIoBlock title="Outputs" rows={ioRows(log.json_data.outputs)} />
    </>
  );
}

function FactoryDbDetails({ log }: { log: AiLog }) {
  return (
    <section className="grid gap-2">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Database className="size-4" aria-hidden="true" />
        AI_logs
      </div>
      <DetailRows
        rows={presentRows([
          ["id", String(log.id)],
          ["agent_id", log.agent_id],
          ["agent_version", log.agent_version],
          ["dt", formatFactoryTime(log.dt)],
          ["status", log.status],
          ["flow_id", log.flow_id],
          ["flow_command", log.flow_command],
        ])}
      />
    </section>
  );
}

function FactoryRawLogs({ log }: { log: AiLog }) {
  return (
    <section className="grid gap-2">
      <div className="flex items-center gap-2 text-sm font-medium">
        <FileJson className="size-4" aria-hidden="true" />
        json_data
      </div>
      <pre className="max-h-[60vh] overflow-auto rounded-md border border-border bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground">{JSON.stringify(log.json_data, null, 2)}</pre>
    </section>
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

function FactoryIoBlock({ title, rows }: { title: string; rows: Array<{ ref: string; value: unknown }> }) {
  if (rows.length === 0) return null;
  return (
    <section className="grid gap-2">
      <h3 className="m-0 text-sm font-medium">{title}</h3>
      <div className="grid gap-2">
        {rows.map((row) => (
          <div key={row.ref} className="grid gap-1 rounded-md border border-border bg-background p-3">
            <span className="text-xs font-medium text-muted-foreground">{row.ref}</span>
            <p className="m-0 whitespace-pre-wrap break-words text-sm">{formatLogValue(row.value)}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function DetailRows({ rows }: { rows: Array<[string, string]> }) {
  return (
    <dl className="grid gap-0">
      {rows.map(([label, value]) => (
        <div key={label} className="grid gap-1 border-b border-border py-2 text-sm min-[640px]:grid-cols-[minmax(0,12rem)_minmax(0,1fr)] min-[640px]:gap-3">
          <dt className="min-w-0">
            <code className="break-words rounded bg-secondary px-1.5 py-0.5 text-xs text-foreground">{label}</code>
          </dt>
          <dd className="m-0 min-w-0 whitespace-pre-wrap break-words text-foreground">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function presentRows(rows: Array<[string, string | null | undefined]>): Array<[string, string]> {
  return rows.filter((row): row is [string, string] => typeof row[1] === "string" && row[1].length > 0);
}

function ioRows(value: unknown): Array<{ ref: string; value: unknown }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const record = row as { ref?: unknown; value?: unknown };
    return typeof record.ref === "string" ? [{ ref: record.ref, value: record.value }] : [];
  });
}

function formatLogValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatDuration(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? `${value} ms` : null;
}

function formatFactoryTime(value: string) {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
