## REMOVED Requirements

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

## ADDED Requirements

### Requirement: Focus time is stored as intervals
Bright OS SHALL store all Focus session time in `focus_session_intervals` and
MUST NOT read or write `focus_session_versions` at runtime after the interval
migration.

#### Scenario: Existing current versions are migrated to intervals
- **WHEN** a database containing `focus_session_versions` is migrated
- **THEN** each current Focus session version is represented by exactly one
  `focus_session_intervals` row with `activity_id = NULL`
- **AND** the interval preserves the current version start, end, and duration
- **AND** the interval id is stable for repeatable migrations
- **AND** history and goal totals remain unchanged

#### Scenario: Version table is removed
- **WHEN** the interval migration completes
- **THEN** `focus_session_versions` no longer exists
- **AND** `focus_sessions` contains no start, end, duration, or interval columns
- **AND** runtime Focus session reads use interval aggregates

#### Scenario: Ordinary Focus time is represented
- **WHEN** a Focus interval has `activity_id = NULL`
- **THEN** the interval is treated as ordinary `В фокусе` time
- **AND** it contributes to the parent Focus session duration

#### Scenario: Active interval is guarded
- **WHEN** a Focus session has an active interval
- **THEN** no second active interval for the same Focus session is accepted in
  canonical storage
- **AND** replay corrects accepted event history into a non-overlapping interval
  timeline

### Requirement: Focus session fields are aggregated from intervals
Bright OS SHALL expose session-level start, end, and duration fields as
aggregates over non-deleted Focus session intervals.

#### Scenario: Completed session is returned
- **WHEN** a completed Focus session has one or more completed intervals
- **THEN** `started_at_utc` is the earliest interval start
- **AND** `ended_at_utc` is the latest interval end
- **AND** `duration_seconds` is the sum of non-overlapping interval durations

#### Scenario: Active session is returned
- **WHEN** a Focus session has an active interval
- **THEN** the session `ended_at_utc` is `NULL`
- **AND** active elapsed time is calculated from the active interval and session
  aggregate as appropriate

#### Scenario: Deleted session is excluded
- **WHEN** a Focus session has `deleted_at_utc`
- **THEN** all of its intervals are excluded from history, goal totals, and
  active/latest completed session reads

### Requirement: Action focus events derive activity intervals
Bright OS SHALL derive activity-linked Focus intervals from accepted timer
events without requiring a separate sync endpoint.

#### Scenario: Activity focus starts while idle
- **WHEN** the server accepts `start_activity_focus` with an `activity_id` while
  the main Focus timer is idle
- **THEN** it creates a Focus session with `start_origin = 'activity'`
- **AND** stores `started_by_activity_id` with that activity id
- **AND** opens an active interval linked to that activity

#### Scenario: Activity focus starts while Focus is active
- **WHEN** the server accepts `start_activity_focus` while a Focus session is
  already active
- **THEN** it closes the current active interval at the event timestamp
- **AND** opens a new active interval linked to the requested activity
- **AND** keeps the same parent Focus session active

#### Scenario: Activity focus switches
- **WHEN** the server accepts `switch_activity_focus` during an active Focus
  session
- **THEN** it closes the current active interval at the event timestamp
- **AND** opens a new active interval linked to the requested activity
- **AND** does not stop the parent Focus session

#### Scenario: Activity-started Focus is stopped from the activity
- **WHEN** the server accepts `stop_activity_focus` for a Focus session whose
  `start_origin` is `activity`
- **THEN** it closes the active activity interval at the event timestamp
- **AND** closes the parent Focus session at the same timestamp

#### Scenario: Focus-started action interval is stopped
- **WHEN** the server accepts `stop_activity_focus` for a Focus session whose
  `start_origin` is `focus`
- **THEN** it closes the active activity interval at the event timestamp
- **AND** opens a new active `activity_id = NULL` interval at the same timestamp
- **AND** keeps the parent Focus session active

### Requirement: Action focus conflicts are split deterministically
Bright OS SHALL resolve overlapping action-focus events automatically into a
stable, non-overlapping interval timeline.

#### Scenario: Later action event overlaps active interval
- **WHEN** an accepted action-focus event starts before the current active
  action interval has ended
- **THEN** canonical replay closes the previous interval at the new event
  timestamp
- **AND** opens the new interval from that timestamp

#### Scenario: Equal timestamps are stable
- **WHEN** multiple accepted action-focus events have the same `occurred_at_utc`
- **THEN** replay orders them by `server_sequence`, then `device_id`, then
  `event_id`
