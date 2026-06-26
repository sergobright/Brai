## ADDED Requirements

### Requirement: Focus sessions keep editable current versions
Bright OS SHALL store editable start, end, and duration values for completed
Focus sessions in a versioned server-side table.

#### Scenario: Existing sessions are migrated to current versions
- **WHEN** a database with existing timer sessions is migrated
- **THEN** every completed session remains visible as a Focus session
- **AND** every completed session has exactly one current version
- **AND** previous timer event source links are preserved under Focus naming

#### Scenario: Only one version is current
- **WHEN** a Focus session has version history
- **THEN** SQLite enforces that at most one version for that session has
  `is_current = 1`

### Requirement: Completed Focus sessions can be edited offline-first
Bright OS clients SHALL record completed Focus session edits as durable pending
timer events and sync them through the accepted timer event endpoint.

#### Scenario: Client edits a completed session offline
- **WHEN** a client has cached history and no API connectivity
- **AND** the user changes a completed Focus session start or end time
- **THEN** the client records a durable local `edit_session` event
- **AND** the client displays the edited session as pending synchronization

#### Scenario: Server accepts a session edit
- **WHEN** the server receives a valid `edit_session` event for a completed
  Focus session
- **THEN** it marks the previous current version inactive
- **AND** inserts the edited values as the new current version
- **AND** history and goal calculations use the new current version

#### Scenario: Concurrent offline edits sync later
- **WHEN** two devices edit the same completed Focus session while offline
- **AND** both edits are later accepted by the server
- **THEN** the last accepted edit is the current version
- **AND** earlier values remain in the version history

#### Scenario: Invalid session edit is ignored
- **WHEN** an edit targets a missing session, an active session, invalid UTC
  timestamps, an end time not after the start time, or a timestamp outside the
  accepted future tolerance
- **THEN** the server stores the event as ignored with a reason
- **AND** the current Focus session version is unchanged
