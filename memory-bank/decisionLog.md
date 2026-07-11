# Decision Log

## 2026-06-24 - Public Repository Baseline

Brai public development starts from a new clean history instead of exposing private bootstrap history.

Rationale:

- Old Git history contained runtime artifacts and private development context.
- Future public development should use one canonical repository, not separate public/private source branches.
- Docs, accepted specs, and Memory Bank remain public, but are reset to public-safe content.

## 2026-06-24 - Public Hygiene Gate

Every public branch class must run the public guard before merge or deployment.

The guard checks current tree and reachable history for runtime data, generated artifacts, signing material, credential-like files, high-confidence secret patterns, local home paths, and personal markers.

## 2026-06-27 - SocratiCode Default Semantic Search

Brai agent workflow uses SocratiCode as the default path for semantic codebase exploration after `codebase_status` confirms the active project path is indexed.

Rationale:

- Semantic feature, responsibility, and architecture search should use the shared index before speculative file reads.
- Exact string and file discovery still use `rg`.
- Agent rules, docs, OpenSpec, and Memory Bank are declared as SocratiCode context artifacts so governance context is searchable.

## 2026-07-05 - SocratiCode Shared Worktree Index

Brai commits a stable SocratiCode `projectId` and uses a local `npm run socraticode:ensure` bootstrap so all main/task worktrees share one semantic index.

Rationale:

- Brai implementation work runs in `git worktrees`; path-hash indexing makes each new worktree look unindexed.
- A committed `projectId` lets worktrees converge on one shared codebase/context/graph collection.
- The local ensure/preflight workflow keeps the shared index complete and the watcher active instead of relying on manual MCP bootstrap steps.

## 2026-07-09 - Architecture Decision Records

Brai uses `docs/adr/` as the durable Architecture Decision Record source for architecture rationale. OpenSpec remains the source for accepted behavior and requirements; ADRs explain decisions, alternatives, consequences, and confirmation checks.

Rationale:

- Decision rationale was split across OpenSpec proposals, Memory Bank, and operational docs.
- Log4brains gives the project a browsable ADR site without replacing Markdown source files.
- Accepted ADRs preserve history; changed decisions supersede older ADRs instead of rewriting them.
