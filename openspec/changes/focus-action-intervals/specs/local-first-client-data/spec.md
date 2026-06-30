## ADDED Requirements

### Requirement: Client projects pending action focus events
Bright OS clients SHALL project pending action-focus timer events from durable
local outbox state before server acknowledgement.

#### Scenario: Action focus starts offline
- **WHEN** the user starts Focus from an Activity while disconnected
- **THEN** the client first stores a durable pending `start_activity_focus`
  event
- **AND** then displays a locally projected active Focus timer for that Activity
- **AND** the event survives reload or app restart

#### Scenario: Action focus switches offline
- **WHEN** the user switches active Focus from one Activity to another while
  disconnected
- **THEN** the client first stores a durable pending `switch_activity_focus`
  event
- **AND** then closes the previous projected activity interval
- **AND** displays the new projected active Activity timer

#### Scenario: Action focus stops offline
- **WHEN** the user stops action focus while disconnected
- **THEN** the client first stores a durable pending `stop_activity_focus`
  event
- **AND** then projects either a stopped Focus timer or continued ordinary Focus
  according to the active session origin

### Requirement: Client projects pending Focus interval edits
Bright OS clients SHALL project pending Focus interval edits and deletes from
durable local outbox state before server acknowledgement.

#### Scenario: Interval edit is queued offline
- **WHEN** the user edits a completed Focus interval without API connectivity
- **THEN** the client first stores a durable pending `edit_focus_interval` event
- **AND** then displays projected history and goal data using the edited
  interval

#### Scenario: Compatibility session edit is projected
- **WHEN** a pending `edit_session` event targets a cached session with exactly
  one interval
- **THEN** the client projects it as an edit to that single interval

#### Scenario: Multi-interval session edit is not projected as compatible
- **WHEN** a pending `edit_session` event targets a cached session with multiple
  intervals
- **THEN** the client does not apply a misleading whole-session projection
- **AND** preserves the pending event until server acknowledgement or ignored
  diagnostics resolve it

#### Scenario: Session delete hides intervals
- **WHEN** a pending `delete_session` event targets a cached Focus session
- **THEN** the client hides the session and every interval in that session from
  projected history

### Requirement: Cached sessions preserve interval details
Bright OS clients SHALL preserve Focus session interval details in cached
canonical data used for offline display.

#### Scenario: Cached history reloads offline
- **WHEN** the client restarts while offline after receiving sessions with
  interval arrays
- **THEN** it reloads the cached intervals
- **AND** can render parent Focus rows and expanded interval rows without an API
  round trip

#### Scenario: Local schema changes for intervals
- **WHEN** implementation adds a local table, index, or field to support Focus
  intervals
- **THEN** the Dexie schema version is increased
- **AND** existing pending events and cached sessions remain available after the
  migration

