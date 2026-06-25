# Timer Data Specification

## Purpose

Define how Bright OS records timer actions durably across clients, synchronizes pending offline work, derives canonical timer sessions from server-side events, and keeps history and goal totals consistent without manual conflict resolution.
## Requirements
### Requirement: Clients support offline timer events
Bright OS clients SHALL allow timer start and stop actions to be recorded while the client is disconnected from the Bright OS API.

#### Scenario: Client starts timer offline
- **WHEN** a client has no API connectivity and the user starts the timer
- **THEN** the client records a durable local start event
- **AND** the client displays a locally projected running timer
- **AND** the event remains pending until it is acknowledged or ignored by the server

#### Scenario: Client stops timer offline
- **WHEN** a client has a locally active pending timer and the user stops the timer without API connectivity
- **THEN** the client records a durable local stop event
- **AND** the client displays the local projected session as pending synchronization

#### Scenario: Client restarts before reconnect
- **WHEN** a client records offline events and the app is killed, closed, or reloaded before reconnect
- **THEN** the client reloads the pending events from local storage
- **AND** the client resumes the local projected timer state from those events

#### Scenario: Client records multiple offline sessions
- **WHEN** a client records start, stop, start, and stop actions while offline
- **THEN** the client keeps all pending events in order
- **AND** each event has a stable event id and per-device sequence number

### Requirement: Server stores timer event log
The Bright OS API SHALL store timer start and stop events in a durable server-side event log with stable device identity and idempotent event identity.

#### Scenario: New device syncs events
- **WHEN** a client syncs events with a stable `device_id`
- **THEN** the server stores or updates the device record
- **AND** stores each new timer event with `event_id`, `device_id`, `client_sequence`, event type, event timestamp, and server receive timestamp

#### Scenario: Existing completed sessions are migrated
- **WHEN** offline-first sync is introduced to an existing Bright OS database
- **THEN** existing completed timer sessions remain visible in history and goal calculations
- **AND** the migration seeds or preserves canonical data so previous work is not lost

#### Scenario: Legacy sessions are backfilled
- **WHEN** an existing database is migrated to offline-first sync
- **THEN** existing sessions are represented by synthetic accepted events under a legacy server device
- **AND** the migrated canonical history does not double-count previous sessions

### Requirement: Event sync is idempotent
The Bright OS API SHALL expose an idempotent event batch sync endpoint for pending client timer events.

#### Scenario: Client uploads pending events
- **WHEN** a client calls `POST /v1/timer/events/sync` with pending events
- **THEN** the server stores unseen valid events
- **AND** acknowledges already-seen events without duplicating sessions
- **AND** returns the current canonical timer state

#### Scenario: Client retries after network drop
- **WHEN** the server receives a sync batch and the network drops before the client receives the response
- **AND** the client later retries the same batch
- **THEN** the server acknowledges the already-stored events
- **AND** canonical sessions are not duplicated

#### Scenario: Event is invalid
- **WHEN** a synced event is malformed, impossible, or outside accepted timestamp bounds
- **THEN** the server records the event as ignored with a reason
- **AND** acknowledges it so the client does not retry it forever
- **AND** excludes it from canonical sessions

#### Scenario: Unauthorized sync is rejected
- **WHEN** a sync request omits valid Bright OS API authorization
- **THEN** the server rejects the request
- **AND** no device or event rows are stored

#### Scenario: Event is in the future
- **WHEN** a synced event timestamp is more than 5 minutes beyond the server receive time
- **THEN** the server records the event as ignored with a reason
- **AND** timer state, history, and goal totals remain unchanged

### Requirement: Canonical sessions are derived from events
Bright OS SHALL derive the active timer state and completed timer sessions from the accepted timer event log.

#### Scenario: Online start uses event model
- **WHEN** a client starts the timer while online through the existing start endpoint
- **THEN** the server records a start event
- **AND** recomputes canonical timer state from events

#### Scenario: Online stop uses event model
- **WHEN** a client stops the timer while online through the existing stop endpoint
- **THEN** the server records a stop event
- **AND** recomputes canonical completed sessions from events

#### Scenario: Server restarts during active timer
- **WHEN** the Bright OS API restarts while canonical event history contains an open interval
- **THEN** the server reconstructs the active timer state from persisted events
- **AND** clients recover the same active timer after reconnect

#### Scenario: Late offline event revises history
- **WHEN** a client syncs an older offline event that overlaps completed canonical history
- **THEN** the server recomputes canonical sessions deterministically
- **AND** clients refresh by server revision to display the revised history and goals

#### Scenario: Existing start endpoint remains compatible
- **WHEN** a client calls the existing start endpoint while the canonical timer is active
- **THEN** the endpoint remains response-compatible
- **AND** no duplicate canonical time is created

#### Scenario: Existing stop endpoint remains compatible
- **WHEN** a client calls the existing stop endpoint while canonical state is idle
- **THEN** the endpoint returns the existing idle conflict behavior
- **AND** no stop event changes canonical sessions

### Requirement: Overlapping offline intervals are merged automatically
Bright OS SHALL resolve overlapping timer intervals from multiple devices without user input by merging half-open UTC intervals and counting overlapping time once.

#### Scenario: Offline intervals overlap partially
- **WHEN** one device syncs `10:00-11:00`
- **AND** another device syncs `10:30-12:00`
- **THEN** the canonical history contains `10:00-12:00`
- **AND** the overlap counts once for history and goals

