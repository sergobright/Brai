# inbound-api Specification

## Purpose

This specification defines the stable external inbound API shape for connector-style writes into Brai.
## Requirements
### Requirement: Inbound API routes by target
Brai SHALL expose a universal inbound API at `/v1/` where omitted
destination defaults to `inbox`, and explicit destination can be selected by
request body `target`/`destination`, header `X-Brai-Target`/
`X-Brai-Destination`.

#### Scenario: Inbound target handshakes
- **WHEN** an external app sends `GET /v1/` with the inbound API key
- **THEN** the API returns `{ "ok": true, "target": "inbox" }`

#### Scenario: Unknown target is requested
- **WHEN** an external app sends a request for an unsupported target
- **THEN** the API returns `404`
- **AND** no inbox data is mutated

### Requirement: Inbound Inbox receives text and attachments
Brai SHALL support `POST /v1/` for the default inbound Inbox connector.

#### Scenario: Inbox payload is received
- **WHEN** an external app sends text with the inbound API key
- **THEN** the text is stored in the Inbox explanation field
- **AND** optional description content is stored in the Inbox description field
- **AND** optional legacy `image_base64`/`image_mime` or `attachments[]` files are saved as attachments
- **AND** each attachment path is stored in the Inbox attachment links
- **AND** the Inbox title is generated through the local Codex CLI or local fallback

#### Scenario: Inbox payload includes inbound metadata
- **WHEN** an external app sends optional `source`, `source_key`, `response_required`, `record_type_id`, or `idempotency_key`
- **THEN** supported metadata is stored on the Inbox record
- **AND** repeated requests with the same `idempotency_key` do not create duplicate Inbox records
- **AND** inbound API accepts record type `1` for human API inbound and `2` for agent API inbound

#### Scenario: Inbox payload asks to attach to the previous message
- **WHEN** an external app sends text that asks to attach the data to the previous message
- **THEN** the API still creates a new Inbox record
- **AND** the new record stores a reference to the previous Inbox record from the same source key or source

#### Scenario: Inbound request is unauthorized
- **WHEN** an inbound request omits the valid inbound API key
- **THEN** the API returns `401`
- **AND** no inbox data or attachment file is created
