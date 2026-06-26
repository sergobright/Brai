# Focus Session Versioning Design

## Decisions

- Rename the server read-model tables to Focus naming: `focus_sessions` and
  `focus_session_sources`. Keep `/v1/timer/*` HTTP routes compatible for now.
- Store editable values in `focus_session_versions`; enforce one current row per
  session with a SQLite partial unique index.
- Extend the existing timer event log with `edit_session` instead of adding a
  second sync service. Clients already have stable device identity, sequence
  numbers, retries, and ignored-event handling there.
- Resolve concurrent offline edits with last accepted server event wins. Older
  versions stay queryable through `focus_session_versions`.

## Data Flow

Timer start/stop events still rebuild Focus sessions from canonical intervals.
For each session, the replay stores a system current version. An accepted
`edit_session` event targets a completed session, marks its current version
inactive, inserts a new current version, and bumps the timer server revision.
History and goal queries join current versions, not raw session columns.

## Alternatives

- Editing `timer_events` directly was rejected because it would rewrite the
  source event log and make audit harder.
- A separate edit endpoint was rejected because it would duplicate the existing
  offline-first outbox and sync machinery.
