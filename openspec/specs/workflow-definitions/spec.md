# workflow-definitions Specification

## Purpose
Define versioned product workflow definitions, Temporal orchestration boundaries, persisted execution status, and diagrams derived from process data.

## Requirements
### Requirement: Workflow definitions are process source of truth
Brai SHALL treat workflow definitions as the source of truth for agent/data processes.

#### Scenario: A process changes
- **WHEN** a future change modifies how agent/data processing works
- **THEN** the workflow definition or workflow spec is updated first
- **AND** implementation follows the accepted workflow version

### Requirement: Workflow definitions are versioned
Brai SHALL version workflow definitions and agent JSON schemas.

#### Scenario: A workflow execution starts
- **WHEN** Brai starts a workflow execution
- **THEN** the execution is tied to the workflow definition version and JSON schema versions active at start time
- **AND** later workflow changes do not silently change the meaning of that running execution

### Requirement: Temporal orchestrates product workflows
Brai SHALL use Temporal to orchestrate product agent/data workflows.

#### Scenario: A product workflow performs external work
- **WHEN** a product workflow needs database, API, file, or LLM side effects
- **THEN** those effects run in Temporal Activities
- **AND** workflow logic remains deterministic

#### Scenario: Product workflows are added beside deployment workflows
- **WHEN** product workflows are implemented
- **THEN** they use task queue separation from preview/promotion workflows when needed
- **AND** they do not break existing preview/promotion workflow behavior

### Requirement: Workflow status is visible
Brai SHALL expose compact workflow status for product UI and richer details for Admin.

#### Scenario: A user views an Inbox record
- **WHEN** the record has a running or completed normalization workflow
- **THEN** the product UI can read compact status from a database read model
- **AND** the product UI does not depend on expensive per-row Temporal history polling

#### Scenario: An operator investigates workflow execution
- **WHEN** the operator opens Admin workflow details
- **THEN** Admin can show workflow id, run id, steps, status, attempts, and errors when available

### Requirement: Workflow diagrams are rendered from definitions
Brai Admin SHALL render workflow diagrams from workflow definition data.

#### Scenario: A workflow definition is visible in Admin
- **WHEN** Admin displays a workflow definition
- **THEN** it renders a Mermaid diagram through Kroki from stored workflow definition data
- **AND** the diagram is not hand-maintained separately from the workflow definition

### Requirement: Docker sandboxes are excluded from v1
Brai SHALL not include agent execution Docker Sandboxes in this v1 workflow architecture.

#### Scenario: An agent workflow executes in v1
- **WHEN** the workflow calls AI agents
- **THEN** it does not require Docker Sandbox execution
- **AND** a future OpenSpec change may introduce Docker Sandboxes for tool-running agents
