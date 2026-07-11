# Resolve Operation Backlog 2026-07-11

## Summary

Resolve the verified runtime and delivery problems recorded as open Codex
operations, remove the retired preview status site, and close every operation
only after its remediation or obsolescence is verified in the live target.

## Capabilities

- Keep agent delivery, acceptance, operation completion, and worktree tooling observable and recoverable.
- Keep PostgreSQL, Temporal, Vault, ADR publication, Codex, and helper runtime contracts reproducible.
- Send branded email without CID attachments.
- Remove the preview status HTTP surface while retaining the internal preview-slot registry.

## Remaining Scope Verified 2026-07-11

The runtime ledger contains 11 open Codex operations. Ten are actionable and
one (`operation:agent-task:temporal-supabase-docker-network`) duplicates the
canonical Temporal/Supabase network operation. The remaining work is split
into independently verifiable delivery units:

1. rotate the exposed runtime secrets;
2. restore and harden the delivery control plane (installed guard and the
   Temporal/Supabase Docker network);
3. make no-preview handoff idempotent after merge and preserve remote helper
   payloads exactly;
4. fix production deploy permissions, API shutdown, and atomic APK rollback;
5. enforce public email-image validation before an email template is shipped.

An operation remains open until its own live acceptance checks pass. A healthy
service at one instant is not evidence that restart or self-healing behavior is
durable.

## Delivery Guard

This change includes runtime/product email behavior and therefore must finish
through the preview delivery flow. Host remediation is applied only through
protected runtime boundaries and is verified separately before related
operations are closed.
