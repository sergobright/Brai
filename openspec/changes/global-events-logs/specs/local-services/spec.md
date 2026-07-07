## ADDED Requirements

### Requirement: Runtime events use one canonical ledger
Brai SHALL store runtime timer, activity, and inbox sync receipts in a single
Postgres `events` table.

#### Scenario: Domain sync writes an accepted event
- **WHEN** a timer, activity, or inbox sync endpoint accepts a client event
- **THEN** the row is stored in `events`
- **AND** `event_domain` identifies the source domain
- **AND** `domain_sequence` advances the domain revision returned to existing clients

#### Scenario: Domain sync ignores an event
- **WHEN** a sync event is rejected as invalid, duplicate, malformed, or too far in the future
- **THEN** the ignored receipt is stored in `events` with `status = 'ignored'`
- **AND** a technical explanation is stored in `logs`
- **AND** accepted replay excludes the ignored row

### Requirement: Technical logs exclude AI outputs
Brai SHALL store technical runtime summaries in `logs` without secrets or AI
outputs.

#### Scenario: AI agent writes a result
- **WHEN** a runtime AI agent writes an `ai_logs` row
- **THEN** `logs` stores only the invocation fact and correlation metadata
- **AND** the AI output remains only in `ai_logs`

#### Scenario: Log retention runs
- **WHEN** the scheduler runner starts
- **THEN** expired `logs` rows are purged
- **AND** `events` and `ai_logs` are not purged by that retention step
