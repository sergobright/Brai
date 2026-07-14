const MAX_EVENTS = 100;

export function normalizeEvent(event) {
  return {
    ...event,
    type: String(event?.type ?? "unknown"),
    at: event?.at ?? ""
  };
}

export function remember(state, event) {
  state.events.push(event);
  if (state.events.length > MAX_EVENTS) state.events.shift();
}

export function createTasks(definitions) {
  return Object.fromEntries(Object.entries(definitions).map(([name, label]) => [name, createTask(label)]));
}

export function resetTask(state, name, event) {
  const task = taskFor(state, name);
  task.status = "pending";
  task.lastEvent = event.type;
  task.lastAt = event.at;
  task.sha = event.sha ?? task.sha;
  task.source = event.source ?? task.source;
  delete task.blocker;
  refreshBlockers(state);
}

export function setTask(state, name, status, event) {
  const task = taskFor(state, name);
  task.status = status;
  task.lastEvent = event.type;
  task.lastAt = event.at;
  task.sha = event.sha ?? task.sha;
  task.source = event.source ?? task.source;
  if (status === "failed") {
    setBlocker(state, name, event);
  } else if (status === "running" || status === "passed" || status === "not_applicable") {
    delete task.blocker;
    refreshBlockers(state);
  }
}

export function setUnknownBlocker(state, event) {
  state.blocker = blockerFromEvent("unknown_event", event);
  state.blockers = [state.blocker];
}

export function refreshGates(state, definitions) {
  const missing = Object.entries(definitions)
    .filter(([name]) => state.tasks[name]?.status !== "passed" && state.tasks[name]?.status !== "not_applicable")
    .map(([name, label]) => ({ task: name, label, status: state.tasks[name]?.status ?? "missing" }));
  state.missing = missing;
  state.gates = {
    complete: missing.length === 0 && state.blockers.length === 0,
    missing
  };
}

function createTask(label) {
  return {
    label,
    status: "pending",
    lastEvent: "",
    lastAt: "",
    sha: "",
    source: ""
  };
}

function taskFor(state, name) {
  if (!state.tasks[name]) state.tasks[name] = createTask(name);
  return state.tasks[name];
}

function setBlocker(state, task, event) {
  const blocker = blockerFromEvent(task, event);
  const currentTask = taskFor(state, task);
  currentTask.blocker = blocker;
  currentTask.lastFailure = blocker;
  refreshBlockers(state);
}

function blockerFromEvent(task, event) {
  return stripEmpty({
    task,
    event: event.type,
    at: event.at,
    sha: event.sha ?? "",
    source: event.source ?? "",
    reason: event.reason ?? "",
    runUrl: event.runUrl ?? "",
    attempt: event.github?.runAttempt ?? "",
    runId: event.github?.runId ?? "",
    slot: event.slot ?? "",
    deliveryClass: event.deliveryClass ?? "",
    prNumber: event.prNumber ?? "",
    prUrl: event.prUrl ?? "",
    mergedAt: event.mergedAt ?? ""
  });
}

function stripEmpty(value) {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== "" && field != null));
}

function refreshBlockers(state) {
  const blockers = Object.entries(state.tasks)
    .filter(([, task]) => task.status === "failed")
    .map(([task, details]) => details.blocker ?? {
      task,
      event: details.lastEvent,
      at: details.lastAt,
      sha: details.sha,
      source: details.source
    });
  state.blockers = blockers;
  state.blocker = blockers.at(-1) ?? null;
}
