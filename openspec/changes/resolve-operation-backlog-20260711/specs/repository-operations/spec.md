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

### Requirement: No-preview handoff tolerates deleted merged branches
Brai SHALL treat an exact merged PR head SHA as a successful no-preview
handoff even if the remote head branch no longer exists.

#### Scenario: GitHub deletes the branch after merge
- **WHEN** handoff is retried for the exact head SHA of an already merged PR
- **THEN** the workflow records the merged delivery receipt
- **AND** it does not fetch the deleted head ref

### Requirement: Remote operation payload is preserved
Brai SHALL transport operation title, reason, and description across SSH
without shell interpolation.

#### Scenario: Payload contains shell syntax and Unicode
- **WHEN** an operation includes spaces, Russian text, quotes, newlines, or
  shell metacharacters
- **THEN** the runtime receives the exact strings
- **AND** none of the payload is executed as a command

### Requirement: APK metadata publication is atomic
Brai SHALL publish release JSON and rendered HTML as one validated,
deploy-owned metadata update.

#### Scenario: Rendering or permission normalization fails
- **WHEN** the next release index cannot be fully rendered or permissioned
- **THEN** the previously published JSON and HTML remain unchanged

### Requirement: Email image publication is verified
Brai SHALL reject an email-template delivery when an external image URL is not
publicly retrievable as an image from the exact rendered URL.

#### Scenario: External email image is checked
- **WHEN** an email template references an HTTPS image
- **THEN** an unauthenticated request returns HTTP 200
- **AND** its Content-Type starts with `image/`
