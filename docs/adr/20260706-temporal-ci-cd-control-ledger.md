# Temporal CI/CD control ledger

- Status: accepted
- Deciders: Project owner, Codex
- Date: 2026-07-06
- Tags: ci-cd, temporal, deployment

## Context

Brai deployment uses GitHub Actions and deploy scripts, but critical preview and promotion transitions need a durable control ledger that records blockers and manual recovery state.

## Decision

Brai uses self-hosted Temporal as the required CI/CD control ledger for branch previews and promotions. GitHub Actions still runs the checks and deployment scripts; Temporal gates and records critical transitions.

## Alternatives Considered

- Keep state only in GitHub Actions logs: rejected because logs are not an explicit workflow state machine.
- Replace deploy scripts with Temporal activities immediately: rejected because existing scripts remain the underlying deployment authority.

## Consequences

- Positive: failed checks, deploys, releases, and no-preview handoffs have durable workflow state.
- Negative: CI/CD process changes must update Temporal state, signals, tests, and docs together.
- Risk: Temporal outages block strict delivery until repaired.

## Confirmation

Run Temporal state tests and query workflow state when delivery changes or failures occur.

## Links

- `docs/operations/temporal-ci-cd.md`
- `services/brai_temporal/`
- `docs/operations/branch-preview-environments.md`

## Supersedes

None.

## Superseded By

None.
