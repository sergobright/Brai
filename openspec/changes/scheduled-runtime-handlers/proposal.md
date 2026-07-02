# Scheduled Runtime Handlers

## Summary

Add a small server-side scheduler for runtime handlers. A systemd timer wakes a
Node runner every five minutes; SQLite decides which registered handler is due.
The previously planned `TASKS.md` dedupe handler is now disabled because agent
task tracking moved from `TASKS.md` into `activities` operation rows.

## Capabilities

- Add `handler_schedules` as the source of truth for scheduled runtime handler
  due time, interval, lock state, and last run status.
- Register `maintenance.tasks_md_deduper` in `handlers` as disabled legacy
  documentation.
- Run scheduled handlers through `brai-scheduler.timer` and
  `brai-scheduler.service`.
- Keep scheduled runtime handler state in SQLite without running obsolete
  `TASKS.md` maintenance.

## Rationale

Brai already has a `handlers` registry, but no schedule state. A custom
daemon loop would duplicate systemd timer behavior. The minimum durable design
is one systemd timer as the wakeup mechanism and one SQLite table for handler
due/lock/run state.

## Delivery Guard

This is a runtime/product change because it adds server runtime code, SQLite
schema, and systemd units. It must pass API and OpenSpec checks and finish
through the preview delivery flow.
