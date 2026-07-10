# agent-mutation-workflows Specification

## Purpose
TBD - created by archiving change agent-role-normalization-workflows. Update Purpose after archive.
## Requirements
### Requirement: Agents do not mutate domain tables directly
Brai AI agents SHALL return structured JSON instead of directly mutating domain tables.

#### Scenario: An agent finishes processing a record
- **WHEN** an AI agent produces a result for domain data
- **THEN** the result is structured JSON
- **AND** the agent does not create, update, or delete `items`, `item_roles`, events, or role-table records directly
- **AND** domain mutations are performed by mutation scripts or Temporal Activities

### Requirement: New raw records are normalized through workflow
Brai SHALL normalize new raw records through a workflow before they become entity-linked records.

#### Scenario: A raw record is processed successfully
- **WHEN** ingest creates a raw role record
- **THEN** the normalizer transforms raw content into validated JSON
- **AND** apply creates the item, role, events, and logs

### Requirement: AI logs record real AI executions
Brai SHALL write one `ai_logs` row for every actual AI execution.

#### Scenario: An AI execution succeeds
- **WHEN** an agent call returns a usable result
- **THEN** Brai writes one `ai_logs` row for that execution

#### Scenario: An AI execution fails
- **WHEN** an agent call fails or returns invalid output
- **THEN** Brai writes one `ai_logs` row for that failed execution
- **AND** retry count is based on real AI executions, not non-AI script attempts

### Requirement: Validation errors can retry the agent
Brai SHALL retry AI normalization for schema validation failures with structured error context.

#### Scenario: Agent JSON fails validation
- **WHEN** the agent output fails the expected JSON schema
- **THEN** the validation error is passed into the next agent attempt as context
- **AND** Brai retries until success or three consecutive validation failures

#### Scenario: Validation failures reach the limit
- **WHEN** three consecutive validation failures occur for the same normalization step
- **THEN** Brai stops calling the agent
- **AND** the workflow records a failed or `needs_review` state

### Requirement: Business errors do not retry the agent
Brai SHALL not trigger another LLM call for DB or business-rule failures.

#### Scenario: Apply fails with a business error
- **WHEN** a DB/business failure occurs after validated agent output
- **THEN** Brai records failure state and logs
- **AND** Brai does not ask the LLM to retry the same decision

### Requirement: Mutation scripts are idempotent
Brai mutation scripts SHALL be safe to repeat with the same operation input.

#### Scenario: The same mutation is repeated
- **WHEN** a Temporal Activity or caller repeats the same mutation with the same operation identity and payload
- **THEN** Brai returns the existing result or completes without duplicating items, roles, events, or logs

#### Scenario: A repeated mutation conflicts
- **WHEN** the same operation identity is reused with a different payload
- **THEN** Brai fails explicitly with a conflict instead of silently changing the prior result
