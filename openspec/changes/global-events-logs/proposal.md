# Global Events And Logs

## Summary

Replace runtime reads/writes of the separate timer, activity, and inbox event
logs with one canonical `events` table, and add a retained technical `logs`
table for operational investigation.

## Capabilities

- Store timer, activity, and inbox sync receipts in `events` with domain-local
  sequence numbers for existing client revisions.
- Keep ignored sync events durable in `events` for idempotency while also
  recording technical explanations in `logs`.
- Store request, sync, scheduler, Brai Cmd, and AI invocation summaries in
  `logs` without secrets or AI outputs.
- Keep AI inputs/outputs in `ai_logs`, correlated by optional `trace_id`.

## Rationale

Brai now has multiple event-log tables and sparse technical observability. A
single canonical event ledger keeps replay behavior consistent while a retained
technical log table gives future investigations one place to start.

## Delivery Guard

This is a runtime/product change because it changes server schema, API storage,
and runtime logging. It must pass API and OpenSpec checks and finish through the
preview delivery flow.
