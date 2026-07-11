## ADDED Requirements

### Requirement: Operation remediation is evidence-backed
Brai SHALL close a Codex operation only after the live target proves the issue
is resolved or the owning capability has been deliberately retired.

#### Scenario: Operation is completed
- **WHEN** remediation or retirement checks pass
- **THEN** the deploy-owned completion helper marks the matching operation Done
- **AND** operation type and Codex authorship remain mandatory trust checks

### Requirement: Preview slots have no status website
Brai SHALL keep the internal preview-slot registry without publishing a preview
status HTML page or dedicated preview-status domain.

#### Scenario: Slot state changes
- **WHEN** a slot is allocated, updated, or released
- **THEN** the JSON registry is updated under its existing lock
- **AND** no status HTML is generated
