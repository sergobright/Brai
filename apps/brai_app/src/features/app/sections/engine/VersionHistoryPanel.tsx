"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { CheckCircle2, LoaderCircle, RotateCcw, Timer, TriangleAlert, X } from "lucide-react";
import { BraiApi, type VersionHistoryItem, type VersionHistoryPullRequest, type VersionHistoryType } from "@/shared/api/braiApi";
import { defaultApiBase } from "@/shared/config/runtime";
import { moscowDateTime } from "@/shared/time/format";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/shared/ui/alert";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { MarkdownContent } from "@/shared/ui/markdown-content";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { Separator } from "@/shared/ui/separator";
import { MobileContextSheet } from "../../chrome/AppChrome";
import { useVersionHistory, type VersionHistoryApi } from "./useVersionHistory";

type InstalledVersions = Partial<Record<string, number | null>>;
type VersionHistoryPanelProps = {
  api?: VersionHistoryApi;
  currentCommit?: string;
  installedApkVersion?: number | null;
} & (
  | { mobile: true; onClose: () => void }
  | { mobile?: false; onClose?: never }
);

export function VersionHistoryPanel(props: VersionHistoryPanelProps) {
  const defaultApi = useMemo(() => new BraiApi(defaultApiBase()), []);
  const history = useVersionHistory(props.api ?? defaultApi);
  const [selectedItem, setSelectedItem] = useState<VersionHistoryItem | null>(null);
  const cardIdPrefix = useId();
  const listScrollTopRef = useRef(0);
  const installedVersions = useMemo<InstalledVersions>(() => ({
    apk: props.installedApkVersion,
    build: currentBuildVersion(history.items, props.currentCommit),
  }), [history.items, props.currentCommit, props.installedApkVersion]);
  const list = (
    <VersionHistoryList
      cardIdPrefix={cardIdPrefix}
      history={history}
      installedVersions={installedVersions}
      onSelect={(item, opener) => {
        listScrollTopRef.current = opener.closest<HTMLElement>("[data-slot='scroll-area-viewport']")?.scrollTop ?? 0;
        setSelectedItem(item);
      }}
    />
  );

  function closeDetails() {
    const selectedId = selectedItem?.id;
    setSelectedItem(null);
    if (selectedId == null) return;
    window.requestAnimationFrame(() => {
      const opener = document.getElementById(`${cardIdPrefix}-card-${selectedId}`);
      const viewport = opener?.closest<HTMLElement>("[data-slot='scroll-area-viewport']");
      if (!props.mobile && viewport) viewport.scrollTop = listScrollTopRef.current;
      opener?.focus({ preventScroll: true });
    });
  }

  if (props.mobile) {
    return (
      <>
        <MobileContextSheet inactive={selectedItem != null} label="История версий" onClose={props.onClose}>
          {list}
        </MobileContextSheet>
        {selectedItem ? (
          <MobileContextSheet
            label={`Версия ${selectedItem.version}`}
            className="version-history-detail-backdrop"
            floatingClose={false}
            onClose={closeDetails}
            scroll={false}
            variant="detail"
          >
            <VersionHistoryDetails
              installed={isInstalled(selectedItem, installedVersions)}
              item={selectedItem}
              mobile
              typeTitle={versionTypeTitle(selectedItem, history.types)}
            />
          </MobileContextSheet>
        ) : null}
      </>
    );
  }

  return selectedItem ? (
    <VersionHistoryDetails
      installed={isInstalled(selectedItem, installedVersions)}
      item={selectedItem}
      onClose={closeDetails}
      typeTitle={versionTypeTitle(selectedItem, history.types)}
    />
  ) : list;
}

