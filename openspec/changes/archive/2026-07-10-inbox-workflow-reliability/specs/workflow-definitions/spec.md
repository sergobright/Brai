## ADDED Requirements

### Requirement: Persisted queued executions are durably dispatched
Brai SHALL treat every committed queued workflow execution as a durable request
to start the corresponding Temporal workflow.

#### Scenario: Immediate start callback is lost
- **WHEN** Inbox ingest commits a queued execution but the in-process start callback fails or is not reached
- **THEN** a non-overlapping periodic reconciler discovers the queued execution
- **AND** it starts or reuses the Temporal workflow by stable workflow ID
- **AND** it stores the resulting run ID
- **AND** repeated reconciliation does not create duplicate domain mutations or AI calls

#### Scenario: API process starts
- **WHEN** the Brai API worker becomes ready
- **THEN** startup recovery and periodic recovery use the same idempotent dispatch operation
- **AND** queued records created after startup remain recoverable without another service restart

### Requirement: Persisted running executions are durably terminalized
Brai SHALL reconcile the compact Inbox workflow read model from durable Temporal
closure and persisted domain truth across API process restarts.

#### Scenario: Process restarts while a workflow is running
- **WHEN** the database contains a `running` Inbox execution after API startup
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
- **THEN** Brai compares that closure with the persisted normalized Inbox domain result
- **AND** only a completed Temporal execution with a linked normalized role becomes local `completed`
- **AND** every other closed state becomes local `failed` with a bounded reason
- **AND** a late Activity cannot revive an already terminal failed execution

### Requirement: Operational log mirrors do not own domain success
Brai SHALL keep ordinary technical log persistence outside committed Inbox domain
success and outside the atomic normalization apply transaction.

#### Scenario: Ingest log mirror fails
- **WHEN** raw Inbox data, its event, and queued execution have committed successfully
- **AND** the following ordinary `logs` insert fails
- **THEN** the accepted ingest result remains successful
- **AND** durable workflow dispatch still proceeds
- **AND** the service reports the logging failure through its process logger

#### Scenario: Apply log mirror fails
- **WHEN** normalized entity, role, Inbox link, domain event, and execution status commit successfully
- **AND** the following ordinary `logs` insert fails
- **THEN** the committed domain result is not rolled back or repeated
- **AND** the service reports the logging failure separately
