# Focus Action Intervals Design

## Decisions

- Replace the editable-version model with interval rows. `focus_sessions` keeps
  only identity, deletion metadata, `start_origin`, and
  `started_by_activity_id`; all temporal values live in
  `focus_session_intervals`.
- Drop `focus_session_versions` after migration. Runtime code must not keep a
  read or write compatibility layer for that table.
- Treat `activity_id = NULL` as ordinary `В фокусе` time. Activity-linked
  intervals store only `activity_id`; titles are resolved from current Activity
  records, including archived/deleted records when available.
- Keep `activity_id` soft-linked instead of FK-enforced so offline timer events
  can replay before matching activity-create events arrive.
- Allow a full interval rebuild from the accepted timer event log inside one
  transaction if that is simpler than incremental interval mutation, but keep
  stable `focus_sessions.id` for the same canonical Focus session.
- Keep `edit_session` as temporary compatibility only for sessions with exactly
  one interval. Multi-interval edits must use `edit_focus_interval`.
- Resolve action-focus conflicts automatically by deterministic event ordering;
  do not add manual conflict UI.
- Use existing client primitives, `lucide-react`, `motion/react`, CSS/Tailwind,
  and current UI components. Do not add dependencies.

## Server Data Model

Add an idempotent migration after the current latest migration.

`focus_session_intervals`:

- `id TEXT PRIMARY KEY`
- `focus_session_id TEXT NOT NULL`
- `activity_id TEXT NULL`
- `started_at_utc TEXT NOT NULL`
- `ended_at_utc TEXT NULL`
- `duration_seconds INTEGER NULL`
- `created_at_utc TEXT NOT NULL`
- `updated_at_utc TEXT NOT NULL`
- `created_event_id TEXT NULL`
- `ended_event_id TEXT NULL`
- `created_by_device_id TEXT NULL`

Indexes:

- `(focus_session_id, started_at_utc)`
- `(activity_id, started_at_utc)`
- `(started_at_utc)`
- `(ended_at_utc)`
- a partial active-interval guard on `focus_session_id WHERE ended_at_utc IS NULL`
  when it does not break event-log replay

`focus_sessions` after rebuild:

- `id`
- `created_at_utc`
- `updated_at_utc`
- `deleted_at_utc`
- `deleted_event_id`
- `start_origin TEXT NOT NULL DEFAULT 'focus' CHECK (start_origin IN ('focus', 'activity'))`
- `started_by_activity_id TEXT NULL`

Backfill current data:

- For each `focus_session_versions WHERE is_current = 1`, create exactly one
  interval with `activity_id = NULL`.
- Use a stable legacy interval id such as
  `${focus_session_id}:interval:legacy`.
- Preserve `started_at_utc`, `ended_at_utc`, and `duration_seconds` from the
  version row.
- Use version/session timestamps for `created_at_utc` and `updated_at_utc`
  where available.
- Active sessions keep `ended_at_utc = NULL` and `duration_seconds = NULL`.
- Drop `focus_session_versions` only after successful backfill and table
  rebuild.
- Update `table_descriptions` for `focus_sessions`,
  `focus_session_intervals`, and new `timer_events.type` values.

## Canonical Replay

Replay must derive Focus sessions and intervals from accepted timer events.

Base start/stop events create canonical Focus sessions and `NULL` intervals.
Action-focus events then split or replace the active interval:

- `start_activity_focus`: when idle, starts a Focus session with
  `start_origin = 'activity'` and opens an activity interval; when already
  active, closes the active interval and opens the activity interval.
- `switch_activity_focus`: requires an active Focus session, closes the current
  active interval, and opens a new activity interval.
- `stop_activity_focus`: closes the current activity interval. If the Focus
  session was started from an activity, it also closes the Focus session. If the
  session was started from the Focus section, it opens a new `NULL` interval at
  the same timestamp so ordinary focus continues.
- `edit_focus_interval`: updates a completed interval within allowed neighbor
  and session boundaries.
- `delete_session`: soft-deletes the Focus session and excludes all of its
  intervals from history and goal totals.

Event ordering for deterministic splitting:

1. `occurred_at_utc`
2. `server_sequence`
3. `device_id`
4. `event_id`

Intervals inside one Focus session must not overlap. Touching boundaries are
valid. Gaps are represented as `NULL` intervals when they are ordinary Focus
time that must remain visible; real gaps between separate sessions remain gaps.

