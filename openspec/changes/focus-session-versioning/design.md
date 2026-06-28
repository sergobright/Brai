# Focus Session Versioning Design

## Decisions

- Rename the server read-model tables to Focus naming: `focus_sessions` and
  `focus_session_sources`. Keep `/v1/timer/*` HTTP routes compatible for now.
- Store editable values in `focus_session_versions`; enforce one current row per
  session with a SQLite partial unique index.
- Extend the existing timer event log with `edit_session` and `delete_session`
  instead of adding a second sync service. Clients already have stable device
  identity, sequence numbers, retries, and ignored-event handling there.
- Resolve concurrent offline edits with last accepted server event wins. Older
  versions stay queryable through `focus_session_versions`.
- Treat deletion as soft delete on `focus_sessions`; replay keeps timer events
  and version rows but excludes deleted sessions from history and goal totals.
- Keep one canonical Focus session interval across Moscow-day boundaries.
  Day-split rows are read-model/display chunks that point back to the canonical
  session id for edits and deletes.
- Keep the inline editor and overlap warning bounded to the same table-row
  footprint as a normal Focus history row. Overlap warning is an 80% opaque
  overlay on the parent row, not a separate layout element.

## Data Flow

Timer start/stop events still rebuild Focus sessions from canonical intervals.
For each session, the replay stores a system current version. An accepted
`edit_session` event targets a completed session, marks its current version
inactive, inserts a new current version, and bumps the timer server revision.
An accepted `delete_session` event marks the session deleted without deleting
its audit rows. History and goal queries join non-deleted current versions, not
raw session columns. Edited intervals must not overlap other non-deleted Focus
sessions; exact boundary touching remains valid.

## Alternatives

- Editing `timer_events` directly was rejected because it would rewrite the
  source event log and make audit harder.
- A separate edit endpoint was rejected because it would duplicate the existing
  offline-first outbox and sync machinery.
- Physically splitting cross-day edits into multiple sessions was rejected
  because it would turn a single focus interval into separate audit identities.
