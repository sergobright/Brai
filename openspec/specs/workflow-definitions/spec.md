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

#### Scenario: A user views a normalizable product record
- **WHEN** an Inbox or Activity record has a running or completed normalization workflow
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

### Requirement: Persisted queued executions are durably dispatched
Brai SHALL treat every committed queued workflow execution as a durable request
to start the corresponding Temporal workflow.

#### Scenario: Immediate start callback is lost
- **WHEN** Inbox ingest or Activity sync commits a queued execution but the in-process start callback fails or is not reached
- **THEN** a non-overlapping periodic reconciler discovers the queued execution
- **AND** it starts or reuses the Temporal workflow by stable workflow ID
- **AND** it stores the resulting run ID
- **AND** repeated reconciliation does not create duplicate domain mutations or AI calls

#### Scenario: API process starts
- **WHEN** the Brai API worker becomes ready
- **THEN** startup recovery and periodic recovery use the same idempotent dispatch operation
- **AND** queued records created after startup remain recoverable without another service restart

### Requirement: Persisted running executions are durably terminalized
Brai SHALL reconcile compact normalization workflow read models from durable Temporal
closure and persisted domain truth across API process restarts.

#### Scenario: Process restarts while a workflow is running
- **WHEN** the database contains a `running` Inbox or Activity execution after API startup
- **THEN** the reconciler observes the exact Temporal workflow ID and run ID
- **AND** repeated 500 ms passes keep at most one active observer per workflow/run pair
- **AND** terminal persistence failure is retried on a later pass

#### Scenario: Completion observer loses transport
- **WHEN** a result observer fails because the Temporal connection or process is closing
- **THEN** Brai does not infer that the workflow itself failed
- **AND** the database execution remains `running`
- **AND** a later reconciliation pass observes it again

#### Scenario: Temporal execution closes
- **WHEN** the observed Temporal execution resolves or reaches failed, cancelled, terminated, timed-out, or missing state
- **THEN** Brai compares that closure with the persisted normalized domain result
- **AND** only a completed Temporal execution with a linked normalized role becomes local `completed`
- **AND** every other closed state becomes local `failed` with a bounded reason
- **AND** a late Activity cannot revive an already terminal failed execution

### Requirement: Operational log mirrors do not own domain success
Brai SHALL keep ordinary technical log persistence outside committed normalized domain
success and outside the atomic normalization apply transaction.

#### Scenario: Ingest log mirror fails
- **WHEN** raw Inbox or Activity data, its event, and queued execution have committed successfully
- **AND** the following ordinary `logs` insert fails
- **THEN** the accepted ingest result remains successful
- **AND** durable workflow dispatch still proceeds
- **AND** the service reports the logging failure through its process logger

#### Scenario: Apply log mirror fails
- **WHEN** normalized entity, role, source-record link, domain event, and execution status commit successfully
- **AND** the following ordinary `logs` insert fails
- **THEN** the committed domain result is not rolled back or repeated
- **AND** the service reports the logging failure separately
