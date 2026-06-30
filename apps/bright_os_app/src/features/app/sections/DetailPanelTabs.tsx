"use client";

import type { ReactNode } from "react";
import { useState } from "react";
import { ChevronDown, Download, File, X } from "lucide-react";
import { defaultApiBase } from "@/shared/config/runtime";
import type { ActivityItem } from "@/shared/types/activities";
import type { InboxItem } from "@/shared/types/inbox";
import { Button } from "@/shared/ui/button";
import { cn } from "@/shared/ui/cn";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/shared/ui/collapsible";
import { ScrollArea } from "@/shared/ui/scroll-area";
import rawFieldReference from "./detailFieldReference.json";

export type DetailPanelKind = "actions" | "inbox";
export type DetailPanelTab = "info" | "links" | "ai" | "history" | "details" | "db";

const DETAIL_PANEL_TABS: Array<{ id: DetailPanelTab; label: string }> = [
  { id: "info", label: "Инфо" },
  { id: "links", label: "Связи" },
  { id: "ai", label: "AI" },
  { id: "history", label: "История" },
  { id: "details", label: "Детали" },
  { id: "db", label: "БД" },
];

type DetailItem = ActivityItem | InboxItem;
type FieldReference = {
  name: string;
  sourceKey?: string;
  meaning: string;
  filledBy: string;
};
type RecordTypeReference = { id: number; meaning: string };
type DetailReference = Record<
  DetailPanelKind,
  {
    fields: FieldReference[];
    recordTypes: RecordTypeReference[];
  }
>;
type DetailValueRow = { name: string; value: unknown };

const fieldReference = rawFieldReference as DetailReference;

