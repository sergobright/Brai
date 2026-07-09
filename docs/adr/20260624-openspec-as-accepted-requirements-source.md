# OpenSpec as accepted requirements source

- Status: accepted
- Deciders: Project owner, Codex
- Date: 2026-06-24
- Tags: openspec, governance, requirements

## Context

Brai needs durable requirements that are explicit, reviewable, and validated independently from chat context or implementation memory.

## Decision

Accepted durable behavior, workflow rules, architecture constraints, services, and invariants live in `openspec/specs/`. Planned changes start under `openspec/changes/<change-id>/` before implementation unless an emergency direct edit is explicitly approved.

## Alternatives Considered

- Store requirements only in Memory Bank: rejected because Memory Bank is context, not strict requirement validation.
- Store requirements only in docs/guidelines: rejected because those files are working rules, not change proposals with tasks and validation.

## Consequences

- Positive: requirements changes have an explicit proposal/spec/tasks path.
- Negative: small governance changes need a little ceremony.
- Risk: completed changes must be archived so active proposals do not become stale.

## Confirmation

Run `npm run openspec:validate` after changing specs or rules.

## Links

- `openspec/config.yaml`
- `openspec/specs/project-governance/spec.md`
- `docs/guidelines/10-agent-tools-openspec.md`

## Supersedes

None.

## Superseded By

None.
