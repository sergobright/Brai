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
Brai SHALL support `POST /v1/` for the default Inbox connector and SHALL persist a raw Inbox role record before scheduling AI normalization.

#### Scenario: Inbox payload is received
- **WHEN** an external app sends text with the Inbox API key
- **THEN** the text is stored in `inbox.explanation_text`
- **AND** optional description content is stored in `inbox.description_text`
- **AND** optional legacy `image_base64`/`image_mime` or `attachments[]` files are saved as attachments
- **AND** each attachment path is stored in the Inbox attachment links
- **AND** the response state includes the new raw Inbox record before AI processing completes
- **AND** the response does not require `items` or `item_roles` to exist yet

#### Scenario: Inbox payload includes metadata
- **WHEN** an external app sends optional `source`, `source_key`, `response_required`, `record_type_id`, or `idempotency_key`
- **THEN** supported metadata is stored on the raw Inbox record
- **AND** repeated requests with the same `idempotency_key` and payload do not create duplicate Inbox records or duplicate workflows
- **AND** repeated requests with the same `idempotency_key` and different payload fail explicitly
- **AND** Inbox API accepts record type `1` for human API Inbox writes and `2` for agent API Inbox writes

#### Scenario: Inbox payload asks to attach to the previous message
- **WHEN** an external app sends text that asks to attach the data to the previous message
- **THEN** the API still creates a new raw Inbox record
- **AND** the new record stores a reference to the previous Inbox record from the same source key or source

#### Scenario: Inbox request is unauthorized
- **WHEN** an Inbox request omits the valid Inbox API key
- **THEN** the API returns `401`
- **AND** no Inbox data, workflow, event, log, item, role, or attachment file is created

### Requirement: Inbox AI processing normalizes saved records
Brai SHALL process newly saved Inbox records asynchronously through the normalization workflow.

#### Scenario: Image attachments are present
- **WHEN** a saved Inbox record has image attachments that require visual description
- **THEN** `inbox.image_describer` describes the images
- **AND** an `ai_logs` row is written for each real image agent execution
- **AND** the image description becomes input to the structured normalization step

#### Scenario: Image attachments are absent or unnecessary
- **WHEN** a saved Inbox record has no image attachments requiring visual description
- **THEN** the workflow skips `inbox.image_describer`
- **AND** the rest of normalization can continue

#### Scenario: Record is normalized
- **WHEN** a saved Inbox record is processed
- **THEN** `inbox.normalizer` reads `explanation_text`, `description_text`, image description when present, and `inbox_classes`
- **AND** it returns structured JSON with title, user-facing description, preliminary type, and normalization text
- **AND** it does not directly mutate `inbox`, `items`, `item_roles`, or events
- **AND** the apply script writes the final title, description, preliminary type, entity, role, events, and logs
- **AND** an `ai_logs` row is written for each real normalizer execution

#### Scenario: No class fits
- **WHEN** the normalizer proposes a class key that is not in `inbox_classes`
- **THEN** Brai creates or records a candidate class for later review through the apply/mutation path
