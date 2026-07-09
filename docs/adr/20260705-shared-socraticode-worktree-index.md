# Shared SocratiCode worktree index

- Status: accepted
- Deciders: Project owner, Codex
- Date: 2026-07-05
- Tags: agents, worktrees, codebase-context

## Context

Brai implementation work runs in Git worktrees. Path-hash indexing can make every new worktree look like a different unindexed project.

## Decision

Brai commits a stable SocratiCode `projectId` and provides `npm run socraticode:ensure` so main and task worktrees share one semantic index.

## Alternatives Considered

- Index each worktree independently: rejected because it duplicates work and leaves new task branches cold.
- Require manual MCP bootstrap per worktree: rejected because it is easy to forget and hard to verify.

## Consequences

- Positive: semantic search, code graph, and context artifacts converge across main and task worktrees.
- Negative: project identity changes must be deliberate and verified.
- Risk: stale watcher state can still require ensure/preflight repair.

## Confirmation

Run `npm run socraticode:ensure` when the shared index is missing, incomplete, or stale.

## Links

- `.socraticode.json`
- `.socraticodecontextartifacts.json`
- `memory-bank/decisionLog.md`

## Supersedes

None.

## Superseded By

None.
