import type { ActivityItem } from "@/shared/types/activities";
import type { ContextDecision, ContextDecisionsState, ContextResolution } from "@/shared/types/contextDecisions";
import { ActionsWorkspaceNavigation } from "./ActionsWorkspaceNavigation";
import { ContextReviewPanel } from "./ContextReviewPanel";
import type { ActionsWorkspaceView, WorkspaceFilterId } from "./actionsWorkspaceModel";

export function ActionsSidebarContent({ workspace, contextReviews, onSelect, onCreateGoal, onRestoreGoal, onResolve, onUndo }: {
  workspace: ActionsWorkspaceView;
  contextReviews: ContextDecisionsState;
  onSelect: (filter: WorkspaceFilterId) => void;
  onCreateGoal: (title: string) => Promise<void>;
  onRestoreGoal: (goal: ActivityItem) => Promise<void>;
  onResolve: (decision: ContextDecision, resolution: ContextResolution, editedPayload?: Record<string, unknown>) => Promise<void>;
  onUndo: (decision: ContextDecision) => Promise<void>;
}) {
  return (
    <>
      <ActionsWorkspaceNavigation workspace={workspace} onSelect={onSelect} onCreateGoal={onCreateGoal} onRestoreGoal={onRestoreGoal} />
      <ContextReviewPanel state={contextReviews} onResolve={onResolve} onUndo={onUndo} />
    </>
  );
}