- **AND** repeated replay produces the same interval ids, order, and aggregate
  session totals

#### Scenario: Timeline gaps are ordinary Focus
- **WHEN** stopping an activity interval should leave the main Focus timer
  active
- **THEN** canonical replay creates or continues a `NULL` interval so the
  remaining time is not lost

### Requirement: Timer APIs expose Focus interval state
Bright OS SHALL expose active and completed interval data while preserving
existing compatible session-level fields.

#### Scenario: Timer state is requested during action focus
- **WHEN** `/v1/timer/state` is requested while an activity interval is active
- **THEN** the response includes `active_interval`
- **AND** includes `active_interval_elapsed_seconds`
- **AND** includes `active_activity_id`
- **AND** includes `active_session_start_origin`
- **AND** includes `active_session_started_by_activity_id`

#### Scenario: Sessions are requested
- **WHEN** `/v1/sessions` returns Focus sessions
- **THEN** each session preserves `id`, aggregate `started_at_utc`,
  `ended_at_utc`, `duration_seconds`, and existing display date/hour fields
- **AND** includes `intervals`
- **AND** includes `activity_interval_count`
- **AND** includes `primary_activity_id`
- **AND** includes `primary_activity_title`

#### Scenario: Primary activity is selected
- **WHEN** a Focus session has multiple activity intervals
- **THEN** `primary_activity_id` and `primary_activity_title` identify the
  longest activity interval
- **AND** the session exposes enough interval data for the UI to show a `+N`
  multi-activity indicator

### Requirement: Focus intervals can be edited offline-first
Bright OS clients SHALL record completed Focus interval edits as durable
pending `edit_focus_interval` timer events and sync them through the accepted
timer event endpoint.

#### Scenario: Client edits a completed interval offline
- **WHEN** a client has cached history and no API connectivity
- **AND** the user changes a completed Focus interval start or end time
- **THEN** the client records a durable local `edit_focus_interval` event
- **AND** the client displays the edited interval as pending synchronization

#### Scenario: Server accepts an interval edit
- **WHEN** the server receives a valid `edit_focus_interval` event for a
  completed non-deleted interval
- **THEN** it updates that interval start, end, and duration
- **AND** session history and goal calculations use the edited interval
  aggregate

#### Scenario: Active interval edit is ignored
- **WHEN** an `edit_focus_interval` event targets an active interval
- **THEN** the server stores the event as ignored with a reason
- **AND** the active interval is unchanged

#### Scenario: Overlapping interval edit is ignored
- **WHEN** an `edit_focus_interval` event would overlap another interval in the
  same Focus session or cross a neighboring Focus session boundary
- **THEN** the server stores the event as ignored with a reason
- **AND** all Focus intervals remain unchanged

#### Scenario: Boundary-touching interval edit is accepted
- **WHEN** an interval edit makes the interval end exactly when the next allowed
  interval or neighboring Focus session starts
- **THEN** the server accepts the edit
- **AND** history and goal calculations use the edited range

#### Scenario: Compatibility session edit targets one interval
- **WHEN** the server receives `edit_session` for a completed Focus session with
  exactly one interval
- **THEN** it edits that interval using the same validation rules as
  `edit_focus_interval`

#### Scenario: Compatibility session edit targets multiple intervals
- **WHEN** the server receives `edit_session` for a Focus session with multiple
  intervals
- **THEN** it stores the event as ignored with reason
  `focus_session_has_multiple_intervals`
- **AND** no interval is changed

## MODIFIED Requirements

### Requirement: Completed Focus sessions can be soft-deleted offline-first
Bright OS clients SHALL record completed Focus session deletions as durable
pending `delete_session` timer events and sync them through the accepted timer
event endpoint.

#### Scenario: Client deletes a completed session offline
- **WHEN** a client has cached history and no API connectivity
- **AND** the user deletes a completed Focus session
- **THEN** the client records a durable local `delete_session` event
- **AND** the client immediately hides that session and all of its intervals
  from projected history

#### Scenario: Server accepts a session delete
- **WHEN** the server receives a valid `delete_session` event for a completed
  Focus session
- **THEN** it marks the Focus session as deleted without deleting the session,
  interval, source, or timer event audit rows
- **AND** history and goal calculations exclude all intervals in the deleted
  session

#### Scenario: Session delete is idempotent
- **WHEN** the server receives another valid `delete_session` event for an
  already deleted completed Focus session
- **THEN** the server acknowledges the event without restoring or duplicating
  the deleted session

