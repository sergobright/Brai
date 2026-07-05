# Scheduled Runtime Agents

## Summary

Add a small server-side scheduler for runtime agents. A systemd timer wakes a
Node runner every five minutes; SQLite decides which registered agent is due.
The previously planned `TASKS.md` dedupe agent is now disabled because agent
task tracking moved from `TASKS.md` into `activities` operation rows.

## Capabilities

- Add `agent_schedules` as the source of truth for scheduled runtime agent
  due time, interval, lock state, and last run status.
- Register `maintenance.tasks_md_deduper` in `agents` as disabled legacy
  documentation.
- Run scheduled agents through `brai-scheduler.timer` and
  `brai-scheduler.service`.
- Keep scheduled runtime agent state in SQLite without running obsolete
  `TASKS.md` maintenance.

## Rationale

Brai already has an `agents` registry, but no schedule state. A custom
daemon loop would duplicate systemd timer behavior. The minimum durable design
is one systemd timer as the wakeup mechanism and one SQLite table for agent
due/lock/run state.

## Delivery Guard

This is a runtime/product change because it adds server runtime code, SQLite
schema, and systemd units. It must pass API and OpenSpec checks and finish
through the preview delivery flow.