#### Scenario: One offline interval contains another
- **WHEN** one device syncs `10:00-12:00`
- **AND** another device syncs `10:30-11:00`
- **THEN** the canonical history contains `10:00-12:00`
- **AND** the contained interval is not double-counted

#### Scenario: Offline intervals touch exactly
- **WHEN** one device syncs `10:00-11:00`
- **AND** another device syncs `11:00-12:00`
- **THEN** the canonical history contains `10:00-12:00`

#### Scenario: Offline intervals have a real gap
- **WHEN** one device syncs `10:00-11:00`
- **AND** another device syncs `11:05-12:00`
- **THEN** the canonical history keeps two separate sessions

#### Scenario: Multiple devices remain active offline
- **WHEN** multiple devices sync open start events without matching stop events
- **THEN** the canonical active timer starts at the earliest open interval start
- **AND** remains active until canonical event history closes all merged open intervals

### Requirement: Manual conflict UI is not used
Bright OS MUST NOT require or present manual conflict resolution UI for offline timer synchronization conflicts.

#### Scenario: Sync detects overlapping intervals
- **WHEN** the server detects overlapping offline and server timer intervals
- **THEN** the server resolves the conflict automatically using interval-union rules
- **AND** the client shows the resulting canonical timer state without asking the project owner to choose a version

### Requirement: Clients reconcile pending local events after reconnect
Bright OS clients SHALL upload pending local timer events after reconnect and replace local projected state with server canonical state.

#### Scenario: Client reconnects after offline start
- **WHEN** a client reconnects after recording an offline start event
- **THEN** it uploads the pending start event
- **AND** displays the server canonical active timer after acknowledgement

#### Scenario: Client reconnects after offline start and stop
- **WHEN** a client reconnects after recording a complete offline start-stop pair
- **THEN** it uploads both events
- **AND** displays the server canonical completed session after acknowledgement

#### Scenario: Events arrive out of order
- **WHEN** the server receives a stop event before a related start event due to delayed sync ordering
- **THEN** canonical recomputation remains deterministic after all accepted events are stored
- **AND** clients converge to the same canonical state after refresh

#### Scenario: Duplicate taps create duplicate local actions
- **WHEN** a client records duplicate start or stop actions from repeated taps
- **THEN** the server normalization excludes duplicate actions from canonical sessions
- **AND** acknowledges the duplicate events

#### Scenario: Sync fails transiently
- **WHEN** pending event upload fails because of a transient network or server error
- **THEN** the client keeps the events queued with stable event ids
- **AND** retries them later without creating new logical events

#### Scenario: Auth fails during sync
- **WHEN** pending event upload fails because authorization is no longer valid
- **THEN** the client preserves the local queue
- **AND** pauses sync until authorization is restored

#### Scenario: Stale live update arrives
- **WHEN** a client has pending local events and receives a stale live or server snapshot
- **THEN** the client uses server revision or cursor data to avoid overwriting newer pending local state incorrectly
- **AND** reconciles again after pending events are acknowledged

### Requirement: Goal calculations use canonical merged sessions
Bright OS SHALL calculate daily and challenge goal progress from canonical merged sessions.

#### Scenario: Merged offline intervals affect daily goal
- **WHEN** overlapping offline intervals are merged into one canonical session
- **THEN** daily completed seconds use the merged duration
- **AND** overlapping time is not double-counted

#### Scenario: Canonical session crosses Moscow midnight
- **WHEN** a canonical session crosses midnight in Europe/Moscow
- **THEN** goal calculations split the session across the affected Moscow calendar days
- **AND** history day groups split the session into per-day display chunks with matching day totals
- **AND** canonical completed sessions preserve their original timestamps and duration

### Requirement: Next client uses accepted timer event sync
The Next.js/Capacitor client SHALL use the accepted timer event sync API for timer mutations.

#### Scenario: Timer start is recorded
- **WHEN** the user starts the timer in the Next.js/Capacitor client
- **THEN** the client creates a local start event with stable event id, device id, and client sequence
- **AND** syncs it through `POST /v1/timer/events/sync`

#### Scenario: Timer stop is recorded
- **WHEN** the user stops the timer in the Next.js/Capacitor client
- **THEN** the client creates a local stop event with stable event id, device id, and client sequence
- **AND** syncs it through `POST /v1/timer/events/sync`

### Requirement: Next client reconciles by server revision
The Next.js/Capacitor client SHALL reconcile canonical server snapshots by server revision or equivalent cursor data.

#### Scenario: Live update arrives while local events are pending
- **WHEN** the client receives a live or polled server snapshot while pending local events exist
- **THEN** it triggers a pending-event flush when possible
- **AND** does not overwrite newer local projected state with a stale server snapshot

#### Scenario: Sync acknowledgement is received
- **WHEN** the server acknowledges or ignores pending events
- **THEN** the client removes acknowledged pending events from the outbox
- **AND** stores ignored-event diagnostics
- **AND** renders the canonical state returned by the server

### Requirement: Cached canonical data is available offline
The Next.js/Capacitor client SHALL cache canonical timer state, recent sessions, and goal summaries for offline display.

#### Scenario: Cached history is shown offline
- **WHEN** the client has cached completed timer sessions but no current API connectivity
- **THEN** it displays cached history grouped by Europe/Moscow calendar day
- **AND** cross-midnight sessions are split into per-day display chunks
