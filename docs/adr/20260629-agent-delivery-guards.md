# Agent delivery guards

- Status: accepted
- Deciders: Project owner, Codex
- Date: 2026-06-29
- Tags: agents, delivery, guardrails

## Context

Agent work can accidentally edit tracked files on the wrong branch, bypass preview workflow, or leave completed OpenSpec changes active.

## Decision

Brai enforces agent delivery through `scripts/brai-task.mjs`, Codex hooks, Git hooks, delivery classification, OpenSpec validation, public guard, and preview/no-preview handoff requirements.

## Alternatives Considered

- Trust agents to remember procedure: rejected because context can compress and multiple tools can mutate files.
- Use Git branches manually as fallback: rejected because the official task state must remain authoritative.

## Consequences

- Positive: implementation work has a deterministic branch and handoff flow.
- Negative: legitimate operations may require escalation when sandboxed tools cannot write refs or runtime ledgers.
- Risk: hook drift can weaken enforcement unless synced and checked.

## Confirmation

Run `scripts/brai-guard-sync-check.sh --check` and task tests when delivery guard behavior changes.

## Links

- `AGENTS.md`
- `scripts/brai-task.mjs`
- `docs/operations/branch-preview-environments.md`

## Supersedes

None.

## Superseded By

None.