function VersionHistoryList({
  cardIdPrefix,
  history,
  installedVersions,
  onSelect,
}: {
  cardIdPrefix: string;
  history: ReturnType<typeof useVersionHistory>;
  installedVersions: InstalledVersions;
  onSelect: (item: VersionHistoryItem, opener: HTMLButtonElement) => void;
}) {
  const headingId = useId();
  const initialLoading = history.status === "loading" && history.items.length === 0;

  return (
    <section className="grid min-w-0 gap-3 pb-7 pl-7 pr-[18px] max-[860px]:px-[18px]" aria-labelledby={headingId}>
      <h2 id={headingId} className="m-0 text-xl font-semibold leading-tight max-[860px]:sr-only">История версий</h2>

      <div className="flex flex-wrap gap-2" role="group" aria-label="Фильтр истории по типу версии">
        <FilterButton active={history.filter == null} label="Все" onClick={() => history.selectFilter(null)} />
        {history.types.map((type) => (
          <FilterButton key={type.id} active={history.filter === type.id} label={type.title} onClick={() => history.selectFilter(type.id)} />
        ))}
      </div>

      {initialLoading ? (
        <p className="m-0 inline-flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" />
          Загружаем историю…
        </p>
      ) : null}

      {history.items.length ? (
        <ol className="m-0 grid list-none gap-2 p-0" aria-label="Версии">
          {history.items.map((item) => (
            <VersionHistoryCard
              cardId={`${cardIdPrefix}-card-${item.id}`}
              installed={isInstalled(item, installedVersions)}
              item={item}
              key={item.id}
              onOpen={(opener) => onSelect(item, opener)}
            />
          ))}
        </ol>
      ) : null}

      {history.status === "ready" && history.items.length === 0 ? (
        <p className="m-0 text-sm text-muted-foreground" role="status">Для выбранного типа версий пока нет.</p>
      ) : null}

      {history.status === "error" ? (
        <Alert variant="destructive">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>История не загрузилась</AlertTitle>
          <AlertDescription>Проверьте соединение и попробуйте ещё раз.</AlertDescription>
          <AlertAction>
            <Button type="button" variant="outline" size="sm" onClick={() => void history.retry()}>
              <RotateCcw aria-hidden="true" />
              Повторить
            </Button>
          </AlertAction>
        </Alert>
      ) : null}

      {history.hasMore && history.status !== "error" ? (
        <Button type="button" variant="outline" size="sm" disabled={history.status === "loading-more"} onClick={() => void history.loadMore()}>
          {history.status === "loading-more" ? <LoaderCircle className="motion-safe:animate-spin" aria-hidden="true" /> : null}
          {history.status === "loading-more" ? "Загружаем…" : "Показать более ранние"}
        </Button>
      ) : null}
    </section>
  );
}

function FilterButton({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <Button type="button" variant={active ? "secondary" : "outline"} size="sm" className="max-[860px]:h-11" aria-pressed={active} onClick={onClick}>
      {label}
    </Button>
  );
}

function VersionHistoryCard({ cardId, item, installed, onOpen }: { cardId: string; item: VersionHistoryItem; installed: boolean; onOpen: (opener: HTMLButtonElement) => void }) {
  const StatusIcon = installed ? CheckCircle2 : Timer;
  const statusLabel = installed ? "Установлена" : "Новая версия";

  return (
    <li>
      <Card
        render={<button id={cardId} type="button" aria-label={`${statusLabel} ${item.version}: ${item.short_changes}`} onClick={(event) => onOpen(event.currentTarget)} />}
        className="grid min-h-16 w-full min-w-0 gap-2 p-3 text-left transition-colors hover:bg-accent/45 active:bg-accent/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-2">
          <StatusIcon className={installed ? "mt-0.5 size-4 text-primary" : "mt-0.5 size-4 text-foreground"} aria-hidden="true" />
          <span className="line-clamp-2 text-sm font-semibold leading-5">{item.short_changes}</span>
        </span>
        <span className="flex min-w-0 items-center gap-2 pl-6">
          <Badge variant="secondary" size="sm">Версия {item.version}</Badge>
          <time className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground" dateTime={item.released_at_utc}>
            {moscowDateTime(item.released_at_utc)} МСК
          </time>
        </span>
      </Card>
    </li>
  );
}

