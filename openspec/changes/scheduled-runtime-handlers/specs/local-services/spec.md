## ADDED Requirements

### Requirement: Scheduled runtime agents use SQLite schedule state
Brai SHALL store scheduled runtime agent due state in server SQLite and
SHALL keep agent descriptions in the existing `agents` registry.

#### Scenario: Scheduled agent schema is initialized
- **WHEN** the Brai API store migrates
- **THEN** `agent_schedules` exists
- **AND** `table_descriptions` describes `agent_schedules`
- **AND** `maintenance.tasks_md_deduper` is absent from `agents`
- **AND** no schedule row exists for `maintenance.tasks_md_deduper`

#### Scenario: A recurring agent is due
- **WHEN** the scheduler runner sees an active schedule whose `next_run_at_utc`
  is in the past and whose lock is empty or expired
- **THEN** it claims the row before running the agent
- **AND** it clears the lock after completion
- **AND** it advances `next_run_at_utc` by the schedule interval after success
  or failure
- **AND** it writes exactly one `ai_logs` row for the run

### Requirement: Systemd wakes the scheduler runner
Brai SHALL use a systemd timer to wake the scheduled runtime agent
runner every five minutes.

#### Scenario: Scheduler timer elapses
- **WHEN** `brai-scheduler.timer` elapses
- **THEN** it starts `brai-scheduler.service`
- **AND** the service runs `services/brai_api/src/scheduler-runner.js`
- **AND** application ports remain unexposed

### Requirement: Legacy TASKS.md dedupe agent is removed
Brai SHALL NOT register or schedule the legacy `TASKS.md` dedupe agent.

#### Scenario: Store migration completes
- **WHEN** the Brai API store migrates
- **THEN** `maintenance.tasks_md_deduper` is absent from `agents`
- **AND** `maintenance.tasks_md_deduper` is absent from `agent_schedules`
- **AND** no `codex/tasks-md-dedupe-*` branch is created
