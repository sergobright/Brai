## MODIFIED Requirements

### Requirement: Task branches deploy through preview slots
Agents working on ordinary Brai task branches SHALL use preview slots and SHALL keep branch data cleanup inside the required lifecycle.

#### Scenario: Preview branch is accepted or deleted
- **WHEN** a `codex/*` preview branch is accepted, abandoned, or deleted
- **THEN** its preview schema is removed
- **AND** its branch-scoped API test schemas are removed
- **AND** legacy unscoped test schemas older than the safety window are removed
- **AND** the preview slot is released only after those deletions succeed
- **AND** deletion failure keeps the workflow non-terminal and blocked for repair

#### Scenario: Previously accepted preview is recovered
- **WHEN** production delivery finds an accepted preview that still owns a slot or queue entry
- **THEN** cleanup failure fails production delivery instead of being ignored
