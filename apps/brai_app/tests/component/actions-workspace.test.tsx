import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionsWorkspaceNavigation } from "@/features/app/sections/actions/ActionsWorkspaceNavigation";
import { GoalWorkspaceHeader } from "@/features/app/sections/actions/GoalWorkspaceHeader";
import { OperationDetailPanel, OperationWorkspaceRow } from "@/features/app/sections/actions/OperationWorkspaceItem";
import { WorkspaceWorkList } from "@/features/app/sections/actions/WorkspaceWorkList";
import { ContextReviewPanel } from "@/features/app/sections/actions/ContextReviewPanel";
import { buildActionsWorkspace, type WorkspaceWorkItem } from "@/features/app/sections/actions/actionsWorkspaceModel";
import { emptyActivitiesState, type ActivityItem } from "@/shared/types/activities";
import { emptyInboxState } from "@/shared/types/inbox";
import { emptyRelationsState, type RelationItem } from "@/shared/types/relations";
import { emptyContextDecisionsState, type ContextDecision } from "@/shared/types/contextDecisions";

describe("Actions Goal workspace UI", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
    window.history.replaceState({}, "", window.location.href);
  });

  it("renders system views in the required order and creates a Goal", () => {
    const activities = emptyActivitiesState();
    activities.goals = [activity("goal-1", "Луна")];
    const workspace = buildActionsWorkspace({ activities, inbox: emptyInboxState(), relations: emptyRelationsState(), filter: "all" });
    const onCreateGoal = vi.fn(async () => undefined);
    const { container } = render(<ActionsWorkspaceNavigation workspace={workspace} onSelect={vi.fn()} onCreateGoal={onCreateGoal} onRestoreGoal={vi.fn()} />);

    expect([...container.querySelectorAll("nav > div:first-child button")].map((button) => button.textContent?.replace(/\d+$/, ""))).toEqual(["Все", "Действия", "Операции", "Без цели"]);
    fireEvent.click(screen.getByRole("button", { name: "Создать цель" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Название новой цели" }), { target: { value: "  База на Луне  " } });
    fireEvent.click(screen.getByRole("button", { name: "Создать" }));
    expect(onCreateGoal).toHaveBeenCalledWith("База на Луне");
  });

  it("shows Operation status as read-only and opens its detail", () => {
    const onSelect = vi.fn();
    render(<OperationWorkspaceRow item={operationItem()} selected={false} onSelect={onSelect} />);

    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.getByText("Операция · статус управляется сервисом")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Проверить отчёт/ }));
    expect(onSelect).toHaveBeenCalledOnce();
  });

  it("closes the mobile Operation dialog through Escape, history, and Android Back while restoring focus", async () => {
    const onClose = vi.fn();
    const historyBack = vi.spyOn(window.history, "back").mockImplementation(() => undefined);
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>Открыть операцию</button>
          {open ? <OperationDetailPanel item={operationItem()} mode="mobile" onClose={() => { onClose(); setOpen(false); }} /> : null}
        </>
      );
    }
    render(<Harness />);

    const opener = screen.getByRole("button", { name: "Открыть операцию" });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Операция: Проверить отчёт" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(window.history.state?.braiOperationEditor).toBe("operation-1");
    await waitFor(() => expect(screen.getByRole("button", { name: "Закрыть операцию" })).toHaveFocus());

    fireEvent.keyDown(document, { key: "Escape", code: "Escape" });
    expect(historyBack).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Операция: Проверить отчёт" })).not.toBeInTheDocument());
    await waitFor(() => expect(opener).toHaveFocus());

    fireEvent.click(opener);
    expect(window.BraiAndroidBack?.()).toBe(true);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Операция: Проверить отчёт" })).not.toBeInTheDocument());
    expect(onClose).toHaveBeenCalledTimes(2);

    fireEvent.click(opener);
    fireEvent.popState(window);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Операция: Проверить отчёт" })).not.toBeInTheDocument());
    expect(historyBack).toHaveBeenCalledTimes(2);
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("keeps legacy Activity Operations visible without Goal membership commands", () => {
    const item = legacyOperationItem();
    const goal = item.memberships[0].goal;
    const callbacks = {
      onSelect: vi.fn(), onEditMobile: vi.fn(), onUpdateTitle: vi.fn(),
      onTitleDraftChange: vi.fn(), onSetStatus: vi.fn(), onDelete: vi.fn(),
      onOpenDelete: vi.fn(), onCloseDelete: vi.fn(), onStartFocus: vi.fn(),
      onStopFocus: vi.fn(), onSelectFilter: vi.fn(), onAddToGoals: vi.fn(),
      onRemoveFromGoal: vi.fn(), onReorder: vi.fn(),
    };
    const common = {
      items: [item], goals: [goal], selectedId: null, titleDrafts: {},
      openDeleteActionId: null, activeActivityId: null, activeActivityElapsedSeconds: 0,
      sortable: true, ...callbacks,
    };
    const { rerender } = render(<WorkspaceWorkList {...common} filter="all" />);

    expect(screen.getByText("Старая операция")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Луна" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Добавить в список/ })).not.toBeInTheDocument();

    rerender(<WorkspaceWorkList {...common} filter="goal:goal-1" />);
    expect(screen.queryByRole("button", { name: /Убрать из цели/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Переместить/ })).not.toBeInTheDocument();
  });

  it("explains the minimum-two invariant without mutating the Goal", () => {
    const goal = activity("goal-1", "Луна");
    const onSetStatus = vi.fn(async () => undefined);
    render(
      <GoalWorkspaceHeader
        goal={goal}
        progress={{ total: 1, done: 1, eligible: false, reason: "Для завершения цели нужно минимум два выполненных пункта." }}
        onSave={vi.fn()}
        onSetStatus={onSetStatus}
        onDelete={vi.fn()}
        onPlan={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Завершить цель" }));
    expect(onSetStatus).not.toHaveBeenCalled();
    expect(screen.getAllByText("Для завершения цели нужно минимум два выполненных пункта.").length).toBeGreaterThan(0);
  });

  it("explains that pending Goal memberships must synchronize before completion", async () => {
    const error = Object.assign(new Error("goal_membership_pending"), { code: "goal_membership_pending" });
    render(
      <GoalWorkspaceHeader
        goal={activity("goal-1", "Луна")}
        progress={{ total: 2, done: 2, eligible: true, reason: null }}
        onSave={vi.fn()}
        onSetStatus={vi.fn(async () => { throw error; })}
        onDelete={vi.fn()}
        onPlan={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Завершить цель" }));
    expect(await screen.findByText("Сначала синхронизируем состав цели. Попробуйте ещё раз после синхронизации.")).toBeInTheDocument();
  });

  it("shows durable queued feedback without requiring an immediate plan decision", async () => {
    const goal = activity("goal-1", "Луна");
    render(
      <GoalWorkspaceHeader
        goal={goal}
        progress={{ total: 0, done: 0, eligible: false, reason: "Для завершения цели нужно минимум два выполненных пункта." }}
        onSave={vi.fn()}
        onSetStatus={vi.fn()}
        onDelete={vi.fn()}
        onPlan={vi.fn(async () => ({ status: "queued" as const, execution_id: 12, workflow_id: "goal-plan-12" }))}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Предложить план" }));
    expect(await screen.findByText("План поставлен в очередь. Предложение появится здесь после обработки.")).toBeInTheDocument();
  });

  it("does not offer a new plan for a completed Goal", () => {
    const goal = activity("goal-1", "Луна");
    goal.status = "Done";
    goal.completed_at_utc = "2026-07-13T01:00:00.000Z";
    render(
      <GoalWorkspaceHeader
        goal={goal}
        progress={{ total: 2, done: 2, eligible: true, reason: null }}
        onSave={vi.fn()}
        onSetStatus={vi.fn()}
        onDelete={vi.fn()}
        onPlan={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: "Предложить план" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Вернуть в работу" })).toBeInTheDocument();
  });

  it("allows bounded plan editing before one accept", () => {
    const onResolve = vi.fn(async () => undefined);
    const state = emptyContextDecisionsState();
    state.decisions = [planDecision()];
    render(<ContextReviewPanel state={state} onResolve={onResolve} />);

    fireEvent.change(screen.getByRole("textbox", { name: "Шаг 1" }), { target: { value: "Исправленный шаг" } });
    fireEvent.click(screen.getByRole("button", { name: "Принять план" }));
    expect(onResolve).toHaveBeenCalledWith(state.decisions[0], "accept", expect.objectContaining({
      steps: expect.arrayContaining([expect.objectContaining({ title: "Исправленный шаг", position: 0 })]),
    }));
  });

  it("edits a discovered Goal and accepts the complete bounded draft", () => {
    const onResolve = vi.fn(async () => undefined);
    const state = emptyContextDecisionsState();
    state.decisions = [discoveryDecision()];
    render(<ContextReviewPanel state={state} onResolve={onResolve} />);

    fireEvent.change(screen.getByRole("textbox", { name: "Название предложенной цели" }), { target: { value: "Лунная база" } });
    fireEvent.click(screen.getByRole("button", { name: "Удалить пункт 3" }));
    fireEvent.click(screen.getByRole("button", { name: "Создать цель" }));

    expect(onResolve).toHaveBeenCalledWith(state.decisions[0], "accept", expect.objectContaining({
      title: "Лунная база",
      member_items_ids: ["action-1", "action-2"],
    }));
    expect(screen.queryByText("action-1")).not.toBeInTheDocument();
    expect(screen.getByText("Подготовить чертёж")).toBeInTheDocument();
  });

  it("reviews every pending audit item through the decision resolver", () => {
    const onResolve = vi.fn(async () => undefined);
    const state = emptyContextDecisionsState();
    state.audits = [{
      id: "audit-1",
      status: "pending",
      policy_id: "policy-1",
      decision_ids: ["decision-audit-1"],
      due_at_utc: "2026-07-27T00:00:00.000Z",
      created_at_utc: "2026-07-13T00:00:00.000Z",
      updated_at_utc: "2026-07-13T00:00:00.000Z",
      items: [{
        id: 1,
        decisions_id: "decision-audit-1",
        position: 0,
        status: "pending",
        decision_kind: "relation_add",
        confidence: 0.97,
        rationale: "Связь подтверждена",
        evidence: [{ items_id: "goal-1", excerpt: "База на Луне" }],
        proposal: { target_items_id: "goal-1" },
      }],
    }];
    render(<ContextReviewPanel state={state} onResolve={onResolve} />);

    expect(screen.getByText("Добавить пункт в цель «База на Луне»." )).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Подтвердить" }));
    expect(onResolve).toHaveBeenCalledWith(expect.objectContaining({
      id: "decision-audit-1",
      audit_id: "audit-1",
    }), "accept", undefined);
  });

  it("offers compensation undo instead of re-resolving automatic decisions", async () => {
    const onResolve = vi.fn(async () => undefined);
    const onUndo = vi.fn(async () => undefined);
    const decision = planDecision();
    decision.decision_kind = "relation_add";
    decision.proposal = { source_items_id: "action-1", target_items_id: "goal-1", relation_type_id: "part_of" };
    decision.status = "auto_accepted";
    const state = { ...emptyContextDecisionsState(), decisions: [decision] };

    render(<ContextReviewPanel state={state} onResolve={onResolve} onUndo={onUndo} />);
    fireEvent.click(screen.getByRole("button", { name: "Отменить" }));

    await waitFor(() => expect(onUndo).toHaveBeenCalledWith(state.decisions[0]));
    expect(onResolve).not.toHaveBeenCalled();
  });

  it("marks a policy notification read before hiding it", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    const state = emptyContextDecisionsState();
    state.notifications = [{
      id: "notification-1",
      type: "policy_activated",
      policy_id: "policy-1",
      body: "Автопринятие включено.",
      created_at_utc: "2026-07-13T00:00:00.000Z",
      read_at_utc: null,
    }];
    render(<ContextReviewPanel state={state} onResolve={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Скрыть уведомление" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/v1/context-notifications/notification-1/read", {
      method: "POST",
      credentials: "include",
    }));
    expect(screen.queryByText("Автопринятие включено.")).not.toBeInTheDocument();
  });

  it.each([
    ["completed", "Предложение плана готово к проверке."],
    ["failed", "Не удалось подготовить план. Попробуйте ещё раз."],
    ["needs_review", "Не удалось подготовить корректный план. Запросите его повторно."],
  ] as const)("shows the %s terminal plan result", async (status, expected) => {
    render(
      <GoalWorkspaceHeader
        goal={activity("goal-1", "Луна")}
        progress={{ total: 0, done: 0, eligible: false, reason: null }}
        onSave={vi.fn()}
        onSetStatus={vi.fn()}
        onDelete={vi.fn()}
        onPlan={vi.fn(async () => ({ status, execution_id: 12, workflow_id: "goal-plan-12" }))}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Предложить план" }));
    expect(await screen.findByText(expected)).toBeInTheDocument();
  });
});

function activity(id: string, title: string): ActivityItem {
  return { id, activity_type_id: "goal", title, description_md: "", status: "New", created_at_utc: "2026-07-13T00:00:00.000Z", updated_at_utc: "2026-07-13T00:00:00.000Z", completed_at_utc: null, sort_order: null, deleted_at_utc: null, restored_at_utc: null };
}

function operationItem(): WorkspaceWorkItem {
  return { id: "operation-1", rowId: "operation-1", kind: "operation", relationSourceRole: "inbox", goalMembershipReadOnly: false, title: "Проверить отчёт", descriptionMd: "", status: "New", updatedAtUtc: "2026-07-13T00:00:00.000Z", memberships: [] };
}

function legacyOperationItem(): WorkspaceWorkItem {
  const goal = activity("goal-1", "Луна");
  const relation = relationItem();
  return {
    id: "legacy-operation", rowId: "legacy-operation", kind: "operation",
    relationSourceRole: "activity", goalMembershipReadOnly: true,
    title: "Старая операция", descriptionMd: "", status: "New",
    updatedAtUtc: "2026-07-13T00:00:00.000Z",
    memberships: [{ goal, relation }], selectedRelation: relation,
  };
}

function relationItem(): RelationItem {
  return {
    id: "relation-1", user_id: "user-1", relation_types_id: "part_of",
    source_items_id: "legacy-operation", target_items_id: "goal-1", status: "active", position: 0,
    active_from_utc: "2026-07-13T00:00:00.000Z", active_to_utc: null,
    operation_id: "operation-1", ended_operation_id: null, origin_decision_id: null,
    created_by_actor_type: "user", created_by_actor_id: "user-1",
    ended_by_actor_type: null, ended_by_actor_id: null, end_reason: null,
    metadata_json: {}, created_at_utc: "2026-07-13T00:00:00.000Z", updated_at_utc: "2026-07-13T00:00:00.000Z",
  };
}

function planDecision(): ContextDecision {
  return { id: "decision-1", decision_kind: "goal_plan", status: "pending", confidence: 0.9, subject_items_id: "goal-1", proposal: { goal_items_id: "goal-1", steps: [{ title: "Шаг 1", description_md: "", position: 0 }, { title: "Шаг 2", description_md: "", position: 1 }] }, rationale: "План", evidence: [], created_at_utc: "2026-07-13T00:00:00.000Z", updated_at_utc: "2026-07-13T00:00:00.000Z" };
}

function discoveryDecision(): ContextDecision {
  return {
    id: "decision-discovery-1",
    decision_kind: "goal_discovery",
    status: "pending",
    confidence: 0.91,
    subject_items_id: null,
    proposal: {
      title: "Черновик",
      description_md: "Описание",
      member_items_ids: ["action-1", "action-2", "action-3"],
    },
    rationale: "Три действия ведут к общему результату",
    evidence: [
      { items_id: "action-1", excerpt: "Подготовить чертёж" },
      { items_id: "action-2", excerpt: "Собрать материалы" },
      { items_id: "action-3", excerpt: "Проверить расчёты" },
    ],
    created_at_utc: "2026-07-13T00:00:00.000Z",
    updated_at_utc: "2026-07-13T00:00:00.000Z",
  };
}
