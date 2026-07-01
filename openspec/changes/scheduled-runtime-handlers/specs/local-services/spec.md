## ADDED Requirements

### Requirement: Scheduled runtime handlers use SQLite schedule state
Bright OS SHALL store scheduled runtime handler due state in server SQLite and
SHALL keep handler descriptions in the existing `handlers` registry.

#### Scenario: Scheduled handler schema is initialized
- **WHEN** the Bright OS API store migrates
- **THEN** `handler_schedules` exists
- **AND** `table_descriptions` describes `handler_schedules`
- **AND** `maintenance.tasks_md_deduper` is registered in `handlers`
- **AND** its schedule runs every six hours

#### Scenario: A recurring handler is due
- **WHEN** the scheduler runner sees an active schedule whose `next_run_at_utc`
  is in the past and whose lock is empty or expired
- **THEN** it claims the row before running the handler
- **AND** it clears the lock after completion
- **AND** it advances `next_run_at_utc` by the schedule interval after success
  or failure

### Requirement: Systemd wakes the scheduler runner
Bright OS SHALL use a systemd timer to wake the scheduled runtime handler
runner every five minutes.

#### Scenario: Scheduler timer elapses
- **WHEN** `brightos-scheduler.timer` elapses
- **THEN** it starts `brightos-scheduler.service`
- **AND** the service runs `services/bright_os_api/src/scheduler-runner.js`
- **AND** application ports remain unexposed

### Requirement: TASKS.md dedupe changes go through Git PR flow
Bright OS SHALL deduplicate root `TASKS.md` through a `codex/*` branch and PR,
not by directly mutating the production main checkout.

#### Scenario: TASKS.md has duplicate entries
- **WHEN** `maintenance.tasks_md_deduper` finds duplicate or redundant
  `TASKS.md` entries
- **THEN** it creates a `codex/tasks-md-dedupe-*` branch
- **AND** commits only `TASKS.md`
- **AND** pushes the branch
- **AND** opens a PR to `main`
- **AND** enables PR auto-merge with the branch head SHA

#### Scenario: TASKS.md has no duplicate entries
- **WHEN** the handler finds no required change
- **THEN** it creates no branch
- **AND** the schedule is still advanced to the next interval
