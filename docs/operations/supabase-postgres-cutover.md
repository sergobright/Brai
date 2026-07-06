# Supabase Postgres Cutover

This runbook moves Brai runtime data from frozen SQLite to Supabase Postgres. Do not commit DSNs, passwords, access tokens, service-role keys, or full connection strings.

## Runtime Contract

- `BRAI_DATABASE_URL` is the server-side Postgres DSN for the API, scheduler, deploy ledger scripts, preview branches, Dev, and production.
- `BRAI_DATA_STORE=postgres` is a transitional guard for environments that should refuse SQLite runtime usage.
- `BRAI_DB` is legacy-only after cutover: frozen backup/import source and legacy tests.
- Web and Android keep using the Brai Node API. They must not receive Supabase service credentials or call Supabase Data API directly.
- On the one-VPS deployment, Temporal keeps using hidden Supabase databases `temporal` and `temporal_visibility`; Brai product tables live in `postgres.public`, visible in Supabase Studio at `https://supabase.brightos.world`.

## Protected Env Files

- Production runtime env: `/etc/brai/brai-api.env`
- Production Supabase Studio: `https://supabase.brightos.world` through Caddy unified basic auth, proxying localhost-only Studio on `127.0.0.1:54323`.
- Supabase deploy automation env: `/etc/brai/supabase-deploy.env`
- Preview and Dev runtime envs: `/srv/projects/brai-envs/<environment>/brai-api.env`
- GitHub secrets required by delivery workflows: `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF`, `BRAI_PROD_DATABASE_URL`

`/etc/brai/supabase-deploy.env` should contain only protected server-side values such as `SUPABASE_PROJECT_REF`, `SUPABASE_ACCESS_TOKEN`, and optional `SUPABASE_CLI`. Runtime DSNs belong in runtime env files or CI secrets, not in Git.

## Dry Run

1. Create a fresh SQLite backup from the current production maintenance helper.
2. Create a staging Supabase branch with production data clone, or use a dedicated staging project.
3. Apply baseline/current migrations:

```bash
node deploy/scripts/supabase-branch.mjs migrate --postgres-url "$BRAI_DATABASE_URL"
```

4. Import SQLite into the staging branch:

```bash
node deploy/scripts/import-sqlite-to-postgres.mjs \
  --sqlite /path/to/brai.sqlite.backup \
  --postgres-url "$BRAI_DATABASE_URL" \
  --truncate true
```

5. Smoke the imported database:

```bash
node deploy/scripts/postgres-smoke.mjs "$BRAI_DATABASE_URL" --expect-imported
```

6. Compare row counts and key invariants for auth users/sessions, event logs, read models, version ledger, deployment records, agents/schedules, `ai_logs`, `build_version_counters`, and `sequence_counters`.

## Production Maintenance Window

1. Announce the maintenance window and stop all writers: `brai-api.service`, scheduler/agent jobs, and accepted deployment writes.
2. Create the final SQLite backup.
3. Apply migrations to production Supabase:

```bash
node deploy/scripts/supabase-branch.mjs migrate --postgres-url "$BRAI_DATABASE_URL"
```

4. Import the final SQLite backup into production Supabase with `--truncate true`.
5. Run Postgres smoke with `--expect-imported`.
6. Update `/etc/brai/brai-api.env` to set `BRAI_DATABASE_URL` and `BRAI_DATA_STORE=postgres`.
7. Restart API/scheduler and smoke `/health`, auth/session, timer sync, activities sync, inbox/inbound, and `/v1/version`.
8. Reopen writes only after smoke passes.
9. Keep the old SQLite file as a read-only frozen snapshot. Rollback without reverse-sync is allowed only before new Postgres writes are opened.

## Preview And Dev

- Preview slots create or reuse a Supabase branch named from the `codex/*` branch, with production data clone.
- Preview branch metadata in `preview-slots.json` stores only branch name/id/status, never DSNs.
- Slot release deletes or pauses the Supabase preview branch together with the preview slot.
- Dev uses one long-lived protected Supabase branch `brai-dev`; it receives migrations/deploys but no automatic production refresh.
