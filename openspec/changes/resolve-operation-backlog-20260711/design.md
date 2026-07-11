# Design

## Backlog closure

The runtime operations table remains the ledger. Completion uses the existing
deploy-owned helper, extended only to accept the two historical
`activity:operation:*` identifiers while retaining operation type and Codex
author checks.

## Delivery tooling

Existing task, acceptance, Temporal, and sandbox helpers are extended in place.
No parallel orchestration layer is added. Delegation is a scoped receipt in
ignored task state; dependency updates use lockfile-only npm behavior.

## Runtime

Temporal and Supavisor pools are bounded below PostgreSQL's existing connection
limit. Vault and ADR publication use the existing deploy ownership contract.
The preview slot JSON registry stays authoritative, but its generated HTML and
public Caddy routes are deleted.

## Product

OTP email uses the existing public HTTPS brand asset and returns no MIME
attachments. Android overlay QA adds instrumentation coverage without changing
the production overlay implementation.
