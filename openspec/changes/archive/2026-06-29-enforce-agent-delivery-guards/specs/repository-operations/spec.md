## MODIFIED Requirements

### Requirement: Task branches deploy through preview slots
Bright OS SHALL require ordinary feature, fix, refactor, and infrastructure implementation work that changes repository files to start from the latest `origin/dev` on a valid `codex/*` task branch, push the exact branch head to `origin`, complete preview delivery for that head, and use verified preview slot evidence before user-facing handoff.

Ordinary `codex/*` task branch pushes and preview deploys MUST be treated as
standing CI/CD automation approved by the project owner, not as optional
per-task manual confirmations.

Local tests, local builds, localhost URLs, and local dev servers MUST NOT be
treated as completion evidence for work that changes repository files.

#### Scenario: A project-file change begins
- **WHEN** work changes repository files in a new Codex thread
- **THEN** the agent starts from the latest accepted base using
  `scripts/bright-task-start.sh <task-slug>`
- **AND** the task branch marker identifies the created `codex/<task-slug>`
  branch and current thread before writes continue
- **AND** a branch selected by the agent host or UI is ignored as permission to
  change files

#### Scenario: Preview slots are full
- **WHEN** work changes repository files
- **AND** all preview slots `A` through `E` are occupied
- **THEN** the pushed branch is queued for the next released preview slot
- **AND** the handoff reports the queued state and queue position/source when
  available
- **AND** the agent does not describe the task as complete until a preview slot
  letter and URL exist

#### Scenario: Preview deployment is blocked
- **WHEN** work changes repository files
- **AND** the task branch cannot be pushed or deployed to a preview slot
- **THEN** the agent reports the exact push, CI, or deploy blocker
- **AND** the agent does not describe the task as complete

#### Scenario: Local verification passes without preview delivery
- **WHEN** local lint, tests, builds, browser checks, or a local dev server pass
- **AND** the exact branch head has not been pushed and deployed to a preview
  slot
- **THEN** the agent reports the work as incomplete or blocked
- **AND** the agent does not present local verification as the user-facing
  handoff

#### Scenario: Preview work is accepted
- **WHEN** the project owner accepts preview work
- **THEN** the agent runs `deploy/scripts/accept-preview.sh <codex-branch>`
  instead of replying with a text-only acknowledgement
- **AND** the script creates or reuses a GitHub pull request from the preview
  branch into `dev`
- **AND** the script enables merge or auto-merge for the exact pushed preview
  head commit
- **AND** the successful `deploy-dev` workflow promotes accepted preview
  metadata before releasing the preview slot
- **AND** preview-slot release is a required acceptance completion step and
  fails the workflow if the accepted branch did not release a slot
- **AND** the agent monitors the GitHub PR, merge queue, `deploy-dev`,
  metadata promotion, and preview-slot release until completion or an explicit
  blocker is known
- **AND** the work is merged into `dev` before production
- **AND** `dev` is promoted to `main` only after an explicit production release
  or merge request

#### Scenario: Preview work is not accepted yet
- **WHEN** the project owner uses a negated acceptance phrase such as
  "пока не принято" or "не принято"
- **THEN** the agent does not run the preview acceptance script
- **AND** the preview branch remains unmerged

## ADDED Requirements

### Requirement: Agent delivery guards fail closed
Bright OS SHALL block project-file writes, publication, and final handoff when agent delivery guard state cannot prove that the current task is on a valid same-thread task branch and has the required preview verification.

#### Scenario: Project-file write starts before valid task branch
- **WHEN** an agent attempts to change a repository file before a valid task
  branch and task marker exist
- **THEN** the write is blocked
- **AND** the blocker names `scripts/bright-task-start.sh <task-slug>` as the
  required next step

#### Scenario: Namespaced patch tool is used
- **WHEN** hook input identifies a write tool such as `functions.apply_patch`
- **THEN** the guard treats the tool as write-like
- **AND** the write is blocked unless the task branch and marker are valid

#### Scenario: Custom patch tool is used
- **WHEN** hook input identifies a custom tool call named `apply_patch`
- **THEN** the guard treats the tool as write-like
- **AND** the write is blocked unless the task branch and marker are valid

#### Scenario: Nested tool call contains a write
- **WHEN** hook input contains `multi_tool_use.parallel` with a nested write
  tool or write-like shell command
- **THEN** the guard recursively inspects the nested tool calls
- **AND** the write is blocked unless the task branch and marker are valid

#### Scenario: Hook input cannot be interpreted
- **WHEN** hook input, command shape, or tool identity cannot be interpreted
  safely
- **THEN** the guard blocks the action instead of allowing it by default

#### Scenario: Unknown shell command runs before task state exists
- **WHEN** an agent runs a shell command that is not explicitly classified as
  read-only
- **AND** valid task branch state does not exist
- **THEN** the command is treated as write-like
- **AND** the command is blocked

#### Scenario: Read-only command runs before task state exists
- **WHEN** an agent runs a command explicitly classified as read-only, such as
  inspecting status, files, diffs, or documentation
- **AND** valid task branch state does not exist
- **THEN** the command may run without creating a task branch

#### Scenario: Agent manually creates a task branch
- **WHEN** an agent attempts to create or switch to a `codex/*` branch through
  `git switch`, `git checkout`, `git branch`, or `git worktree`
- **THEN** the guard rejects the manual branch operation
- **AND** the blocker names the checked-in task starter or same-thread
  follow-up marker as the allowed path

#### Scenario: Task marker is missing or invalid
- **WHEN** the `.bright-task` marker is missing, forged, stale, belongs to
  another branch, or belongs to another thread
- **THEN** project-file writes, commits, pushes, and handoff are blocked

#### Scenario: Dirty tree reaches final handoff
- **WHEN** the working tree has unstaged or staged tracked changes
- **THEN** final handoff is blocked
- **AND** the blocker requires commit, push, and preview verification or an
  explicit incomplete status

#### Scenario: Clean local commit has no preview receipt
- **WHEN** the working tree is clean
- **AND** local implementation commits or branch diffs exist relative to
  `origin/dev`
- **AND** no preview handoff receipt exists for the exact `HEAD`
- **THEN** final handoff is blocked

#### Scenario: Branch is pushed without successful preview delivery
- **WHEN** the exact branch head is pushed
- **AND** successful `deploy-preview` evidence or equivalent Temporal preview
  state is missing
- **THEN** final handoff is blocked
- **AND** the agent reports the exact CI or deploy blocker instead of
  describing the work as complete

### Requirement: Preview acceptance requires verified preview
Bright OS SHALL refuse preview acceptance for a task branch unless the exact branch head has verified preview state.

#### Scenario: Acceptance starts without verified preview
- **WHEN** the project owner accepts a `codex/*` branch
- **AND** the exact branch head does not have a verified preview handoff receipt
  or equivalent successful preview delivery state
- **THEN** `deploy/scripts/accept-preview.sh <codex-branch>` refuses to create,
  merge, or auto-merge the acceptance pull request
- **AND** the agent reports the missing preview verification as a blocker

#### Scenario: Acceptance starts for verified preview
- **WHEN** the project owner accepts a `codex/*` branch
- **AND** the exact branch head has verified preview state
- **THEN** the acceptance flow may create or reuse the pull request into `dev`
- **AND** the merge or auto-merge targets the exact verified head commit
