## ADDED Requirements

### Requirement: Scheduled runtime handlers use SQLite schedule state
Brai SHALL store scheduled runtime handler due state in server SQLite and
SHALL keep handler descriptions in the existing `handlers` registry.

#### Scenario: Scheduled handler schema is initialized
- **WHEN** the Brai API store migrates
- **THEN** `handler_schedules` exists
- **AND** `table_descriptions` describes `handler_schedules`
- **AND** `maintenance.tasks_md_deduper` is registered in `handlers` as disabled legacy documentation
- **AND** its schedule is disabled because agent tasks now live in `activities` operation rows

#### Scenario: A recurring handler is due
- **WHEN** the scheduler runner sees an active schedule whose `next_run_at_utc`
  is in the past and whose lock is empty or expired
- **THEN** it claims the row before running the handler
- **AND** it clears the lock after completion
- **AND** it advances `next_run_at_utc` by the schedule interval after success
  or failure

### Requirement: Systemd wakes the scheduler runner
Brai SHALL use a systemd timer to wake the scheduled runtime handler
runner every five minutes.

#### Scenario: Scheduler timer elapses
- **WHEN** `brai-scheduler.timer` elapses
- **THEN** it starts `brai-scheduler.service`
- **AND** the service runs `services/brai_api/src/scheduler-runner.js`
- **AND** application ports remain unexposed

### Requirement: Legacy TASKS.md dedupe handler stays disabled
Brai SHALL NOT run the legacy `TASKS.md` dedupe handler after agent task tracking
moves into `activities` operation rows.

#### Scenario: Scheduler sees the legacy handler
- **WHEN** `maintenance.tasks_md_deduper` exists in `handlers`
- **THEN** its handler status is `disabled`
- **AND** its schedule status is `disabled`
- **AND** no `codex/tasks-md-dedupe-*` branch is created
