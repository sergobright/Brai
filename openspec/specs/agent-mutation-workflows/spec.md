# agent-mutation-workflows Specification

## Purpose
Define how AI executions produce validated structured results while deterministic, idempotent workflow activities own domain mutations and retry rules.

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

### Requirement: Workflow apply owns the normalization transition
Brai SHALL allow a raw role record to become normalized and entity-linked only through the accepted workflow mutation activity.

#### Scenario: A client submits a direct normalization event
- **WHEN** an API or sync client submits a normalization mutation for a raw role record
- **THEN** Brai rejects or ignores that mutation
- **AND** no item, role, or normalized state is created outside the workflow apply activity

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

### Requirement: Goal planning has one unresolved proposal per Goal
Brai SHALL keep at most one queued, running, or pending review-only Goal plan for one user and Goal.

#### Scenario: Goal plan request is repeated
- **WHEN** the user requests a plan while the same Goal already has queued, running, or pending plan work
- **THEN** the API returns the existing workflow execution using the current response shape
- **AND** a changed Activity revision does not create another plan

#### Scenario: Concurrent Goal plan requests arrive
- **WHEN** multiple plan requests for the same user and Goal race
- **THEN** transaction locking and a partial unique pending-decision index preserve one unresolved plan

#### Scenario: Historical pending plans are reconciled
- **WHEN** a migration finds multiple pending `goal_plan` decisions for one user and Goal
- **THEN** the newest remains `pending`
- **AND** older decisions become `stale_context`

#### Scenario: Previous Goal plan is resolved
- **WHEN** the user accepts or rejects the pending Goal plan
- **THEN** a later explicit request may create a new workflow execution
