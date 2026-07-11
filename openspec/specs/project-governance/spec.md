# Project Governance Specification

## Purpose

This specification defines the durable workflow and documentation rules for Brai so future project work has a stable source of truth.

## Requirements

### Requirement: OpenSpec is the accepted requirements source
Accepted durable requirements, architecture rules, workflow rules, and system invariants for Brai SHALL be recorded under `openspec/specs/`.

#### Scenario: Durable project rule is discovered
- **WHEN** a durable behavior, architecture constraint, workflow rule, local service, or project invariant is established
- **THEN** the requirement is recorded or updated in `openspec/specs/`

#### Scenario: System architecture is defined
- **WHEN** Brai defines durable system architecture in human-readable form
- **THEN** OpenSpec contains the accepted source of truth for that architecture
- **AND** implementation-specific documentation does not override accepted OpenSpec requirements

### Requirement: Planned changes use OpenSpec changes
Planned requirement changes MUST be represented under `openspec/changes/<change-id>/` before implementation begins.

#### Scenario: New feature or behavior is requested
- **WHEN** work changes accepted requirements or adds a new capability
- **THEN** a change directory is created with proposal, spec deltas, tasks, and design when needed before implementation

#### Scenario: Architecture, data model, or workflow changes are planned
- **WHEN** a planned change affects architecture, data models, dependencies, security, performance, migration, workflows, or more than one module
- **THEN** the OpenSpec change includes `design.md`
- **AND** workflow changes are planned through OpenSpec before implementation code changes

#### Scenario: Architecture documentation is requested during OpenSpec preparation
- **WHEN** an OpenSpec preparation task defines future system architecture
- **THEN** it records the planned architecture inside the change directory
- **AND** it does not create tracked documentation outside the change folder unless the task explicitly asks for accepted docs updates

### Requirement: Completed changes are archived into specs
Completed OpenSpec changes SHALL be archived so accepted deltas are merged into `openspec/specs/` and historical change material moves under `openspec/changes/archive/`.

#### Scenario: Implementation and verification are complete
- **WHEN** all tasks for a change are complete and verification has passed or been documented
- **THEN** the change is archived and the main specs reflect the accepted behavior

#### Scenario: OpenSpec validation is run with completed active changes
- **WHEN** `npm run openspec:validate` is run
- **THEN** project tooling fails if a non-archived change has a `tasks.md` file with all task checkboxes marked complete
- **AND** the failure lists the completed active change ids so they can be archived or reopened with an explicit unfinished task

### Requirement: Memory Bank remains durable context
The project SHALL maintain `memory-bank/` as durable context for goals, decisions, active work, technical notes, and verification status.

#### Scenario: Project context changes
- **WHEN** project goals, architecture, active work, decisions, or verification status changes
- **THEN** the relevant Memory Bank file is updated with small factual notes

### Requirement: Explicit memory requests are recorded durably
When the project owner asks to "зафиксировать" information, a rule, preference, correction, decision, or project context, agents SHALL update durable project memory instead of only acknowledging it in chat.

#### Scenario: the project owner asks to record context
- **WHEN** the project owner asks to "зафиксировать" context, a correction, or a standing instruction
- **THEN** the agent updates the appropriate durable source: `AGENTS.md` for agent behavior, `openspec/specs/` for accepted workflow or product requirements, and/or `memory-bank/` for factual project context and decisions
- **AND** the agent does not claim the information is remembered until the durable source is updated

### Requirement: Blockers are resolved before fallbacks
Agents SHALL not ignore blockers, work around them silently, or invent replacements before checking whether the blocker can be solved.

#### Scenario: A blocker is encountered
- **WHEN** a task hits a missing access, unavailable tool, failed registry, failed command, rate limit, permission error, or comparable blocker
- **THEN** the agent identifies the blocker and checks the supported way to solve it
- **AND** tries the supported fix when it is available and safe
- **AND** asks the project owner for the required action when solving the blocker needs owner access, approval, credentials, or purchase decision

#### Scenario: A fallback is considered
- **WHEN** the original path is blocked
- **THEN** the agent uses an alternative path only after the blocker is solved or the project owner explicitly approves the workaround
- **AND** the agent does not present a workaround as if it were the requested source or behavior

### Requirement: Repository state is verified directly
Agents and maintainers MUST verify actual repository files before relying on Memory Bank or OpenSpec summaries.

#### Scenario: Documentation conflicts with files
- **WHEN** Memory Bank or OpenSpec content conflicts with the current repository state
- **THEN** the repository state is treated as authoritative and the stale documentation is corrected

### Requirement: Runtime facts are verified directly
Agents and maintainers MUST verify runtime tables, services, deployments, and environment-specific state against the actual target environment before recording rules or reporting completion.

#### Scenario: Runtime database fact is used
- **WHEN** work depends on a runtime database table, schema, row, migration state, or environment-specific ledger
- **THEN** the agent verifies the actual target environment and protected DSN source with read-only inspection
- **AND** verifies table presence, schema, indexes, and relevant rows before making claims or changing durable rules
- **AND** does not infer runtime state from repository code, migrations, screenshots, or user wording alone

#### Scenario: Non-visual runtime change is handed off
- **WHEN** a user cannot visually verify a runtime or database change
- **THEN** the handoff includes the environment, DSN source without secrets, system checked, and key query or command results

