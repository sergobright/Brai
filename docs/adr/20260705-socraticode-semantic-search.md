# SocratiCode semantic search

- Status: accepted
- Deciders: Project owner, Codex
- Date: 2026-07-05
- Tags: agents, search, codebase-context

## Context

Agents often need to find code by behavior, responsibility, feature, or natural-language meaning. Exact string search remains useful but is not enough for architecture exploration.

## Decision

Brai uses SocratiCode as the default path for semantic codebase exploration after confirming the active project path is indexed. Exact string and file discovery still use `rg`.

## Alternatives Considered

- Use only `rg`: rejected because semantic exploration requires behavior-level discovery.
- Read broad file trees speculatively: rejected because it wastes context and increases stale assumptions.

## Consequences

- Positive: agents can find relevant responsibilities faster with shared context artifacts.
- Negative: SocratiCode freshness must be checked when indexing behavior or context artifacts change.
- Risk: semantic results can be stale if the shared index or watcher is not healthy.

## Confirmation

Run `npm run socraticode:preflight` when SocratiCode behavior, agent rules, OpenSpec routing, or context indexing changes.

## Links

- `memory-bank/decisionLog.md`
- `openspec/specs/project-governance/spec.md`
- `docs/guidelines/10-agent-tools-openspec.md`

## Supersedes

None.

## Superseded By

None.
