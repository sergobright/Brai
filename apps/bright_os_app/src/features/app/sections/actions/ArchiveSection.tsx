"use client";

import type { MouseEvent } from "react";
import { useState } from "react";
import type { ActivityItem, ActivitiesState } from "@/shared/types/activities";
import { ActionRow } from "./ActionRow";

export function ArchiveSection({
  state,
  localSnapshotReady,
  onRestore,
}: {
  state: ActivitiesState;
  localSnapshotReady: boolean;
  onRestore: (action: ActivityItem) => Promise<void>;
}) {
  const [openRestoreActionId, setOpenRestoreActionId] = useState<string | null>(null);
  const archivedActions = state.archived_actions;
  const visibleOpenRestoreActionId =
    openRestoreActionId && archivedActions.some((action) => action.id === openRestoreActionId) ? openRestoreActionId : null;

  function closeOpenRestoreFromOutside(event: MouseEvent<HTMLElement>) {
    if (!visibleOpenRestoreActionId) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("[data-action-row-control]")) return;
    event.preventDefault();
    event.stopPropagation();
    setOpenRestoreActionId(null);
  }

  return (
    <section
      className="actions-section relative grid auto-rows-max content-start gap-3.5 max-[860px]:min-h-0 max-[860px]:gap-0 max-[860px]:pb-0"
      aria-label="Архив"
      onClickCapture={closeOpenRestoreFromOutside}
    >
      <div className="actions-list grid self-start" aria-label="Удаленные действия">
        {archivedActions.length === 0 ? (
          <div className="actions-empty px-[52px] py-6 font-normal text-muted-foreground max-[860px]:px-3.5 max-[860px]:py-[18px] max-[860px]:text-center">
            {localSnapshotReady ? "Архив пуст" : "Загрузка архива"}
          </div>
        ) : (
          archivedActions.map((action) => (
            <ActionRow
              key={action.id}
              action={action}
              selected={false}
              readonly
              control="restore"
              onSelect={() => undefined}
              onEditMobile={() => undefined}
              onUpdateTitle={async () => undefined}
              onSetStatus={async () => undefined}
              onDelete={async () => undefined}
              onRestore={onRestore}
              deleteOpen={visibleOpenRestoreActionId === action.id}
              onOpenDelete={() => setOpenRestoreActionId(action.id)}
              onCloseDelete={() => setOpenRestoreActionId(null)}
            />
          ))
        )}
      </div>
    </section>
  );
}
