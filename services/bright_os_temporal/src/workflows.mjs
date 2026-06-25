import { condition, defineQuery, defineSignal, setHandler } from "@temporalio/workflow";
import {
  EVENT_SIGNAL,
  STATE_QUERY,
  applyPreviewEvent,
  applyPromotionEvent,
  createPreviewState,
  createPromotionState
} from "./state.mjs";

export const eventSignal = defineSignal(EVENT_SIGNAL);
export const stateQuery = defineQuery(STATE_QUERY);

export async function BranchPreviewWorkflow(input) {
  const state = createPreviewState(input);

  setHandler(eventSignal, (event) => {
    applyPreviewEvent(state, event);
  });
  setHandler(stateQuery, () => state);

  await condition(() => state.terminal);
}

export async function PromotionWorkflow(input) {
  const state = createPromotionState(input);

  setHandler(eventSignal, (event) => {
    applyPromotionEvent(state, event);
  });
  setHandler(stateQuery, () => state);

  await condition(() => state.terminal);
}
