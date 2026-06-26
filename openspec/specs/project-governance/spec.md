# Project Governance Specification

## Purpose

This specification defines the durable workflow and documentation rules for Bright OS so future project work has a stable source of truth.

## Requirements

### Requirement: OpenSpec is the accepted requirements source
Accepted durable requirements for Bright OS SHALL be recorded under `openspec/specs/`.

#### Scenario: Durable project rule is discovered
- **WHEN** a durable behavior, architecture constraint, workflow rule, local service, or project invariant is established
- **THEN** the requirement is recorded or updated in `openspec/specs/`

### Requirement: Planned changes use OpenSpec changes
Planned requirement changes MUST be represented under `openspec/changes/<change-id>/` before implementation begins.

#### Scenario: New feature or behavior is requested
- **WHEN** work changes accepted requirements or adds a new capability
- **THEN** a change directory is created with proposal, spec deltas, tasks, and design when needed before implementation

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

### Requirement: Main entities are registered in items
Bright OS SHALL treat the server SQLite `items` table as the registry of main work entities.

#### Scenario: Main entity is used in technical work
- **WHEN** a schema, workflow, API, or project decision refers to a main Bright OS work entity
- **THEN** it uses an entity id registered in the `items` table

#### Scenario: Initial main entity registry is created
- **WHEN** the server database schema is initialized or migrated to the main entity registry
- **THEN** the `items` table contains the `activities` entity

### Requirement: Server schema metadata is registered in table_descriptions
Bright OS SHALL treat the server SQLite `table_descriptions` table as the registry for schema metadata.

#### Scenario: Server schema metadata changes
- **WHEN** a server SQLite change adds or changes a table, column, index, relationship, dependency, or schema purpose
- **THEN** the same change updates `table_descriptions`
- **AND** content-only row changes do not require `table_descriptions` updates

### Requirement: SocratiCode is used for semantic code search
Agents and maintainers MUST use SocratiCode for semantic code search after confirming the project codebase index is complete.

#### Scenario: Semantic code search is needed
- **WHEN** an agent needs to find code by behavior, responsibility, feature, or natural-language meaning
- **THEN** the agent checks the SocratiCode index status and uses SocratiCode search once indexing is complete

#### Scenario: Exact repository inspection is needed
- **WHEN** an agent needs exact string matching, file discovery, or non-semantic repository inspection
- **THEN** the agent may use `rg` or equivalent local shell tools

### Requirement: Conversational questions are answered directly
If a user's message ends with a question, the assistant MUST answer directly instead of starting implementation or tool work unless the user explicitly asks to proceed.

#### Scenario: User asks a question
- **WHEN** the latest user message ends with a question mark
- **THEN** the assistant answers conversationally and does not begin file edits or commands without an explicit instruction to proceed
