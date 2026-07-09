# Supabase Postgres as runtime source of truth

- Status: accepted
- Deciders: Project owner, Codex
- Date: 2026-07-09
- Tags: postgres, supabase, runtime, data

## Context

Brai runtime state includes timer canonical state, sessions, Activities, activity events, auth, deployment/version ledger, agents, schedules, runtime logs, and AI logs. The project needs one runtime database authority across production, Dev, and preview environments.

## Decision

Brai uses Supabase Postgres as the runtime source of truth. `BRAI_DATABASE_URL` is a server-side protected DSN for API, scheduler, deploy ledger scripts, production, Dev, and preview environments. The Node API remains the data boundary; web and Android clients do not receive Supabase service credentials or call the Supabase Data API directly.

## Alternatives Considered

- Keep SQLite as runtime fallback: rejected because current runtime, deploy ledger, Dev, production, and preview paths must fail fast without Postgres.
- Let clients use Supabase directly: rejected because service credentials and data contracts must stay behind the Node API boundary.

## Consequences

- Positive: production, Dev, and previews share one database model with isolated schemas and migration history.
- Negative: live runtime claims require environment-specific Postgres verification.
- Risk: protected DSN handling must stay outside Git and out of logs.

## Confirmation

Before rules, migrations, handoff, or claims about runtime tables, verify the real environment, DSN source without secrets, table presence, columns, indexes, constraints, and relevant rows.

## Links

- `docs/guidelines/04-api-data-sync-migrations.md`
- `openspec/specs/project-governance/spec.md`
- `openspec/specs/repository-operations/spec.md`

## Supersedes

None.

## Superseded By

None.
