"use client";
import type { FormEvent, MouseEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, FilePenLine, Plus } from "lucide-react";
import { cleanTitle, TITLE_MAX_LENGTH } from "@/shared/activities/text";
import type { ActivityItem, ActivitiesState, ActivityStatus } from "@/shared/types/activities";
import { emptyInboxState } from "@/shared/types/inbox";
import { emptyRelationsState, type RelationItem, type RelationSyncIssue } from "@/shared/types/relations";
import type { ContextDecision, ContextDecisionsState, ContextResolution, GoalPlanResponse } from "@/shared/types/contextDecisions";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/shared/ui/input-group";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { cx } from "../../appUtils";
import { PageWorkspace } from "../../chrome/PageWorkspace";
import { MobileCreateComposer, mobileCreateDraftHasText, type MobileCreateDraft } from "../MobileCreateComposer";
import { useMobileNavigationViewport } from "../../navigation/useSectionSwipeNavigation";
import type { DetailTitleFocus } from "./ActionRow";
import { SortableActionList } from "./ActionList";
import { ActivityDetailEditor } from "./ActivityDetailEditor";
import { GoalBadges, GoalMembershipPicker } from "./GoalMembershipControls";
import { GoalWorkspaceHeader } from "./GoalWorkspaceHeader";
import { OperationDetailPanel } from "./OperationWorkspaceItem";
import { RelationSyncAlert } from "./RelationSyncAlert";
import { WorkspaceWorkList } from "./WorkspaceWorkList";
import { buildActionsWorkspace, type ActionsWorkspaceView, type WorkspaceFilterId, type WorkspaceWorkItem } from "./actionsWorkspaceModel";
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
  workspace: providedWorkspace,
  onSelectWorkspaceFilter = () => undefined,
  onAutosaveGoalDetails = async () => undefined,
  onSetGoalStatus = async () => undefined,
  onDeleteGoal = async () => undefined,
  onPlanGoal = async () => ({ status: "queued", execution_id: "local", workflow_id: "local" }),
  onAddToGoals = async () => undefined,
  onRemoveFromGoal = async () => undefined,
  onReorderGoal = async () => undefined,
  onCreateActionInGoal = async () => undefined,
  relationSyncIssues = [],
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
  workspace?: ActionsWorkspaceView;
  onSelectWorkspaceFilter?: (filter: WorkspaceFilterId) => void;
  onCreateGoal?: (title: string, descriptionMd?: string) => Promise<void>;
  onRestoreGoal?: (goal: ActivityItem) => Promise<void>;
  onAutosaveGoalDetails?: (goal: ActivityItem, title: string, descriptionMd: string) => Promise<void>;
  onSetGoalStatus?: (goal: ActivityItem, status: ActivityStatus) => Promise<void>;
  onDeleteGoal?: (goal: ActivityItem) => Promise<void>;
  onPlanGoal?: (goal: ActivityItem) => Promise<GoalPlanResponse>;
  onAddToGoals?: (itemsId: string, goalIds: string[]) => Promise<void>;
  onRemoveFromGoal?: (relation: RelationItem) => Promise<void>;
  onReorderGoal?: (goalId: string, orderedRelationIds: string[]) => Promise<void>;
  onCreateActionInGoal?: (title: string, descriptionMd: string, goalItemsId: string) => Promise<void>;
  contextReviews?: ContextDecisionsState;
  relationSyncIssues?: RelationSyncIssue[];
  onResolveContextDecision?: (decision: ContextDecision, resolution: ContextResolution, editedPayload?: Record<string, unknown>) => Promise<void>;
  onUndoContextDecision?: (decision: ContextDecision) => Promise<void>;
}) {
  const fallbackWorkspace = useMemo(() => buildActionsWorkspace({ activities: state, inbox: emptyInboxState(), relations: emptyRelationsState(), filter: "actions" }), [state]);
  const workspace = providedWorkspace ?? fallbackWorkspace;
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
  const newItems = workspace.newItems;
  const doneItems = workspace.doneItems;
  const selectedItem = selectedActionId ? workspace.allItems.find((item) => item.id === selectedActionId) : null;
  const selectedAction = selectedItem?.kind === "action" ? selectedItem.activity ?? null : null;
  const selectedOperation = selectedItem?.kind === "operation" ? selectedItem : null;
  const mobileEditAction = mobileEditActionId ? state.actions.find((action) => action.id === mobileEditActionId) : null;
  const visibleOpenDeleteActionId =
    openDeleteActionId && state.actions.some((action) => action.id === openDeleteActionId) ? openDeleteActionId : null;
  const mobileViewport = useMobileNavigationViewport();
  const mobileOperationOpen = mobileViewport && selectedOperation != null;
  const mobileOverlayOpen = mobileCreateOpen || mobileEditAction != null || mobileOperationOpen;
  const mobileCreateHasDraft = mobileCreateDraftHasText(mobileCreateDraft);
  const MobileCreateFabIcon = mobileCreateHasDraft ? FilePenLine : Plus;
  const mobileCreateFabLabel = mobileCreateHasDraft ? "Продолжить черновик действия" : workspace.selectedGoal ? `Добавить действие в цель ${workspace.selectedGoal.title}` : "Добавить действие";
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
    if (workspace.selectedGoal) await onCreateActionInGoal(title, "", workspace.selectedGoal.id);
    else await onCreate(title);
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
    setSelectedActionId(actionId);
    if (focusDetailTitle === "end") setDetailTitleFocusRequest((current) => current + 1);
  }

  function selectWorkItem(item: WorkspaceWorkItem, focusDetailTitle: DetailTitleFocus = "end") {
    if (item.kind === "action" && item.activity) {
      selectAction(item.activity.id, focusDetailTitle);
      return;
    }
    setSelectedActionId(item.id);
  }

  async function submitMobile(title: string, descriptionMd: string) {
    if (mobileCreateSubmitInFlightRef.current) return;
    mobileCreateSubmitInFlightRef.current = true;
    onMobileCreateDraftChange({ title: "", descriptionMd: "" });
    try {
      if (workspace.selectedGoal) await onCreateActionInGoal(title, descriptionMd, workspace.selectedGoal.id);
      else await onCreate(title, descriptionMd);
    } finally {
      mobileCreateSubmitInFlightRef.current = false;
    }
  }

  function renderMemberships(item: WorkspaceWorkItem) {
    return (
      <div className="flex min-w-0 items-center justify-between gap-2">
        <GoalBadges item={item} onSelect={onSelectWorkspaceFilter} />
        <GoalMembershipPicker item={item} goals={[...workspace.activeGoals, ...workspace.completedGoals]} onAdd={onAddToGoals} onRemove={onRemoveFromGoal} />
      </div>
    );
  }

  async function reorderGoalGroup(status: ActivityStatus, orderedIds: string[]) {
    if (!workspace.selectedGoal) return;
    const other = (status === "New" ? workspace.doneItems : workspace.newItems).map((item) => item.id);
    const fullOrder = status === "New" ? [...orderedIds, ...other] : [...other, ...orderedIds];
    const relationIds = fullOrder.map((id) => workspace.allItems.find((item) => item.id === id)?.selectedRelation?.id).filter((id): id is string => Boolean(id));
    await onReorderGoal(workspace.selectedGoal.id, relationIds);
  }

  const workspaceListProps = {
    goals: [...workspace.activeGoals, ...workspace.completedGoals],
    filter: workspace.filter,
    selectedId: selectedActionId,
    titleDrafts,
    openDeleteActionId: visibleOpenDeleteActionId,
    activeActivityId,
    activeActivityElapsedSeconds,
    onSelect: selectWorkItem,
    onEditMobile: openMobileEdit,
    onUpdateTitle,
    onTitleDraftChange: setTitleDraft,
    onSetStatus,
    onDelete,
    onOpenDelete: setOpenDeleteActionId,
    onCloseDelete: () => setOpenDeleteActionId(null),
    onStartFocus: (action: ActivityItem) => onStartActionFocus(action.id),
    onStopFocus: (action: ActivityItem) => onStopActionFocus(action.id),
    onSelectFilter: onSelectWorkspaceFilter,
    onAddToGoals,
    onRemoveFromGoal,
  };
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
          {workspace.selectedGoal && workspace.selectedGoalProgress ? (
            <GoalWorkspaceHeader
              key={`${workspace.selectedGoal.id}:${workspace.selectedGoal.updated_at_utc}`}
              goal={workspace.selectedGoal}
              progress={workspace.selectedGoalProgress}
              onSave={onAutosaveGoalDetails}
              onSetStatus={onSetGoalStatus}
              onDelete={onDeleteGoal}
              onPlan={onPlanGoal}
            />
          ) : null}
          {relationSyncIssues[0] ? <RelationSyncAlert issue={relationSyncIssues[0]} /> : null}
          <form className="sticky top-0 z-[4] mb-[18px] max-[860px]:hidden" onSubmit={submitDesktop}>
            <InputGroup className="actions-add-form">
              <InputGroupInput
                ref={desktopInputRef}
                name="action-title"
                value={draft}
                maxLength={TITLE_MAX_LENGTH}
                placeholder={workspace.selectedGoal ? "Добавить действие в цель" : "Добавить"}
                aria-label={workspace.selectedGoal ? "Добавить действие в цель" : "Добавить"}
                autoFocus={autoFocusAddInput}
                onChange={(event) => setDraft(event.target.value)}
              />
              <InputGroupAddon align="inline-end">
                <Plus aria-hidden="true" />
              </InputGroupAddon>
            </InputGroup>
          </form>

          <div className="actions-list grid self-start" aria-label="Новые пункты">
            {newItems.length === 0 ? (
              <div className="actions-empty px-[52px] py-6 font-normal text-muted-foreground max-[860px]:px-3.5 max-[860px]:py-[18px] max-[860px]:text-center">
                {localSnapshotReady ? workspace.selectedGoal ? "В этой цели пока нет пунктов" : "Новых действий нет" : "Загрузка действий"}
              </div>
            ) : workspace.filter === "actions" ? (
              <SortableActionList
                actions={newItems.map((item) => item.activity).filter((item): item is ActivityItem => Boolean(item))}
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
                renderAfter={(action) => {
                  const item = newItems.find((entry) => entry.id === action.id);
                  return item ? renderMemberships(item) : null;
                }}
              />
            ) : (
              <WorkspaceWorkList
                {...workspaceListProps}
                items={newItems}
                sortable={workspace.selectedGoal != null}
                onReorder={(orderedIds) => reorderGoalGroup("New", orderedIds)}
              />
            )}
          </div>

          {doneItems.length > 0 ? (
            <section className="actions-done-group mt-[22px] self-start" aria-label="Выполненные пункты">
              <button
                type="button"
                className="actions-done-toggle inline-flex min-h-8 items-center gap-1.5 border-0 bg-transparent p-0 text-sm font-medium text-foreground"
                aria-expanded={doneOpen}
                aria-label={`Выполнено ${doneItems.length}`}
                onClick={() => setDoneOpen((current) => !current)}
              >
                <ChevronDown
                  className={cx("toggle-caret size-4 text-muted-foreground transition-transform", !doneOpen && "-rotate-90")}
                  aria-hidden="true"
                />
                <span>Выполнено</span>
                <strong className="text-sm font-semibold text-primary">{doneItems.length}</strong>
              </button>
              {doneOpen ? (
                <div className="actions-list done grid">
                  <WorkspaceWorkList
                    {...workspaceListProps}
                    items={doneItems}
                    sortable={workspace.selectedGoal != null}
                    onReorder={(orderedIds) => reorderGoalGroup("Done", orderedIds)}
                  />
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
        ) : selectedOperation && !mobileOperationOpen ? (
          <OperationDetailPanel item={selectedOperation} mode="desktop" onClose={() => setSelectedActionId(null)} />
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
      {mobileOperationOpen && selectedOperation ? (
        <OperationDetailPanel item={selectedOperation} mode="mobile" onClose={() => setSelectedActionId(null)} />
      ) : null}
    </section>
  );
}