function VersionHistoryDetails({
  installed,
  item,
  mobile = false,
  onClose,
  typeTitle,
}: {
  installed: boolean;
  item: VersionHistoryItem;
  mobile?: boolean;
  onClose?: () => void;
  typeTitle: string;
}) {
  const StatusIcon = installed ? CheckCircle2 : Timer;
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const heading = headingRef.current;
    const viewport = heading?.closest<HTMLElement>("[data-slot='scroll-area-viewport']");
    if (viewport) viewport.scrollTop = 0;
    heading?.focus({ preventScroll: true });
  }, [item.id]);

  const content = (
    <article className={`grid min-w-0 gap-5 pb-7 ${mobile ? "px-[18px] pt-4" : "pl-7 pr-[18px]"}`} aria-labelledby={`version-history-details-${item.id}`}>
      <header className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
        <div className="grid min-w-0 gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 text-sm font-medium">
              <StatusIcon className={installed ? "size-4 text-primary" : "size-4 text-foreground"} aria-hidden="true" />
              {installed ? "Установлена" : "Доступна"}
            </span>
            <Badge variant="secondary">Версия {item.version}</Badge>
            <Badge variant="outline">{typeTitle}</Badge>
          </div>
          <h2 ref={headingRef} id={`version-history-details-${item.id}`} className="m-0 text-xl font-semibold leading-tight" tabIndex={-1}>{item.short_changes}</h2>
          <time className="text-xs tabular-nums text-muted-foreground" dateTime={item.released_at_utc}>
            {moscowDateTime(item.released_at_utc)} МСК
          </time>
        </div>
        {!mobile && onClose ? (
          <Button type="button" variant="ghost" size="icon" className="size-11" aria-label="Закрыть подробности версии" title="Закрыть" onClick={onClose}>
            <X aria-hidden="true" />
          </Button>
        ) : null}
      </header>

      <p className="m-0 text-sm leading-6 text-muted-foreground">{item.detailed_changes}</p>

      {item.details.length ? (
        <section className="grid gap-3" aria-labelledby={`version-history-changes-${item.id}`}>
          <h3 id={`version-history-changes-${item.id}`} className="m-0 text-sm font-semibold">Что изменилось</h3>
          <ol className="m-0 grid list-none gap-3 p-0">
            {item.details.map((detail) => (
              <li className="grid grid-cols-[auto_minmax(0,1fr)] gap-2" key={detail.id}>
                <CheckCircle2 className="mt-0.5 size-4 text-primary" aria-hidden="true" />
                <div className="grid gap-1 text-sm">
                  <p className="m-0 font-medium">{detail.title}</p>
                  <p className="m-0 leading-6 text-muted-foreground">{detail.description}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      <Separator />
      <section className="grid gap-2" aria-labelledby={`version-history-reason-${item.id}`}>
        <h3 id={`version-history-reason-${item.id}`} className="m-0 text-sm font-semibold">Зачем выпущено обновление</h3>
        <p className="m-0 text-sm leading-6 text-muted-foreground">{item.reason}</p>
      </section>

      <Separator />
      <PullRequests pulls={item.pull_requests} />

      <Separator />
      <section className="grid gap-3" aria-labelledby={`version-history-technical-${item.id}`}>
        <h3 id={`version-history-technical-${item.id}`} className="m-0 text-sm font-semibold">Технические данные</h3>
        <Definition label="Work ID" value={item.work?.key ?? "Нет: историческая запись без подтверждённой работы"} />
        {item.refs.length ? <VersionRefs item={item} /> : null}
      </section>
    </article>
  );

  return mobile ? <ScrollArea className="h-full min-h-0 w-full min-w-0" contentInset="none">{content}</ScrollArea> : content;
}

function Definition({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1 text-sm">
      <p className="m-0 font-medium">{label}</p>
      <p className="m-0 break-words text-muted-foreground">{value}</p>
    </div>
  );
}

function PullRequests({ pulls }: { pulls: VersionHistoryPullRequest[] }) {
  return (
    <section className="grid gap-3" aria-label="Pull requests">
      <h3 className="m-0 text-sm font-semibold">Pull requests</h3>
      {pulls.length === 0 ? <p className="m-0 text-sm text-muted-foreground">Нет связанных pull request.</p> : null}
      {pulls.map((pull) => (
        <div key={pull.id} className="grid gap-2 border-t border-border pt-3 first:border-t-0 first:pt-0">
          {safePullUrl(pull.url) ? (
            <a className="break-words text-sm font-medium text-primary underline underline-offset-4" href={pull.url} target="_blank" rel="noreferrer">
              PR #{pull.number}: {pull.title}
            </a>
          ) : <p className="m-0 break-words text-sm font-medium">PR #{pull.number}: {pull.title}</p>}
          <details className="text-sm">
            <summary className="cursor-pointer font-medium text-muted-foreground">Полные данные PR #{pull.number}</summary>
            <div className="mt-3 grid gap-3">
              <dl className="m-0 grid gap-2 text-xs">
                <Metadata label="Repository" value={pull.repository} />
                <Metadata label="Автор" value={pull.author_login} />
                <Metadata label="Роль" value={pull.role} />
                <Metadata label="Состояние" value={`${pull.state}${pull.is_draft ? " · draft" : ""}`} />
                <Metadata label="Ветки" value={`${pull.head_branch} → ${pull.base_branch}`} />
                <Metadata label="Merge SHA" value={pull.merge_commit_sha ?? "Нет"} />
                <Metadata label="Создан" value={moscowDateTime(pull.created_at_utc)} />
                <Metadata label="Обновлён" value={moscowDateTime(pull.updated_at_utc)} />
                <Metadata label="Закрыт" value={pull.closed_at_utc ? moscowDateTime(pull.closed_at_utc) : "Нет"} />
                <Metadata label="Объединён" value={pull.merged_at_utc ? moscowDateTime(pull.merged_at_utc) : "Нет"} />
              </dl>
              <div className="grid gap-1">
                <p className="m-0 text-xs font-medium">Полное описание</p>
                {pull.body ? <MarkdownContent source={pull.body} className="text-sm" /> : <p className="m-0 text-sm text-muted-foreground">Описание отсутствует.</p>}
              </div>
            </div>
          </details>
        </div>
      ))}
    </section>
  );
}

function Metadata({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid min-w-0 grid-cols-[88px_minmax(0,1fr)] gap-2">
      <dt className="font-medium">{label}</dt>
      <dd className="m-0 break-words text-muted-foreground">{value}</dd>
    </div>
  );
}

function VersionRefs({ item }: { item: VersionHistoryItem }) {
  return (
    <details className="text-sm">
      <summary className="cursor-pointer font-medium text-muted-foreground">Технические ссылки</summary>
      <div className="mt-3 grid gap-3">
        {item.refs.map((ref, index) => (
          <dl key={`${ref.created_at_utc}-${index}`} className="m-0 grid gap-2 text-xs">
            <Metadata label="Источник" value={[ref.source_branch, ref.source_commit].filter(Boolean).join(" · ") || "Нет"} />
            <Metadata label="Назначение" value={[ref.target_branch, ref.target_commit].filter(Boolean).join(" · ") || "Нет"} />
            <Metadata label="Записано" value={moscowDateTime(ref.created_at_utc)} />
          </dl>
        ))}
      </div>
    </details>
  );
}

function isInstalled(item: VersionHistoryItem, installedVersions: InstalledVersions): boolean {
  const installedVersion = installedVersions[item.type];
  return installedVersion != null && item.version <= installedVersion;
}

function currentBuildVersion(items: VersionHistoryItem[], currentCommit: string | undefined): number | null {
  const commit = currentCommit?.trim().toLowerCase();
  if (!commit) return null;
  return items.reduce<number | null>((current, item) => {
    if (item.type !== "build" || !item.refs.some((ref) => ref.target_commit?.toLowerCase() === commit)) return current;
    return current == null ? item.version : Math.max(current, item.version);
  }, null);
}

function versionTypeTitle(item: VersionHistoryItem, types: VersionHistoryType[]): string {
  return types.find((type) => type.id === item.type)?.title ?? item.type.toUpperCase();
}

function safePullUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}
