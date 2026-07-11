# Design

## Admin information architecture

The `/admin` page remains a server-rendered Next.js route. The main rail stays
compact, and Role Contracts / Workflows replace the old metadata card column
with a context navigator. The selected object, tab, diagram mode, execution
run, filters, and cursor live in query parameters so refresh and direct links
restore the same workspace.

Visible operator copy is Russian. Technical identifiers stay untranslated and
monospace. Missing behavior is explained with text instead of dashes. Admin
renders read-only links, forms, filters, tables, and details only; it does not
add retry, cancel, restart, edit, or mutation controls.

## Structured workflow definition

`workflow_definitions.process_json` is JSONB and contains lanes, steps, edges,
and terminals. The existing `diagram_mermaid` column remains a compatibility
field, but Admin diagrams are generated from `process_json`.

The migration backfills all existing `inbox.raw-normalization` versions:

- v1 preserves the original ingest, normalizer, apply process.
- v2 adds Temporal dispatch, optional image branch, and terminal reconcile.
- v3 is the active strict-schema local Codex CLI workflow and describes API,
  Postgres, Temporal, worker, local Codex CLI, and domain apply lanes.

The Inbox normalizer remains local `/srv/opt/codex-cli/bin/codex`; this change
does not add Groq or any direct provider API path to Inbox normalization.

## Runtime telemetry

`workflow_execution_steps` records one row per workflow execution, step key, and
attempt. Each row stores status, start/end/duration, activity type, agent id,
optional `ai_logs` link, bounded error fields, and technical metadata. Retry
uses a new attempt number. Skips are explicit rows. Telemetry failures are
logged as compact technical summaries and must not roll back domain mutation.

`workflow_executions.trace_status` distinguishes legacy `unavailable`, active
`recording`, terminal `complete`, and terminal `partial` traces.

`workflow_worker_heartbeats` is updated by runtime workers every 10 seconds.
Admin classifies worker health as online, stale, or offline from Postgres
heartbeats and never connects to Temporal.

## Admin read models

Admin reads Postgres server-side through `BRAI_DATABASE_URL` and splits data into
read models for role catalog/detail, workflow catalog/detail, paginated
executions, and selected execution timeline. Catalog queries aggregate role
counts, workflow 24h metrics, stuck status, and worker health up front. Detail
payload is only expanded for the selected object.

Execution rows are cursor-paginated by `(updated_at_utc, id)` with a page size of
50. Active execution views refresh through `router.refresh()` while the tab is
visible; terminal views use slower refresh or manual navigation.

## Diagram rendering and fallback

The server generates Mermaid from `process_json` for orchestration, data, and
error/retry modes. Selected execution diagrams use the same process and overlay
actual step statuses from telemetry. Kroki returns SVG data URLs. If Kroki is
unavailable, Admin shows the equivalent step table and Mermaid source.

Diagram controls are native buttons for zoom in/out, fit, reset, and fullscreen.
The visual surface is scrollable in both axes and remains usable on desktop and
mobile without adding a graph/canvas dependency.

## Privacy and safety

Telemetry and DTOs may include workflow ids, run ids, attempt numbers, status,
duration, bounded error summaries, agent ids, table names, and correlation ids.
They must not include prompts, raw user text, images, full model output,
stdout/stderr, cookies, tokens, passwords, private keys, or connection strings.
