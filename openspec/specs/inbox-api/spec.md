# inbox-api Specification

## Purpose

This specification defines the stable external Inbox API shape for connector-style writes into Brai.

## Requirements

### Requirement: Inbox API routes by target
Brai SHALL expose a universal Inbox API at `/v1/` where omitted destination defaults to `inbox`, and explicit destination can be selected by request body `target`/`destination`, header `X-Brai-Target`/`X-Brai-Destination`.

#### Scenario: Inbox target handshakes
- **WHEN** an external app sends `GET /v1/` with the Inbox API key
- **THEN** the API returns `{ "ok": true, "target": "inbox" }`

#### Scenario: Unknown target is requested
- **WHEN** an external app sends a request for an unsupported target
- **THEN** the API returns `404`
- **AND** no Inbox data is mutated

### Requirement: Inbox receives text and attachments before AI processing
Brai SHALL support `POST /v1/` for the default Inbox connector and SHALL persist the Inbox record before scheduling AI processing.

#### Scenario: Inbox payload is received
- **WHEN** an external app sends text with the Inbox API key
- **THEN** the text is stored in `inbox.explanation_text`
- **AND** optional description content is stored in `inbox.description_text`
- **AND** optional legacy `image_base64`/`image_mime` or `attachments[]` files are saved as attachments
- **AND** each attachment path is stored in the Inbox attachment links
- **AND** the response state includes the new Inbox item before AI processing completes

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

### Requirement: Inbox AI processing normalizes saved records
Brai SHALL process newly saved Inbox records asynchronously through image description and normalization agents.

#### Scenario: Image attachments are present
- **WHEN** a saved Inbox record has image attachments
- **THEN** `inbox.image_describer` describes the images
- **AND** the description is stored through a `normalize` event in `normalization_text`
- **AND** an `ai_logs` row is written for the image agent

#### Scenario: Record is normalized
- **WHEN** a saved Inbox record is processed
- **THEN** `inbox.normalizer` reads `explanation_text`, `description_text`, image description, and `inbox_classes`
- **AND** it writes a title, user-facing description, `preliminary_section`, `normalization_text`, and `is_normalized = true`
- **AND** it does not overwrite `explanation_text`
- **AND** an `ai_logs` row is written for the normalizer

#### Scenario: No class fits
- **WHEN** the normalizer proposes a class key that is not in `inbox_classes`
- **THEN** Brai creates a candidate class row for later review