## Aggregated Session Shape

Server reads expose existing session-level fields by aggregating intervals:

- `started_at_utc = MIN(interval.started_at_utc)`
- `ended_at_utc = NULL` when any interval is active
- `ended_at_utc = MAX(interval.ended_at_utc)` for completed sessions
- `duration_seconds = SUM(non-overlapping completed interval durations)`

`getActiveSession()`, `getSession()`, `getLatestCompletedSession()`,
`listSessions()`, and `challengeSummary()` must read intervals, not version
rows.

## API Contract

Extend `/v1/timer/state` with:

- `active_interval`
- `active_interval_elapsed_seconds`
- `active_activity_id`
- `active_session_start_origin`
- `active_session_started_by_activity_id`

`active_interval` contains:

- `id`
- `focus_session_id`
- `activity_id`
- `started_at_utc`
- `ended_at_utc`
- `duration_seconds`

Extend `/v1/sessions` session objects while preserving existing top-level
fields:

- `intervals`
- `activity_interval_count`
- `primary_activity_id`
- `primary_activity_title`

Interval objects contain:

- `id`
- `focus_session_id`
- `activity_id`
- `activity_title`
- `started_at_utc`
- `ended_at_utc`
- `duration_seconds`
- existing date/hour display fields when the current API provides them for
  session rows

`primary_activity_title` is `null` when the session has no action interval, the
single action title when it has one, or the title of the longest action
interval when there are several. The UI may append `+N`.

## Client Local-First Flow

The client adds timer event types and projected commands:

- `onStartActionFocus(action)`
- `onSwitchActionFocus(action)`
- `onStopActionFocus(action)`
- `onEditFocusInterval(intervalId, startedAtUtc, endedAtUtc)`

Each command persists the local outbox event before visible state changes,
projects the timer/history UI from pending events, then flushes pending events.
Pending projection must handle:

- `start_activity_focus`
- `switch_activity_focus`
- `stop_activity_focus`
- `edit_focus_interval`
- compatibility `edit_session` for single-interval sessions
- `delete_session`

If `sessions_cache` already stores whole `TimerSession` objects, a separate
local intervals table is not required. Increase the Dexie schema version only
when the implementation adds new local tables or indexes.

## UI Contract

Activity row:

- Add a Focus control before delete controls.
- Use the existing Focus icon, `Timer` from `lucide-react`.
- Desktop inactive icon appears on row hover/focus.
- Active action timer is always visible.
- Desktop hover over the active timer shows `Стоп`; click stops action focus.
- Mobile inactive icon appears with swipe-left row controls.
- Mobile active timer stays visible without swipe; first tap shows accent
  `Стоп`; it hides after a short timeout if not pressed.
- Active timer uses `H:MM` or `HH:MM`, no seconds, tabular numerals, and a
  blinking colon.
- Row height must remain stable.

Focus dock:

- When idle, keep the normal `Timer` icon.
- When active, show elapsed `H:MM` without resizing the dock button.
- Add a quiet rotating tick/dash treatment clipped inside the round button and
  compatible with existing FloatingDock hover scaling.

Focus history:

- Parent row with no action intervals: title `В фокусе`, right icon `Timer`.
- Parent row with one action interval: current activity title, right icon
  `SquareTerminal`.
- Parent row with multiple action intervals: longest activity title plus `+N`,
  right icon `SquareTerminal`, collapsed by default.
- Single-interval sessions may open the existing inline editor under the parent
  row, but the edited target is the interval.
- Multi-interval sessions hide parent editing and expose interval rows with
  start, duration, end, title, and a pencil per interval.
- Active intervals are not editable from history.
- Multi-interval delete uses inline confirmation before queuing
  `delete_session`.

## Alternatives

- Keeping `focus_session_versions` as a compatibility read model was rejected:
  it would preserve two temporal sources of truth and make interval edits
  ambiguous.
- Adding a separate activity-focus sync endpoint was rejected: timer events
  already provide device identity, idempotency, ordering, ignored-event reasons,
  and reconnect behavior.
- Enforcing `activity_id` with a hard FK was rejected because timer and activity
  events can sync in either order.
- Adding a custom conflict-resolution UI was rejected because accepted timer
  behavior already resolves offline conflicts automatically.

