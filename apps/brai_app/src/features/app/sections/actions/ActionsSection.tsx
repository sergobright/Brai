"use client";

import type { FormEvent, MouseEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { ChevronDown, FilePenLine, Plus } from "lucide-react";
import { cleanTitle, TITLE_MAX_LENGTH } from "@/shared/activities/text";
import type { ActivityItem, ActivitiesState, ActivityStatus } from "@/shared/types/activities";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/shared/ui/input-group";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { cx } from "../../appUtils";
import { PageWorkspace } from "../../chrome/PageWorkspace";
import { MobileCreateComposer, mobileCreateDraftHasText, type MobileCreateDraft } from "../MobileCreateComposer";
import { isMobileNavigationViewport } from "../../navigation/useSectionSwipeNavigation";
import { ActionRow, type DetailTitleFocus } from "./ActionRow";
import { SortableActionList } from "./ActionList";
import { ActivityDetailEditor } from "./ActivityDetailEditor";
import { useRestoreActionEditDrafts } from "./actionsModel";

export function ActionsSection({
  state,
  localSnapshotReady,
  onCreate,
  onUpdateTitle,
  onAutosaveDetails,
  onSetStatus,
  onDelete,
  onReorder,
  mobileCreateDraft,
  onMobileCreateDraftChange,
  dockOverflowOpen,
  onMobileOverlayChange,
  autoFocusAddInput,
  activeActivityId,
  activeActivityElapsedSeconds,
  onStartActionFocus,
  onStopActionFocus,
}: {
  state: ActivitiesState;
  localSnapshotReady: boolean;
  autoFocusAddInput: boolean;
  activeActivityId: string | null;
  activeActivityElapsedSeconds: number;
  onCreate: (title: string, descriptionMd?: string) => Promise<void>;
  onUpdateTitle: (action: ActivityItem, title: string) => Promise<void>;
  onAutosaveDetails: (action: ActivityItem, title: string, descriptionMd: string) => Promise<void>;
  onSetStatus: (action: ActivityItem, status: ActivityStatus) => Promise<void>;
  onDelete: (action: ActivityItem) => Promise<void>;
  onReorder: (orderedIds: string[], movedAction: ActivityItem) => Promise<void>;
  mobileCreateDraft: MobileCreateDraft;
  onMobileCreateDraftChange: (draft: MobileCreateDraft) => void;
  dockOverflowOpen: boolean;
  onStartActionFocus: (activityId: string) => Promise<void>;
  onStopActionFocus: (activityId?: string | null) => Promise<void>;
  onMobileOverlayChange: (open: boolean) => void;
}) {
  const [draft, setDraft] = useState("");
  const [mobileCreateOpen, setMobileCreateOpen] = useState(false);
  const [selectedActionId, setSelectedActionId] = useState<string | null>(null);
  const [mobileEditActionId, setMobileEditActionId] = useState<string | null>(null);
  const [doneOpen, setDoneOpen] = useState(true);
  const [openDeleteActionId, setOpenDeleteActionId] = useState<string | null>(null);
  const [titleDrafts, setTitleDrafts] = useState<Record<string, string>>({});
  const [detailTitleFocusRequest, setDetailTitleFocusRequest] = useState(0);
  const mobileCreateSubmitInFlightRef = useRef(false);
  const desktopInputRef = useRef<HTMLInputElement | null>(null);
  const newActions = state.actions.filter((action) => action.status === "New");
  const doneActions = state.actions.filter((action) => action.status === "Done");
  const selectedAction = selectedActionId ? state.actions.find((action) => action.id === selectedActionId) : null;
  const mobileEditAction = mobileEditActionId ? state.actions.find((action) => action.id === mobileEditActionId) : null;
  const visibleOpenDeleteActionId =
    openDeleteActionId && state.actions.some((action) => action.id === openDeleteActionId) ? openDeleteActionId : null;
  const mobileOverlayOpen = mobileCreateOpen || mobileEditAction != null;
  const mobileCreateHasDraft = mobileCreateDraftHasText(mobileCreateDraft);
  const MobileCreateFabIcon = mobileCreateHasDraft ? FilePenLine : Plus;
  const mobileCreateFabLabel = mobileCreateHasDraft ? "Продолжить черновик действия" : "Добавить действие";

  useEffect(() => {
    if (autoFocusAddInput) desktopInputRef.current?.focus();
  }, [autoFocusAddInput]);

  useRestoreActionEditDrafts(state.actions, onAutosaveDetails);

  useEffect(() => {
    onMobileOverlayChange(mobileOverlayOpen);
    if (!mobileOverlayOpen) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
      onMobileOverlayChange(false);
    };
  }, [mobileOverlayOpen, onMobileOverlayChange]);

  function closeOpenDeleteFromOutside(event: MouseEvent<HTMLElement>) {
    if (!visibleOpenDeleteActionId) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("[data-action-row-control]")) return;
    event.preventDefault();
    event.stopPropagation();
    setOpenDeleteActionId(null);
  }

  async function submitDesktop(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const title = cleanTitle(draft);
    if (!title) return;
    setDraft("");
    await onCreate(title);
  }

  function openMobileCreate() {
    setOpenDeleteActionId(null);
    setMobileCreateOpen(true);
  }

  function openMobileEdit(action: ActivityItem) {
    setOpenDeleteActionId(null);
    setSelectedActionId(action.id);
    setMobileEditActionId(action.id);
  }

  function setTitleDraft(actionId: string, title: string | null) {
    setTitleDrafts((current) => {
      if (title == null) {
        if (!(actionId in current)) return current;
        const next = { ...current };
        delete next[actionId];
        return next;
      }
      if (current[actionId] === title) return current;
      return { ...current, [actionId]: title };
    });
  }

  function selectAction(actionId: string, focusDetailTitle: DetailTitleFocus = "end") {
    if (isMobileNavigationViewport()) {
      const action = state.actions.find((item) => item.id === actionId);
      if (action) openMobileEdit(action);
      return;
    }
    setSelectedActionId(actionId);
    if (focusDetailTitle === "end") setDetailTitleFocusRequest((current) => current + 1);
  }

  async function submitMobile(title: string, descriptionMd: string) {
    if (mobileCreateSubmitInFlightRef.current) return;
    mobileCreateSubmitInFlightRef.current = true;
    onMobileCreateDraftChange({ title: "", descriptionMd: "" });
    try {
      await onCreate(title, descriptionMd);
    } finally {
      mobileCreateSubmitInFlightRef.current = false;
    }
  }

  return (
    <section
      className="actions-section relative grid h-full min-h-0 grid-rows-[minmax(0,1fr)] gap-3.5 max-[860px]:gap-0 max-[860px]:pb-0"
      aria-label="Действия"
      onClickCapture={closeOpenDeleteFromOutside}
    >
      <PageWorkspace
        className="actions-workspace relative"
        mainScroll={false}
        panelScroll={false}
        main={<ScrollArea className="actions-list-pane h-full min-h-0 min-w-0 max-[860px]:[&>[data-slot=scroll-area-viewport]>div]:pb-24">
          <form className="sticky top-0 z-[4] mb-[18px] max-[860px]:hidden" onSubmit={submitDesktop}>
            <InputGroup className="actions-add-form">
              <InputGroupInput
                ref={desktopInputRef}
                value={draft}
                maxLength={TITLE_MAX_LENGTH}
                placeholder="Добавить"
                aria-label="Добавить"
                autoFocus={autoFocusAddInput}
                onChange={(event) => setDraft(event.target.value)}
              />
              <InputGroupAddon align="inline-end">
                <Plus aria-hidden="true" />
              </InputGroupAddon>
            </InputGroup>
          </form>

          <div className="actions-list grid self-start" aria-label="Новые действия">
            {newActions.length === 0 ? (
              <div className="actions-empty px-[52px] py-6 font-normal text-muted-foreground max-[860px]:px-3.5 max-[860px]:py-[18px] max-[860px]:text-center">
                {localSnapshotReady ? "Новых действий нет" : "Загрузка действий"}
              </div>
            ) : (
              <SortableActionList
                actions={newActions}
                selectedActionId={selectedActionId}
                openDeleteActionId={visibleOpenDeleteActionId}
                onSelect={selectAction}
                onEditMobile={openMobileEdit}
                onUpdateTitle={onUpdateTitle}
                titleDrafts={titleDrafts}
                onTitleDraftChange={setTitleDraft}
                onSetStatus={onSetStatus}
                onDelete={onDelete}
                onOpenDelete={setOpenDeleteActionId}
                onCloseDelete={() => setOpenDeleteActionId(null)}
                onReorder={onReorder}
                activeActivityId={activeActivityId}
                activeActivityElapsedSeconds={activeActivityElapsedSeconds}
                onStartFocus={(action) => onStartActionFocus(action.id)}
                onStopFocus={(action) => onStopActionFocus(action.id)}
              />
            )}
          </div>

          {doneActions.length > 0 ? (
            <section className="actions-done-group mt-[22px] self-start" aria-label="Выполненные действия">
              <button
                type="button"
                className="actions-done-toggle inline-flex min-h-8 items-center gap-1.5 border-0 bg-transparent p-0 text-sm font-medium text-foreground"
                aria-expanded={doneOpen}
                aria-label={`Выполнено ${doneActions.length}`}
                onClick={() => setDoneOpen((current) => !current)}
              >
                <ChevronDown
                  className={cx("toggle-caret size-4 text-muted-foreground transition-transform", !doneOpen && "-rotate-90")}
                  aria-hidden="true"
                />
                <span>Выполнено</span>
                <strong className="text-sm font-semibold text-primary">{doneActions.length}</strong>
              </button>
              {doneOpen ? (
                <div className="actions-list done grid">
                  {doneActions.map((action) => (
                    <ActionRow
                      key={action.id}
                      action={action}
                      titleDraft={titleDrafts[action.id]}
                      selected={selectedActionId === action.id}
                      onSelect={(focusDetailTitle) => selectAction(action.id, focusDetailTitle)}
                      onEditMobile={openMobileEdit}
                      onUpdateTitle={onUpdateTitle}
                      onTitleDraftChange={setTitleDraft}
                      onSetStatus={onSetStatus}
                      onDelete={onDelete}
                      activeFocus={activeActivityId === action.id}
                      activeFocusElapsedSeconds={activeActivityId === action.id ? activeActivityElapsedSeconds : 0}
                      onStartFocus={(item) => onStartActionFocus(item.id)}
                      onStopFocus={(item) => onStopActionFocus(item.id)}
                      deleteOpen={visibleOpenDeleteActionId === action.id}
                      onOpenDelete={() => setOpenDeleteActionId(action.id)}
                      onCloseDelete={() => setOpenDeleteActionId(null)}
                    />
                  ))}
                </div>
              ) : null}
            </section>
          ) : null}
        </ScrollArea>}
        temporaryPanel={selectedAction && !mobileEditAction ? (
          <ActivityDetailEditor
            key={selectedAction.id}
            action={selectedAction}
            titleDraft={titleDrafts[selectedAction.id]}
            mode="desktop"
            focusTitleRequest={detailTitleFocusRequest}
            onClose={() => setSelectedActionId(null)}
            onTitleDraftChange={setTitleDraft}
            onAutosaveDetails={onAutosaveDetails}
          />
        ) : undefined}
      />

      {!mobileOverlayOpen && !dockOverflowOpen ? (
        <button
          type="button"
          className="actions-fab absolute bottom-[18px] right-[18px] z-[26] hidden h-[58px] w-[58px] place-items-center rounded-full border-0 bg-primary text-primary-foreground shadow-lg max-[860px]:grid"
          aria-label={mobileCreateFabLabel}
          title={mobileCreateFabLabel}
          onClick={openMobileCreate}
        >
          <MobileCreateFabIcon aria-hidden="true" />
        </button>
      ) : null}

      {mobileCreateOpen ? (
          <MobileCreateComposer
            draft={mobileCreateDraft}
            titleLabel="Добавить действие"
            descriptionLabel="Описание действия"
            submitLabel="Добавить действие"
            historyStateKey="braiMobileActionCreate"
            onCancel={() => setMobileCreateOpen(false)}
            onDraftChange={onMobileCreateDraftChange}
            onSubmit={submitMobile}
          />
      ) : null}

      {mobileEditAction ? (
        <ActivityDetailEditor
          key={`mobile-${mobileEditAction.id}`}
          action={mobileEditAction}
          titleDraft={titleDrafts[mobileEditAction.id]}
          mode="mobile"
          onClose={() => setMobileEditActionId(null)}
          onTitleDraftChange={setTitleDraft}
          onAutosaveDetails={onAutosaveDetails}
        />
      ) : null}
    </section>
  );
}
