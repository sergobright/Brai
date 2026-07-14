"use client";

import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { ArchiveRestore, Clock3 } from "lucide-react";
import { BraiApi, type ArchivedRoleItem, type ArchiveRole, type ArchiveState } from "@/shared/api/braiApi";
import { defaultApiBase } from "@/shared/config/runtime";
import type { ActivitiesState, ActivityItem } from "@/shared/types/activities";
import type { InboxItem } from "@/shared/types/inbox";
import { Button } from "@/shared/ui/button";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { cx } from "../../appUtils";

export function ArchiveSection({ activityState, localSnapshotReady, onRestoreAction, onRestoreInbox, onRailContent }: {
  activityState: ActivitiesState;
  localSnapshotReady: boolean;
  onRestoreAction: (action: ActivityItem) => Promise<void>;
  onRestoreInbox: (item: InboxItem) => Promise<void>;
  onRailContent?: (content: ReactNode | null) => void;
}) {
  const api = useMemo(() => new BraiApi(defaultApiBase()), []);
  const [selectedRole, setSelectedRole] = useState("activity");
  const [archiveState, setArchiveState] = useState<{ role: string; state: ArchiveState } | null>(null);
  const state = archiveState?.role === selectedRole ? archiveState.state : null;
  const loading = state === null;

  useEffect(() => {
    let cancelled = false;
    void api.archive(selectedRole).then((next) => {
      if (!cancelled) setArchiveState({ role: selectedRole, state: next });
    }).catch(() => {
      if (!cancelled) setArchiveState((current) => current?.role === selectedRole
        ? current
        : { role: selectedRole, state: { roles: current?.state.roles ?? [], selected_role: selectedRole, items: [] } });
    });
    return () => { cancelled = true; };
  }, [api, selectedRole]);

  useEffect(() => {
    if (!onRailContent) return;
    onRailContent(<ArchiveRoleRail roles={state?.roles ?? []} selected={selectedRole} onSelect={setSelectedRole} />);
    return () => onRailContent(null);
  }, [onRailContent, selectedRole, state?.roles]);

  async function restore(item: ArchivedRoleItem) {
    setArchiveState((current) => current?.role === selectedRole
      ? { ...current, state: { ...current.state, items: current.state.items.filter((entry) => entry.id !== item.id) } }
      : current);
    if (item.role_system === "activity") await onRestoreAction({ ...(item.payload ?? {}), id: item.id } as ActivityItem);
    if (item.role_system === "inbox") await onRestoreInbox({ ...(item.payload ?? {}), id: item.id } as InboxItem);
  }

  const items = selectedRole === "activity"
    ? mergeArchivedActivities(state?.items ?? [], activityState.archived_actions)
    : state?.items ?? [];
  return (
    <ScrollArea className="h-full min-h-0" role="tabpanel">
      <section className="grid content-start gap-0" aria-label={`Архив: ${roleLabel(selectedRole)}`}>
        {items.length === 0 ? (
          <div className="px-[52px] py-6 text-muted-foreground max-[860px]:px-3.5 max-[860px]:text-center">
            {loading || !localSnapshotReady ? "Загрузка архива" : "В этом разделе архив пуст"}
          </div>
        ) : items.map((item) => (
          <article key={`${item.role_system}:${item.id}`} className="grid min-h-[68px] grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-border px-[38px] py-3 max-[860px]:px-3.5">
            <div className="min-w-0">
              <h2 className="m-0 truncate text-base font-medium">{item.title || roleLabel(item.role_system)}</h2>
              {item.description ? <p className="m-0 mt-1 line-clamp-2 text-sm text-muted-foreground">{item.description}</p> : null}
              <p className="m-0 mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                <Clock3 className="size-3" aria-hidden="true" />
                {formatArchiveDate(item.deleted_at_utc ?? item.updated_at_utc)} · {item.role_title}
              </p>
            </div>
            {item.role_system === "activity" || item.role_system === "inbox" ? (
              <Button type="button" variant="ghost" size="icon" aria-label={`Восстановить: ${item.title}`} title="Восстановить" onClick={() => void restore(item)}>
                <ArchiveRestore className="size-4" aria-hidden="true" />
              </Button>
            ) : null}
          </article>
        ))}
      </section>
    </ScrollArea>
  );
}

function ArchiveRoleRail({ roles, selected, onSelect }: { roles: ArchiveRole[]; selected: string; onSelect: (role: string) => void }) {
  return (
    <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)]">
      <div className="border-b border-border p-4">
        <h2 className="m-0 text-lg font-semibold">Разделы архива</h2>
        <p className="m-0 mt-1 text-sm text-muted-foreground">Ролевые таблицы</p>
      </div>
      <ScrollArea className="min-h-0" contentInset="none">
        <nav className="grid gap-1 p-3" aria-label="Разделы архива">
          {roles.map((role) => (
            <button
              key={role.id}
              type="button"
              className={cx("flex min-h-10 items-center justify-between gap-3 rounded-md px-3 text-left text-sm hover:bg-accent", selected === role.title_system && "bg-primary/10 text-foreground")}
              onClick={() => onSelect(role.title_system)}
            >
              <span className="truncate">{roleLabel(role.title_system, role.title)}</span>
              <span className="text-xs tabular-nums text-muted-foreground">{role.archived_count}</span>
            </button>
          ))}
        </nav>
      </ScrollArea>
    </div>
  );
}

function mergeArchivedActivities(remote: ArchivedRoleItem[], local: ActivityItem[]): ArchivedRoleItem[] {
  const merged = new Map(remote.map((item) => [item.id, item]));
  for (const activity of local) {
    if (merged.has(activity.id)) continue;
    merged.set(activity.id, {
      id: activity.id,
      title: activity.title,
      description: activity.description_md,
      author: activity.author ?? "",
      created_at_utc: activity.created_at_utc,
      updated_at_utc: activity.updated_at_utc,
      deleted_at_utc: activity.deleted_at_utc,
      item_roles_id: activity.item_roles_id ?? null,
      role_status: "deleted",
      role_system: "activity",
      role_title: "Activity",
      payload: { ...activity },
    });
  }
  return [...merged.values()].sort((left, right) => (right.deleted_at_utc ?? right.updated_at_utc).localeCompare(left.deleted_at_utc ?? left.updated_at_utc));
}

function roleLabel(system: string, fallback?: string): string {
  if (system === "activity") return "Activities";
  if (system === "inbox") return "Inbox";
  if (system === "focus_session") return "Focus sections";
  return fallback || system;
}

function formatArchiveDate(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeStyle: "short" }).format(date) : value;
}
