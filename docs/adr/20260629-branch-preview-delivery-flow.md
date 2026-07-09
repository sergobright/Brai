# Branch preview delivery flow

- Status: accepted
- Deciders: Project owner, Codex
- Date: 2026-06-29
- Tags: delivery, preview, deployment

## Context

Runtime/product changes need visible verification before acceptance, while docs/infra-only changes can be proven by checks and no-preview handoff.

## Decision

`main` deploys production. `codex/*` branches use the task starter and delivery classification. Runtime/product branches deploy to preview slots A through E; docs/infra and technical-no-preview branches can use the no-preview path.

## Alternatives Considered

- Commit directly to `main`: rejected because implementation work needs checks and handoff before acceptance.
- Require preview for every change: rejected because docs/infra changes do not need browser slot allocation.

## Consequences

- Positive: product work gets reviewable preview URLs, while technical docs/infra work avoids unnecessary slot usage.
- Negative: agents must follow starter and handoff procedures exactly.
- Risk: misclassification can either skip needed preview or waste preview capacity.

## Confirmation

Use `scripts/brai-task-start.sh <task-slug>` before tracked project-file work and classify delivery before handoff.

## Links

- `AGENTS.md`
- `docs/operations/branch-preview-environments.md`
- `docs/guidelines/07-git-versioning-repository-sync.md`

## Supersedes

None.

## Superseded By

None.
