# role-contracts Delta

## ADDED Requirements

### Requirement: Admin role contract workspace is explanatory and read-only
Brai Admin SHALL expose Role Contracts as a read-only workspace that explains
role meaning, storage, lifecycle, workflow ownership, events, schemas, and
diagnostics without mutation controls.

#### Scenario: Operator opens a role contract deep link
- **WHEN** an operator opens `/admin?section=role-contracts&role=inbox&tab=overview`
- **THEN** Admin restores the selected Inbox role and overview tab
- **AND** the view describes the role in Russian human-facing copy
- **AND** technical ids remain visible in monospace without translating them
- **AND** Admin provides no edit, retry, delete, or mutation action

#### Scenario: Role behavior is absent
- **WHEN** a role has no workflow or no optional event rule
- **THEN** Admin explains why that behavior is absent
- **AND** it does not render a bare dash as the only explanation

### Requirement: Role diagnostics report broken contract references
Brai Admin SHALL compute role health from contract references, workflow/schema
references, payload links, and orphan checks.

#### Scenario: Contract reference is missing
- **WHEN** a payload table, link column, role type, workflow definition,
schema, event type, or lifecycle status reference is missing
- **THEN** the role health is `broken`
- **AND** the Diagnostics tab names the failed check and reason

#### Scenario: Contract has only non-fatal missing runtime rows
- **WHEN** optional runtime data is absent but the static contract is valid
- **THEN** Admin shows a clear explanation
- **AND** the role is not marked broken solely because no rows exist yet

### Requirement: Role data links have diagram and table equivalents
Brai Admin SHALL show role data links as both a diagram and accessible table.

#### Scenario: Kroki cannot render the role diagram
- **WHEN** Kroki is unavailable or rejects the diagram source
- **THEN** Admin shows the data-link table
- **AND** Admin exposes the Mermaid source in a collapsed technical block
