# Supabase Postgres Cutover

This archived runbook records the completed move from frozen SQLite to Supabase Postgres. Current Brai runtime code no longer supports SQLite import, fallback, or cutover scripts. Do not commit DSNs, passwords, access tokens, service-role keys, or full connection strings.

## Runtime Contract

- `BRAI_DATABASE_URL` is the server-side Postgres DSN for the API, scheduler, deploy ledger scripts, preview branches, Dev, and production.
- SQLite is not a runtime fallback. `BRAI_DATA_STORE`, `BRAI_DB`, and SQLite import helpers are not part of the active runtime contract.
- Web and Android keep using the Brai Node API. They must not receive Supabase service credentials or call Supabase Data API directly.
- On the one-VPS deployment, Temporal keeps using hidden Supabase databases `temporal` and `temporal_visibility`; Brai product tables live in `postgres.public`, visible in Supabase Studio at `https://supabase.brai.one`.

## Protected Env Files

- Production runtime env: `/etc/brai/brai-api.env`
- Production Supabase Studio: `https://supabase.brai.one` through Caddy unified basic auth, proxying localhost-only Studio on `127.0.0.1:54323`.
- Supabase deploy automation env: `/etc/brai/supabase-deploy.env`
- Preview and Dev runtime envs: `/srv/projects/brai-envs/<environment>/brai-api.env`
- GitHub delivery secrets: `BRAI_DEPLOY_SSH_KEY`; Supabase lifecycle secrets stay on the VPS.

`/etc/brai/supabase-deploy.env` should contain only protected server-side values. On this
self-hosted Supabase server it uses `SUPABASE_SELF_HOSTED=true` and
`SUPABASE_SELF_HOSTED_DATABASE_URL`; preview and Dev runtime env files receive schema-scoped
`BRAI_DATABASE_URL` values. Runtime DSNs do not belong in Git.

## Current Active Contract

1. Apply baseline/current migrations:

```bash
node deploy/scripts/supabase-branch.mjs migrate --postgres-url "$BRAI_DATABASE_URL"
```

2. Smoke the database:

```bash
node deploy/scripts/postgres-smoke.mjs "$BRAI_DATABASE_URL"
```

3. Compare row counts and key invariants for auth users/sessions, event logs, read models, version ledger, deployment records, agents/schedules, `ai_logs`, `build_version_counters`, and `sequence_counters`.

## Production Maintenance Window

1. Announce the maintenance window if a migration has destructive risk and stop all writers: `brai-api.service`, scheduler/agent jobs, and accepted deployment writes.
2. Apply migrations to production Supabase:

```bash
node deploy/scripts/supabase-branch.mjs migrate --postgres-url "$BRAI_DATABASE_URL"
```

3. Run Postgres smoke.
4. Ensure `/etc/brai/brai-api.env` sets `BRAI_DATABASE_URL`.
5. Restart API/scheduler and smoke `/health`, auth/session, timer sync, activities sync, Inbox API, and `/v1/version`.
6. Reopen writes only after smoke passes.

## Preview And Dev

- Preview slots create or reuse a schema-only Supabase branch named from the `codex/*` branch and seed test data from `supabase/preview_seed.sql`.
- Preview branch metadata in `preview-slots.json` stores only branch name/id/status, never DSNs.
- Slot release deletes or pauses the Supabase preview branch together with the preview slot.
- Dev uses one long-lived protected Supabase branch `brai-dev`; it receives migrations/deploys but no automatic production refresh.
