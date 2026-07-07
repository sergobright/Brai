## ADDED Requirements

### Requirement: Inbox API routes by target
Brai SHALL expose a universal Inbox API at `/v1/in/:target` where the target path segment selects the connector handler.

#### Scenario: Inbox target handshakes
- **WHEN** an external app sends `GET /v1/in/inbox` with the Inbox API key
- **THEN** the API returns `{ "ok": true, "target": "inbox" }`

#### Scenario: Unknown target is requested
- **WHEN** an external app sends a request for an unsupported target
- **THEN** the API returns `404`
- **AND** no Inbox data is mutated

### Requirement: Inbox receives text and attachments
Brai SHALL support `POST /v1/in/inbox` for the first Inbox connector.

#### Scenario: Inbox payload is received
- **WHEN** an external app sends text with the Inbox API key
- **THEN** the text is stored in the Inbox explanation field
- **AND** optional description content is stored in the Inbox description field
- **AND** optional legacy `image_base64`/`image_mime` or `attachments[]` files are saved as attachments
- **AND** each attachment path is stored in the Inbox attachment links
- **AND** the Inbox title uses a local fallback until AI processing updates it

#### Scenario: Inbox payload includes metadata
- **WHEN** an external app sends optional `source`, `source_key`, `response_required`, `record_type_id`, or `idempotency_key`
- **THEN** supported metadata is stored on the Inbox record
- **AND** repeated requests with the same `idempotency_key` do not create duplicate Inbox records
- **AND** Inbox API accepts record type `1` for human API Inbox writes and `2` for agent API Inbox writes

#### Scenario: Inbox payload asks to attach to the previous message
- **WHEN** an external app sends text that asks to attach the data to the previous message
- **THEN** the API still creates a new Inbox record
- **AND** the new record stores a reference to the previous Inbox record from the same source key or source

#### Scenario: Inbox request is unauthorized
- **WHEN** an Inbox request omits the valid Inbox API key
- **THEN** the API returns `401`
- **AND** no Inbox data or attachment file is created
