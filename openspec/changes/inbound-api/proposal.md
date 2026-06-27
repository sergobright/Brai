# Universal Inbound API

## Summary

Add a short external inbound API where the connector target is selected by the
URL path. The first implemented target is `inbox`.

## Capabilities

- `GET /v1/in/:target` performs a Bearer-protected handshake.
- `POST /v1/in/:target` receives external JSON payloads.
- `inbox` stores text as `explanation_text`, optional text/JSON content as
  `description_text`, stores whitelisted image/file attachments on disk,
  records attachment paths in `attachment_links`, stores source metadata and
  record type, and generates a short title through the local Codex CLI with a
  local fallback.

## Rationale

External apps need one stable API shape that can grow from Inbox to future
targets such as finance without redesigning route structure.
