# Design

## Delivery Gates

Accepted preview cleanup remains best-effort only for stale cleanup branches.
The required accepted branch path must set `BRAI_REQUIRE_PREVIEW_SLOT_RELEASE`
so `released=false` fails the workflow.

Delivery classification failures on `codex/*` pushes are signaled to Temporal
as `delivery_classification_failed` before the job fails.

Deploy script test files are technical no-preview work.

## Database Preview Safety

Postgres smoke checks inspect `current_schema()` and validate required tables,
seed rows, RLS trigger/function, and RLS coverage in that active schema.

`SUPABASE_BRANCH_DATABASE_URL` is denied by default. It is allowed only with an
explicit override env for dry-run/test flows and must include an expected
preview/dev branch marker in the connection string.

Preview seed conflicts restore every deterministic marker field.

## API And Android

CORS keeps trusted app, dev, preview, Capacitor, and local origins working. A
request without `Origin` keeps normal CLI/mobile/server behavior. Untrusted
browser origins no longer receive wildcard CORS headers on JSON API responses.

`/health` exposes only safe deployment metadata: Postgres dialect, Supabase
branch marker, branch, and commit.

Android disables platform backup for v1 instead of adding a larger credential
storage migration.
