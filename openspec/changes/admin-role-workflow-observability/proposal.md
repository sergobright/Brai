# Admin Role/Workflow Observability

## Summary

Replace the technical card-grid Admin views for Role Contracts and Workflows with
a read-only operator workspace that explains role contracts, structured workflow
definitions, runtime health, execution traces, and failure/retry state.

## Capabilities

- Keep Admin strictly read-only while preserving URL-addressable selected role,
  workflow, tab, mode, and execution state.
- Show role purpose, payload storage, lifecycle, data links, workflow ownership,
  schemas, events, diagnostics, and health in Russian operator-facing copy.
- Store workflow `process_json` as the source for orchestration, data, and
  error/retry diagrams instead of hand-maintained Mermaid variants.
- Record bounded workflow step telemetry and worker heartbeats in Postgres for
  Admin read models without connecting Admin directly to Temporal.
- Render large SVG diagrams through local Kroki with a textual table/source
  fallback when rendering is unavailable.
- Expose cursor-paginated execution lists and selected execution timelines
  without showing prompts, raw user payload, images, model output, stdout/stderr,
  secrets, or credentials.

## Delivery Guard

This is runtime/product work and must finish through the parent Brai preview
flow. It does not edit or resolve the unrelated active `global-events-logs`
change.
