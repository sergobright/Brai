# Agent Role Normalization Workflows Follow-up

## Summary

Repair the shipped Inbox normalization workflow so raw user input is preserved,
workflow steps report actual execution state, and Preview/Dev authentication
keeps an explicit user gesture instead of creating a session on page load.

## Capabilities

- Preserve immutable raw Inbox text and provenance before normalization.
- Reject semantically empty normalization input without invoking Codex CLI.
- Expose actual completed, running, failed, skipped, and pending workflow steps.
- Keep Preview/Dev email-only login and production OTP login consistent across
  web and Android.
- Continue using only the local Codex CLI for Inbox normalization.

## Delivery Guard

This is a runtime/product follow-up on the unaccepted
`codex/agent-role-normalization-workflows` preview branch. It must use the same
frozen task base, pass API/client/OpenSpec checks, and finish through a new
verified Preview A handoff.
