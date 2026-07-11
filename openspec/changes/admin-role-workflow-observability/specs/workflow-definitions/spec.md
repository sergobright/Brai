# workflow-definitions Delta

## ADDED Requirements

### Requirement: Workflow definitions include structured process JSON
Brai SHALL store structured workflow process data in
`workflow_definitions.process_json` and use it as the Admin diagram source.

#### Scenario: Existing workflow versions are migrated
- **WHEN** the observability migration runs
- **THEN** every existing workflow definition version has valid `process_json`
- **AND** the old Mermaid source remains available only for compatibility
- **AND** Admin generates orchestration, data, and error/retry diagrams from
  `process_json`

### Requirement: Workflow executions record bounded step telemetry
Brai SHALL persist step-level execution telemetry in Postgres without storing
user content or raw AI output.

#### Scenario: A workflow step runs successfully
- **WHEN** a workflow step starts and completes
- **THEN** one `workflow_execution_steps` row records the step key, attempt,
  running/completed status, duration, and technical correlation metadata

#### Scenario: A workflow step retries or skips
- **WHEN** a workflow retries the same step
- **THEN** the retry is recorded with the next attempt number
- **WHEN** a conditional branch is skipped
- **THEN** a skipped step row is recorded with a technical skip reason

#### Scenario: Telemetry write fails
- **WHEN** step telemetry cannot be written
- **THEN** the domain mutation result is not rolled back
- **AND** the execution trace becomes `partial` when terminal reconciliation
  observes missing expected telemetry
- **AND** a compact technical log records the telemetry problem

### Requirement: Admin exposes workflow process, runs, and definition views
Brai Admin SHALL expose each workflow as a read-only workspace with process,
runs, and definition tabs.

#### Scenario: Operator opens a workflow deep link
- **WHEN** an operator opens
  `/admin?section=workflows&workflow=inbox.raw-normalization&version=3&tab=process`
- **THEN** Admin restores the selected workflow/version and process tab
- **AND** the process tab can switch between orchestration, data, and error/retry
  diagrams generated from one `process_json`

#### Scenario: Operator opens a run
- **WHEN** an operator selects a workflow run
- **THEN** Admin shows actual-path diagram, timeline, attempts, bounded retry or
  error reason, AI log references, changed entity references, terminal result,
  and trace completeness
- **AND** legacy runs without telemetry are explicitly marked unavailable

### Requirement: Admin reads worker health from Postgres heartbeats
Brai Admin SHALL classify worker health from `workflow_worker_heartbeats`
without connecting to Temporal.

#### Scenario: Worker heartbeat is stale
- **WHEN** the latest heartbeat for a workflow task queue is older than 30
  seconds and not older than 120 seconds
- **THEN** Admin shows `stale`
- **WHEN** the latest heartbeat is older than 120 seconds or missing
- **THEN** Admin shows `offline`
