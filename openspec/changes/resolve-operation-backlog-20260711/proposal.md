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

## Delivery Guard

This change includes runtime/product email behavior and therefore must finish
through the preview delivery flow. Host remediation is applied only through
protected runtime boundaries and is verified separately before related
operations are closed.