export function DetailPanelTabBar({
  activeTab,
  className,
  onChange,
}: {
  activeTab: DetailPanelTab;
  className?: string;
  onChange: (tab: DetailPanelTab) => void;
}) {
  return (
    <div
      className={cn("actions-detail-tabs -mt-2 flex min-w-0 gap-1 overflow-x-auto border-b border-border [scrollbar-width:none] [&::-webkit-scrollbar]:hidden", className)}
      role="tablist"
      aria-label="Вкладки панели деталей"
    >
      {DETAIL_PANEL_TABS.map((tab) => (
        <button
          key={tab.id}
          type="button"
          className={cn(
            "-mb-px h-8 shrink-0 border-b-2 border-transparent px-2.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-0 focus-visible:ring-2 focus-visible:ring-ring",
            activeTab === tab.id && "border-primary text-foreground",
          )}
          role="tab"
          aria-selected={activeTab === tab.id}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export function DetailEmptyTab() {
  return <div className="min-h-0" role="tabpanel" />;
}

export function DetailAttachments({ links }: { links: string[] }) {
  const [previewLink, setPreviewLink] = useState<string | null>(null);
  const files = links.filter(Boolean);
  if (files.length === 0) return null;

  return (
    <section className="mb-4 grid gap-2" aria-label="Прикрепленные файлы">
      <h3 className="m-0 text-xs font-medium uppercase tracking-normal text-muted-foreground">Прикрепленные файлы</h3>
      <div className="grid gap-2">
        {files.map((link) => {
          const href = attachmentHref(link);
          const name = attachmentName(link);
          if (isImageAttachment(link)) {
            return (
              <button
                key={link}
                type="button"
                className="group grid min-w-0 overflow-hidden rounded-md border border-border bg-secondary/30 text-left transition-colors hover:border-primary focus-visible:outline-0 focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={`Открыть вложение ${name}`}
                onClick={() => setPreviewLink(link)}
              >
                {/* Private attachment dimensions are unknown, so native img is the least surprising renderer. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={href} alt={name} loading="lazy" className="max-h-48 w-full object-contain bg-background" />
                <span className="truncate px-2.5 py-2 text-sm text-muted-foreground group-hover:text-foreground">{name}</span>
              </button>
            );
          }

          return (
            <a
              key={link}
              className="flex min-h-10 min-w-0 items-center gap-2 rounded-md border border-border px-2.5 text-sm text-foreground transition-colors hover:border-primary focus-visible:outline-0 focus-visible:ring-2 focus-visible:ring-ring"
              href={href}
              download={name}
            >
              <File className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">{name}</span>
              <Download className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            </a>
          );
        })}
      </div>
      {previewLink ? (
        <div
          className="fixed inset-0 z-[120] grid place-items-center bg-background/95 p-4"
          role="dialog"
          aria-modal="true"
          aria-label={attachmentName(previewLink)}
          onClick={() => setPreviewLink(null)}
        >
          <Button
            type="button"
            variant="secondary"
            size="icon"
            className="absolute right-4 top-4"
            aria-label="Закрыть вложение"
            title="Закрыть"
            onClick={(event) => {
              event.stopPropagation();
              setPreviewLink(null);
            }}
          >
            <X aria-hidden="true" />
          </Button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={attachmentHref(previewLink)}
            alt={attachmentName(previewLink)}
            className="max-h-full max-w-full object-contain"
            onClick={(event) => event.stopPropagation()}
          />
        </div>
      ) : null}
    </section>
  );
}

export function DetailFields({ kind, item }: { kind: DetailPanelKind; item: DetailItem }) {
  const rows = fieldReference[kind].fields.flatMap((field) => {
    const key = field.sourceKey ?? field.name;
    if (!Object.prototype.hasOwnProperty.call(item, key)) return [];
    return [{ name: field.name, value: itemValue(item, key) }];
  });
  const filledRows = rows.filter((row) => !isEmptyDetailValue(row.value));
  const emptyRows = rows.filter((row) => isEmptyDetailValue(row.value));

  return (
    <ScrollArea className="min-h-0 w-full min-w-0" role="tabpanel">
      <div className="grid gap-3 pb-6 pt-1">
        <DetailRows rows={filledRows} emptyText="Заполненных полей нет" />
        {emptyRows.length > 0 ? (
          <Collapsible>
            <CollapsibleTrigger asChild>
              <button
                type="button"
                className="flex min-h-9 items-center gap-2 border-0 bg-transparent p-0 text-sm font-medium text-muted-foreground data-[state=open]:[&_svg]:rotate-180"
              >
                <ChevronDown className="size-4 transition-transform" aria-hidden="true" />
                <span>Пустые поля</span>
                <span>{emptyRows.length}</span>
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <DetailRows rows={emptyRows} emptyValue />
            </CollapsibleContent>
          </Collapsible>
        ) : null}
      </div>
    </ScrollArea>
  );
}

export function DetailHistory({ kind, item }: { kind: DetailPanelKind; item: DetailItem }) {
  const rows: DetailValueRow[] =
    kind === "actions"
      ? [
          { name: "Создано", value: itemValue(item, "created_at_utc") },
          { name: "Обновлено", value: itemValue(item, "updated_at_utc") },
          { name: "Завершено", value: itemValue(item, "completed_at_utc") },
          { name: "Удалено", value: itemValue(item, "deleted_at_utc") },
          { name: "Восстановлено", value: itemValue(item, "restored_at_utc") },
        ]
      : [
          { name: "Создано", value: itemValue(item, "created_at_utc") },
          { name: "Обновлено", value: itemValue(item, "updated_at_utc") },
          { name: "Удалено", value: itemValue(item, "deleted_at_utc") },
        ];

  return (
    <ScrollArea className="min-h-0 w-full min-w-0" role="tabpanel">
      <div className="pb-6 pt-1">
        <DetailRows rows={rows.filter((row) => !isEmptyDetailValue(row.value))} emptyText="История пуста" />
      </div>
    </ScrollArea>
  );
}

export function DetailDbReference({ kind }: { kind: DetailPanelKind }) {
  const reference = fieldReference[kind];

  return (
    <ScrollArea className="min-h-0 w-full min-w-0" role="tabpanel">
      <div className="grid gap-5 pb-6 pt-1">
        <div className="grid gap-0">
          {reference.fields.map((field) => (
            <div
              key={field.name}
              className="grid gap-1 border-b border-border py-2 text-sm min-[720px]:grid-cols-[minmax(0,10rem)_minmax(0,1fr)_minmax(0,12rem)] min-[720px]:gap-3"
            >
              <code className="min-w-0 self-start break-words rounded bg-secondary px-1.5 py-0.5 text-xs text-foreground">{field.name}</code>
              <span className="min-w-0 text-foreground">{field.meaning}</span>
              <span className="min-w-0 text-muted-foreground">{field.filledBy}</span>
            </div>
          ))}
        </div>
        {reference.recordTypes.length > 0 ? (
          <div className="grid gap-0" aria-label="Типы record_type_id">
            {reference.recordTypes.map((type) => (
              <div key={type.id} className="grid grid-cols-[4rem_minmax(0,1fr)] gap-3 border-b border-border py-2 text-sm">
                <code className="self-start rounded bg-secondary px-1.5 py-0.5 text-xs text-foreground">{type.id}</code>
                <span>{type.meaning}</span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </ScrollArea>
  );
}

function DetailRows({
  rows,
  emptyText,
  emptyValue = false,
}: {
  rows: DetailValueRow[];
  emptyText?: string;
  emptyValue?: boolean;
}) {
  if (rows.length === 0) {
    return emptyText ? <p className="m-0 text-sm text-muted-foreground">{emptyText}</p> : null;
  }

  return (
    <dl className="grid gap-0">
      {rows.map((row) => (
        <div
          key={row.name}
          className="grid gap-1 border-b border-border py-2 text-sm min-[640px]:grid-cols-[minmax(0,12rem)_minmax(0,1fr)] min-[640px]:gap-3"
        >
          <dt className="min-w-0">
            <code className="break-words rounded bg-secondary px-1.5 py-0.5 text-xs text-foreground">{row.name}</code>
          </dt>
          <dd className="m-0 min-w-0 whitespace-pre-wrap break-words text-foreground">
            {emptyValue ? "Пусто" : formatDetailValue(row.value)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function formatDetailValue(value: unknown): ReactNode {
  if (typeof value === "boolean") return value ? "Да" : "Нет";
  if (Array.isArray(value)) return JSON.stringify(value, null, 2);
  if (value && typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

function isEmptyDetailValue(value: unknown): boolean {
  if (value == null) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function itemValue(item: DetailItem, key: string): unknown {
  return (item as unknown as Record<string, unknown>)[key];
}

function attachmentHref(link: string): string {
  if (/^https?:\/\//i.test(link)) return link;
  const path = link.startsWith("/") ? link : `/${link}`;
  const base = defaultApiBase().replace(/\/$/, "");
  return base ? `${base}${path}` : path;
}

function attachmentName(link: string): string {
  const clean = link.split("?")[0] ?? link;
  const name = clean.split("/").filter(Boolean).at(-1);
  if (!name) return "file";
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

function isImageAttachment(link: string): boolean {
  return /\.(gif|jpe?g|png|webp)(?:$|\?)/i.test(link);
}
