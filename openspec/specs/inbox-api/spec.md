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

#### Scenario: Agent operation payload is received
- **WHEN** an external app sends `record_type_id = 2`, `preliminary_section = operation`, and an `idempotency_key`
- **THEN** the raw Inbox record stores `preliminary_section = operation`
- **AND** missing `source_key` defaults to the idempotency key
- **AND** missing `idempotency_key`, non-agent record type, or another preliminary section fails explicitly

#### Scenario: Agent operation status is updated
- **WHEN** an external app sends `POST /v1/inbox/status` with the Inbox API key, operation idempotency key, and status `New` or `Done`
- **THEN** Brai updates only the matching operation Inbox row
- **AND** `Done` records a completion timestamp while `New` clears it
- **AND** repeated requests for the current status do not create duplicate status events

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

### Requirement: Text-only Inbox normalization uses the owner's selected inference mode
Brai SHALL normalize Inbox records through the installed Codex CLI in internal mode or
through the authenticated owner's verified external text profile in external mode while
preserving the workflow definition's versioned structured-output contract.

#### Scenario: Text-only record is normalized in internal mode
- **WHEN** a queued Inbox record has no image work and its owner uses internal mode
- **THEN** `inbox.normalizer` calls local `codex exec --ephemeral`
- **AND** the configured production default remains `gpt-5.4-mini`
- **AND** a workflow definition supporting strict CLI output passes its exact stored schema through `--output-schema`
- **AND** the call runs from an isolated temporary context with low reasoning and verbosity
- **AND** a narrow model instruction file replaces unrelated general coding-agent instructions
- **AND** no direct model-provider API bypasses Codex CLI

#### Scenario: Text-only record is normalized in external mode
- **WHEN** a queued Inbox record has no image work and its owner uses external mode
- **THEN** `inbox.normalizer` calls the owner's selected text provider and model
- **AND** the provider key comes only from the owner's encrypted credential
- **AND** the provider receives the stored workflow schema through its supported structured-output contract
- **AND** Brai does not use a project or server provider key

#### Scenario: Selected inference returns structured output
- **WHEN** Codex CLI or the selected external provider returns normalization output
- **THEN** Brai validates it against the exact stored schema for the pinned workflow definition
- **AND** title, description, class fields, and normalization text are locally validated before apply
- **AND** exactly one `ai_logs` row records each real inference attempt with mode, provider, model, status, attempt, and timings

#### Scenario: Selected inference fails
- **WHEN** Codex CLI or the selected external provider times out, rejects, refuses, is quota-limited, or returns unusable output
- **THEN** each real inference attempt is represented exactly once in `ai_logs`
- **AND** Brai does not apply partial normalized data
- **AND** the raw Inbox record remains intact
- **AND** the workflow reaches `needs_review` or `failed` with a bounded safe error after allowed attempts
- **AND** the UI does not continue to report an active AI operation indefinitely
- **AND** Brai does not switch inference modes or use a project or server provider key

#### Scenario: A legacy workflow execution resumes
- **WHEN** an execution pinned to an older workflow definition resumes
- **THEN** it keeps that definition's version, stored schema, and attempt behavior
- **AND** internal mode preserves isolated Codex execution and does not silently apply a later strict CLI schema contract to legacy v1
- **AND** external mode uses only the current owner's selected profile while validating against the pinned schema
- **AND** the execution is not silently relabeled as a newer workflow version
- **AND** newly created executions use the current owner-scoped workflow contract
- **AND** no inference call uses a project or server provider key

#### Scenario: Text-only latency is measured
- **WHEN** successful no-image Inbox workflows run in Preview
- **THEN** Brai measures latency from execution creation through completion
- **AND** at least 30 runs report p50, p90, p95, and p99
- **AND** about one second remains an optimization goal rather than an unmeasured release guarantee
- **AND** the configured timeout of the selected inference backend is the hard upper bound for each attempt
