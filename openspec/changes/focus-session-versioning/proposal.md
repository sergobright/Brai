# Focus Session Versioning

## Summary

Move Focus session start/end/duration values into versioned rows so completed
sessions can be edited offline-first while preserving audit history.

## Capabilities

- `timer-data`: completed Focus sessions have current versions, edit events sync
  through the existing timer event endpoint, soft delete events preserve audit,
  and history/goal calculations use non-deleted current versions.
- `next-capacitor-client`: Focus history rows open an inline one-row editor
  from row tap/click instead of a pencil control.

## Rationale

`timer_sessions` currently stores canonical session values directly. That makes
manual correction overwrite-prone and gives no durable history of previous
values. A version table keeps the canonical session identity stable while
recording each accepted edit as a new current version.
