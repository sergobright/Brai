# Inbox Workflow Reliability

## Why

Preview data copy inserted production IDs without advancing owned sequences. A
subsequent technical log insert could fail after Inbox ingest committed, prevent
the Temporal start callback, and leave `AI-working` visible forever. The required
local Codex CLI text normalizer also loaded unrelated repository context and did
not pass its stored schema through the supported structured-output option.

## What Changes

- Keep copied preview identity sequences ahead of copied production IDs and fail
  deployment readiness when sequence state is unsafe.
- Treat a committed queued workflow execution as a durable dispatch obligation
  and continuously reconcile both queued and running Temporal state, not only at
  API startup.
- Keep non-domain technical logging from breaking an already committed Inbox
  ingest or rolling back a successful domain apply transaction.
- Normalize Inbox records without image work through the installed local Codex CLI
  with versioned output schema, isolated context, bounded latency, and explicit
  terminal failure.
- Preserve the definition/schema version pinned to an execution instead of
  silently relabelling in-flight v1 work as v2.

## Delivery Guard

This is a runtime/product change. It must pass Postgres copy, API, Temporal,
OpenSpec, and live preview verification and finish through the preview flow.
