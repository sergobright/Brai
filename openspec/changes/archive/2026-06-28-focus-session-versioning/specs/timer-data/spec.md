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

#### Scenario: Overlapping session edit is ignored
- **WHEN** an `edit_session` event would make a completed Focus session overlap
  another non-deleted completed Focus session
- **THEN** the server stores the edit event as ignored with reason
  `focus_session_overlap`
- **AND** the current Focus session version is unchanged

#### Scenario: Boundary-touching edit is accepted
- **WHEN** an `edit_session` event makes a completed Focus session end exactly
  when the next non-deleted Focus session starts
- **THEN** the server accepts the edit
- **AND** history and goal calculations use the edited range

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

#### Scenario: Deleted session edit is ignored
- **WHEN** an `edit_session` event targets a soft-deleted Focus session
- **THEN** the server stores the edit event as ignored with reason
  `focus_session_deleted`
- **AND** the deleted Focus session remains excluded from history and goal
  calculations

### Requirement: Completed Focus sessions can be soft-deleted offline-first
Bright OS clients SHALL record completed Focus session deletions as durable
pending `delete_session` timer events and sync them through the accepted timer
event endpoint.

#### Scenario: Client deletes a completed session offline
- **WHEN** a client has cached history and no API connectivity
- **AND** the user deletes a completed Focus session
- **THEN** the client records a durable local `delete_session` event
- **AND** the client immediately hides that session from projected history

#### Scenario: Server accepts a session delete
- **WHEN** the server receives a valid `delete_session` event for a completed
  Focus session
- **THEN** it marks the Focus session as deleted without deleting the session,
  version, source, or timer event audit rows
- **AND** history and goal calculations exclude the deleted session

#### Scenario: Session delete is idempotent
- **WHEN** the server receives another valid `delete_session` event for an
  already deleted completed Focus session
- **THEN** the server acknowledges the event without restoring or duplicating
  the deleted session
