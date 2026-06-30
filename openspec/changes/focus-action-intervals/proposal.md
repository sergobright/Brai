# Focus Action Intervals

## Summary

Replace `focus_session_versions` with first-class Focus intervals, attach
optional activity context to each interval, let the project owner start and stop
activity focus from Activity rows, and update Focus history so it displays and
edits interval-level time.

## Capabilities

- `timer-data`: Focus time is stored only in `focus_session_intervals`; event
  replay derives sessions and intervals; action-focus events, interval edit
  events, deletion, conflict handling, and timer/session API payloads are
  updated.
- `activities`: Activity deletion and archived/deleted activity lookup interact
  with Focus intervals without losing historical titles.
- `local-first-client-data`: the client outbox and cached projections support
  action-focus and interval-edit timer events durably before visible UI changes.
- `next-capacitor-client`: Activity rows, the Focus dock button, and Focus
  history render the new action-focus and interval model on desktop and mobile.

## Rationale

The current `focus_session_versions` model treats a Focus session as one editable
time range. That no longer matches the product model: one Focus session can
contain ordinary focus time, activity-specific intervals, switches between
activities, and gaps that still belong to the same Focus session. Keeping
version rows as a compatibility layer would leave two competing sources of
truth for time and make replay, history, and offline edits harder to reason
about.

The new source of truth is:

- `focus_sessions` stores only the Focus session identity and system metadata.
- `focus_session_intervals` stores all start/end/duration time.
- `activity_id = NULL` means ordinary `В фокусе` time.
- Current activity titles are resolved at read time for history display.

## Scope

- Add a server migration that backfills existing current Focus session versions
  into intervals, rebuilds `focus_sessions` without temporal columns, and drops
  `focus_session_versions`.
- Rewrite server timer replay and read methods to aggregate session-level fields
  from non-overlapping intervals.
- Extend timer events with `start_activity_focus`, `switch_activity_focus`,
  `stop_activity_focus`, and `edit_focus_interval`.
- Preserve `edit_session` only as a temporary compatibility event for
  single-interval sessions.
- Extend `/v1/timer/state` and `/v1/sessions` payloads with active interval and
  interval list fields while preserving existing top-level session fields.
- Update local-first client types, outbox projection, cached session projection,
  and app state commands for action focus and interval edits.
- Add desktop and mobile Activity-row focus controls, active timer display,
  Focus dock active timer rendering, and multi-interval Focus history editing.
- Cover migration, replay, conflict ordering, API shape, client projection, and
  component behavior with focused tests.

## Out Of Scope

- No new animation, date-picker, state-management, database, or UI dependency.
- No manual conflict-resolution UI for offline timer conflicts.
- No hard foreign key from `focus_session_intervals.activity_id` to activities;
  activity and timer sync streams can arrive independently.
- No accepted spec archive in this change; archive happens only after
  implementation, review, and verification.

## Delivery Guard

This is a `runtime/product` change. Implementation must start from the official
Bright task starter, pass the required API/client/OpenSpec checks, and finish
through the preview handoff flow before acceptance.

