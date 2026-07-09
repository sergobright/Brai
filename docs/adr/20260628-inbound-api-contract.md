# External inbound API contract

- Status: accepted
- Deciders: Project owner, Codex
- Date: 2026-06-28
- Tags: api, integration, inbound

## Context

Connector-style writes into Brai need a stable external API shape with explicit authentication, request limits, storage mapping, and error behavior.

## Decision

Brai exposes a stable inbound API contract under the documented route shape, protected by the inbound API key, with behavior recorded in OpenSpec and `docs/api/inbound-api.md`.

## Alternatives Considered

- Let external callers use internal API routes directly: rejected because internal sync/auth contracts can evolve differently.
- Document the route only in code: rejected because integration behavior must be durable and reviewable.

## Consequences

- Positive: external connector writes have a stable contract.
- Negative: route, payload, response, auth, MIME, limits, storage mapping, title generation, and error changes must update docs in the same commit.
- Risk: Caddy/API path changes can break connectors if not handled through the documented contract.

## Confirmation

Run API tests and update `docs/api/inbound-api.md` whenever inbound behavior changes.

## Links

- `openspec/specs/inbound-api/spec.md`
- `docs/api/inbound-api.md`
- `docs/guidelines/04-api-data-sync-migrations.md`

## Supersedes

None.

## Superseded By

None.
