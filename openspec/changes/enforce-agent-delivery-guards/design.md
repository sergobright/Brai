# Enforce Agent Delivery Guards Design

## Decisions

- Treat `scripts/bright-task.mjs` as the local delivery state machine:
  `no-task -> task-started -> write-intent -> committed -> pushed ->
  preview-ready -> handoff-receipt`.
- Before a valid task branch exists, allow only explicitly read-only commands.
  Unknown shell commands are write-like by default.
- Parse Codex hook input recursively. The guard must recognize `tool_name`,
  `tool`, `name`, `recipient_name`, namespaced tools such as
  `functions.apply_patch`, custom tool calls such as `apply_patch`, and nested
  tool calls inside `multi_tool_use.parallel`.
- Fail closed when hook input, command shape, or tool identity cannot be
  interpreted safely.
- Block manual `codex/*` branch creation or switching through
  `git switch`, `git checkout`, `git branch`, or `git worktree`. New work must
  use `scripts/bright-task-start.sh`; direct follow-up work must use the
  same-thread `follow-up` marker.
- Make `startTask()` enable `.githooks` for the created worktree so commit and
  push guards are active without a manual setup step.
- Make `preCommit()` mark write intent so a later clean tree still requires
  preview verification.
- Make `stopHook()` derive implementation work from Git state, not only from
  `writeIntentAt`: dirty files, staged files, local commits or diff against
  `origin/dev`, marker mismatch, stale receipt, or missing receipt must block
  handoff until preview verification succeeds.
- Add `doctor --strict` or an equivalent strict mode for nonzero shell and CI
  use.
- Gate preview acceptance on verified preview state for the exact branch head
  before creating, merging, or auto-merging the acceptance PR.

## Data Flow

The task starter creates the branch and local marker. Write-like tool use and
Git operations validate the branch and marker before any project file changes
or repository publication. Commit marks the task as implementation work. Push
starts CI/CD preview delivery. Preview verification records a local handoff
receipt for the exact branch head. Final handoff and acceptance both require
that receipt or an equivalent verified preview state.

## Alternatives

- Relying on agent instruction text was rejected because the incident happened
  despite explicit written rules.
- Keeping shell write detection as a deny-list was rejected because unknown
  generators, CLIs, nested tools, and namespaced tools can bypass it.
- Relying only on `writeIntentAt` was rejected because the flag is missing when
  the pre-write hook itself is bypassed.