### Requirement: Main entities are registered in items
Brai SHALL treat the server Supabase Postgres `items` table as the registry of main work entities.

#### Scenario: Main entity is used in technical work
- **WHEN** a schema, workflow, API, or project decision refers to a main Brai work entity
- **THEN** it uses an entity id registered in the `items` table

#### Scenario: Initial main entity registry is created
- **WHEN** the server database schema is initialized or migrated to the main entity registry
- **THEN** the `items` table contains the `activities` entity

### Requirement: Server schema metadata is registered in table_descriptions
Brai SHALL treat the server Supabase Postgres `table_descriptions` table as the registry for schema metadata.

#### Scenario: Server schema metadata changes
- **WHEN** a server Postgres change adds or changes a table, column, index, relationship, dependency, or schema purpose
- **THEN** the same change updates `table_descriptions`
- **AND** content-only row changes do not require `table_descriptions` updates

### Requirement: Runtime operation logging uses logs
Brai SHALL use the server Postgres `logs` table for compact non-AI runtime and operation facts, while `ai_logs` remains dedicated to AI-agent executions.

#### Scenario: Runtime operation pattern changes
- **WHEN** a runtime/API/sync/deploy/admin/auth/background/native/server side effect is added or changed
- **THEN** the same change evaluates and updates the relevant `logs` writer, reader, metadata, and tests when useful
- **AND** the log row stores bounded summaries such as operation, status, reason, duration, correlation ids, counts, and compact flags
- **AND** secrets, credentials, tokens, cookies, OTP, passwords, raw payloads, full stdout/stderr, base64, transcripts, file paths, and large AI outputs are not stored in `logs`

### Requirement: Database foreign keys use parent table names
Brai SHALL name any new or renamed database foreign-key column that references `<parent_table>.id` as `<parent_table>_id`.

#### Scenario: Foreign-key column is created or renamed
- **WHEN** a database schema change creates or renames a foreign-key column referencing `items.id`
- **THEN** the column is named `items_id`
- **AND** a foreign-key column referencing `item_role_types.id` is named `item_role_types_id`
- **AND** shortened names such as `item_id`, `role_type_id`, or `event_type_id` are not introduced for plural parent tables

### Requirement: SocratiCode is used for semantic code search
Agents and maintainers MUST use SocratiCode for semantic code search after confirming the project codebase index is complete. Brai SHALL keep `/srv/projects/brai` on one canonical shared SocratiCode index, `codebase_brightos_brai`, with automatic file watching and fail-closed freshness checks.

#### Scenario: Semantic code search is needed
- **WHEN** an agent needs to find code by behavior, responsibility, feature, or natural-language meaning
- **THEN** the agent checks the SocratiCode index status and uses SocratiCode search once indexing is complete

#### Scenario: SocratiCode context artifacts are maintained
- **WHEN** agent-facing docs, OpenSpec requirements, or Memory Bank context are expected to be semantically searchable
- **THEN** the project declares them in `.socraticodecontextartifacts.json`
- **AND** SocratiCode context search is available for those artifacts after indexing

#### Scenario: Git worktrees share one SocratiCode index
- **WHEN** Brai is opened from the main checkout or any `codex/*` git worktree
- **THEN** the project resolves one stable shared SocratiCode `projectId` from committed `.socraticode.json`
- **AND** semantic code search, code graph, and context artifacts use the same shared collections across those worktrees

#### Scenario: SocratiCode freshness is checked
- **WHEN** SocratiCode behavior, agent rules, OpenSpec routing, or repository context indexing changes
- **THEN** `npm run socraticode:ensure` can create or catch up the shared index, refresh context artifacts, rebuild stale code graphs, and start the watcher
- **AND** `npm run socraticode:preflight` verifies the local MCP config, canonical shared collection, context artifact registry, complete shared index, fresh code graph, and active watcher state
- **AND** stale or incomplete SocratiCode state is a blocking preflight failure

#### Scenario: SocratiCode watcher is managed as runtime support
- **WHEN** the Brai host boots or SocratiCode watcher process exits
- **THEN** `brai-socraticode-watcher.service` restarts the watcher daemon for `/srv/projects/brai`
- **AND** the daemon runs safe catch-up on startup and every 60 seconds while file watching remains the primary freshness mechanism

#### Scenario: Implementation work is handed off
- **WHEN** an agent has implementation work to hand off
- **THEN** the task marker must show SocratiCode was used through a codebase status, search, context search, graph, or symbol query
- **AND** handoff and final Stop checks fail closed when the marker is missing
- **AND** exact string or file discovery may bypass SocratiCode only with an explicit `socraticode-exact-only` task marker reason

#### Scenario: Exact repository inspection is needed
- **WHEN** an agent needs exact string matching, file discovery, or non-semantic repository inspection
- **THEN** the agent may use `rg` or equivalent local shell tools

### Requirement: Conversational questions are answered directly
If a user's message ends with a question, the assistant MUST answer directly instead of starting implementation or tool work unless the user explicitly asks to proceed.

#### Scenario: User asks a question
- **WHEN** the latest user message ends with a question mark
- **THEN** the assistant answers conversationally and does not begin file edits or commands without an explicit instruction to proceed
