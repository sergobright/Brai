## Why

The current rules already require new Codex implementation work to start from a
fresh `codex/*` task branch, finish with committed and pushed tracked changes,
deploy to a preview slot, and hand off using verified preview details. A recent
failure showed that the rules were not mechanically enforced at every step.

The failure chain was:

- project files were changed without a fresh valid `codex/*` task branch;
- `PreToolUse` was not fail-closed for namespaced, custom, or nested tools;
- shell write detection relied on a deny-list regex instead of a read-only
  allow-list;
- Git hooks did not help because the agent stopped before commit or push;
- `brai-preview-handoff.sh` was strict but depended on being run manually;
- `Stop` and handoff enforcement could not rely only on `writeIntentAt`;
- preview acceptance could proceed unless the exact branch head had verified
  preview state.

This change specifies the required guard behavior before implementation changes
are made.

## What Changes

- Require delivery guards to fail closed for unrecognized, namespaced, custom,
  and nested write-capable tool calls.
- Require shell commands before valid task state to use an explicit read-only
  allow-list.
- Require manual `codex/*` branch creation and switching to be blocked outside
  the checked-in task starter or same-thread follow-up flow.
- Require final handoff to derive implementation work from Git state and preview
  verification, not only from `writeIntentAt`.
- Require preview acceptance to verify the exact branch head before PR merge or
  auto-merge can start.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `repository-operations`: task branch startup, write-like tool guard rails,
  final handoff verification, and preview acceptance enforcement.

## Impact

- Planned implementation will affect `scripts/brai-task.mjs`, `.codex/hooks.json`,
  `.githooks/`, `deploy/scripts/accept-preview.sh`, repository operation docs,
  and delivery guard tests.
- This OpenSpec change does not implement those changes.

## Non-Goals

- Do not implement hook, script, CI, Temporal, or application code in this
  OpenSpec change.
- Do not change accepted app behavior, API behavior, runtime data, or release
  versioning semantics.
