# role-contracts Specification

## Purpose
TBD - created by archiving change agent-role-normalization-workflows. Update Purpose after archive.
## Requirements
### Requirement: Role contracts define every role type
Brai SHALL maintain a role contract for every role type used by agents or workflows.

#### Scenario: A role type participates in a workflow
- **WHEN** a role type is used by an agent or workflow
- **THEN** a role contract exists for that role type
- **AND** the contract describes the role key, payload table, link column, lifecycle, workflow, schemas, and owner

### Requirement: Role contracts are agent context
Brai SHALL make role contracts available as structured context for future agents.

#### Scenario: An agent reasons about a role
- **WHEN** an agent needs role lifecycle or payload rules
- **THEN** it can read the role contract as structured context
- **AND** it does not infer lifecycle rules from table names alone

### Requirement: Role contracts are visible in Admin
Brai Admin SHALL expose role contracts as read-only operational metadata.

#### Scenario: An operator reviews role contracts
- **WHEN** the operator opens the Admin role contracts view
- **THEN** Admin shows each role contract with linked role type, payload table, workflow, status model, schema versions, and event rules
- **AND** Admin does not mutate role contracts unless a future change explicitly makes editing supported

### Requirement: New role types require contracts
Brai SHALL treat a role type without a contract as incomplete for agent/workflow use.

#### Scenario: A new role type is introduced
- **WHEN** a change introduces a new role type
- **THEN** the same change includes a role contract
- **AND** agents/workflows do not treat the role type as valid until the contract exists
