# Repository Operations Specification

## Purpose

This specification captures accepted repository structure, tooling, runtime, and synchronization rules for Bright OS work.
## Requirements
### Requirement: Repository assumptions are explicit
The repository SHALL document product behavior, runtime stack, and architecture assumptions before future work depends on them.

#### Scenario: Future work needs product or stack assumptions
- **WHEN** a task depends on product behavior, runtime stack, or architecture that is not present in the repository
- **THEN** the missing assumption is documented instead of being treated as already decided

### Requirement: Top-level documentation structure is stable
The repository SHALL keep top-level project documentation in `README.md`, `AGENTS.md`, `memory-bank/`, and `openspec/`.

#### Scenario: Durable process documentation is added
- **WHEN** project process or requirement documentation is added
- **THEN** it is placed in the existing documentation structure unless a change establishes a new structure

### Requirement: Commit requests synchronize to the remote repository
When the project owner asks to create a commit, commit, fix a version, save the version, or otherwise "зафиксировать" repository work, agents SHALL stage the intended changes, commit them on the current branch, and push that branch to `origin` unless the project owner explicitly requests local-only behavior.

#### Scenario: the project owner asks to save repository work
- **WHEN** the project owner requests a commit or saved version without saying local-only/no-push
- **THEN** the resulting version is committed in git
- **AND** the branch is pushed to `origin`
- **AND** the agent does not describe the version as saved for future threads until the remote push succeeds

### Requirement: Public main starts from a clean baseline
The public repository SHALL start from a clean baseline history rather than exposing private bootstrap history.

#### Scenario: Public repository is initialized
- **WHEN** the public repository receives its initial `main`
- **THEN** reachable Git history contains only public-baseline commits
- **AND** runtime databases, generated deployment artifacts, signing material, local backups, private keys, and personal workspace notes are absent from the tree and history

### Requirement: Public hygiene gate protects every branch class
Bright OS SHALL run the public branch guard before accepting source into `main`, `dev`, or `codex/*`.

#### Scenario: A branch or pull request is checked
- **WHEN** GitHub Actions runs for `main`, `dev`, a `codex/*` branch, or a pull request targeting `main` or `dev`
- **THEN** `scripts/check-public-branch.mjs` runs against the checkout with reachable history available
- **AND** the workflow fails on forbidden paths, signing files, credential-like files, high-confidence secrets, local workspace paths, or personal markers

### Requirement: Task branches deploy through preview slots
Agents working on ordinary Bright OS feature, fix, refactor, or infrastructure implementation tasks SHALL start from the latest `origin/main` branch unless the project owner explicitly requests another base.

Ordinary `codex/*` task branch pushes to `origin` and their preview deploys SHALL be treated as standing Bright OS CI/CD automation approved by the project owner, not as optional per-task manual confirmations.

Infrastructure/documentation-only task branches MAY skip preview slot allocation only when Temporal classifies the branch as `deliveryClass=infra-docs` and records `no_preview_required`.

Native-boundary preview branches SHALL publish a slot-specific APK before handoff, and accepted native work SHALL rebuild the shared Preview A-E APK baseline from production source during slot release.

#### Scenario: Preview-class project-file change begins
- **WHEN** preview-class work changes repository files
- **THEN** the agent creates or continues an appropriate `codex/<task-slug>` branch
- **AND** the pushed branch is deployed to a preview slot before user-facing handoff
- **AND** the handoff names the preview slot letter and URL

#### Scenario: Preview slots are full
- **WHEN** work changes repository files
- **AND** all preview slots `A` through `E` are occupied
- **THEN** the pushed branch is queued for the next released preview slot
- **AND** the handoff reports the queued state and queue position/source when available
- **AND** the agent does not describe the task as complete until a preview slot letter and URL exist

#### Scenario: Preview deployment is blocked
- **WHEN** work changes repository files
- **AND** the task branch cannot be pushed or deployed to a preview slot
- **THEN** the agent reports the exact push, CI, or deploy blocker
- **AND** the agent does not describe the task as complete

#### Scenario: Native preview branch is handed off
- **WHEN** a `codex/*` branch changes native Android behavior
- **THEN** the handoff includes the preview APK link and Android `versionCode`

#### Scenario: Native preview branch is accepted
- **WHEN** a native preview branch is merged into `main`
- **THEN** the shared preview APK baseline is rebuilt from production source during slot release

#### Scenario: Infrastructure docs work does not need a preview slot
- **WHEN** work changes only infrastructure or documentation files that do not need a runnable preview
- **AND** Temporal records `delivery_classified` with `deliveryClass=infra-docs`
- **AND** Temporal records `no_preview_required`
- **THEN** Temporal marks `preview_deploy`, `accepted_preview_promotion`, and `slot_release` as `not_applicable`
- **AND** the handoff reports the branch, commit, `deliveryClass=infra-docs`, `handoff=passed`, and `autoMerge=enabled` instead of a preview slot URL
- **AND** `pr_merged` completes the branch lifecycle without requiring a preview slot release

#### Scenario: Preview work is accepted
- **WHEN** the project owner accepts preview work
- **THEN** the agent runs `deploy/scripts/accept-preview.sh <codex-branch>` instead of replying with a text-only acknowledgement
- **AND** the script creates or reuses a GitHub pull request from the preview branch into `main`
- **AND** the script enables merge or auto-merge for the exact pushed preview head commit
- **AND** the successful `deploy-prod` workflow promotes accepted preview metadata before releasing the preview slot
- **AND** preview-slot release is a required acceptance completion step and fails the workflow if the accepted branch did not release a slot
- **AND** the agent monitors the GitHub PR, merge queue, `deploy-prod`, metadata promotion, and preview-slot release until completion or an explicit blocker is known
- **AND** the work is merged into `main` before production deploy

#### Scenario: Preview work is not accepted yet
- **WHEN** the project owner uses a negated acceptance phrase such as "пока не принято" or "не принято"
- **THEN** the agent does not run the preview acceptance script
- **AND** the preview branch remains unmerged

### Requirement: OpenSpec CLI is pinned as project tooling
The project SHALL pin `@fission-ai/openspec` as development tooling and require the supported Bright OS Node 22 runtime for OpenSpec CLI usage.

#### Scenario: OpenSpec commands are run
- **WHEN** a maintainer runs OpenSpec through project tooling
- **THEN** the command uses the pinned package version
- **AND** it uses the supported Bright OS Node runtime under `/srv/opt/node-v22.16.0` or an explicitly approved successor runtime
- **AND** it resolves the package binary instead of executing the repository `openspec/` directory by name

### Requirement: Repository includes Next Capacitor client after migration
The Bright OS repository SHALL include a Next.js/Capacitor client as the primary future client after this migration is implemented.

#### Scenario: Migration source is present
- **WHEN** the repository is inspected after the migration
- **THEN** the active client source is placed under `apps/bright_os_app`
- **AND** generated build artifacts remain out of source control unless explicitly accepted as deployment artifacts

### Requirement: Retired client source is removed after cutover
The Bright OS repository SHALL not keep the retired pre-migration client source as an active rollback surface after cutover.

#### Scenario: Cutover is complete
- **WHEN** the Next.js web app and Capacitor Android app are the active release
- **THEN** future product development targets the Next.js/Capacitor client
- **AND** retired client source and release artifacts are removed from current project state

### Requirement: Bright OS uses one supported Node runtime
Bright OS repository commands and runtime services SHALL use the supported Node.js runtime installed under `/srv/opt/` instead of relying on the host default `node`.

#### Scenario: Root project command is run from a clean shell
- **WHEN** a maintainer runs an ordinary Bright OS root command such as `npm run app:build`, `npm run app:test`, or `npm run openspec:validate`
- **THEN** the command uses the supported Bright OS Node runtime
- **AND** it does not execute with `/usr/bin/node` when that binary is an unsupported Node version

#### Scenario: Unsupported Node is first in PATH
- **WHEN** `/usr/bin/node` resolves to a Node version below the Bright OS requirement
- **THEN** Bright OS tooling fails fast with a clear runtime error or selects the supported `/srv/opt/` runtime before running project code

#### Scenario: Node engine metadata is inspected
- **WHEN** Bright OS root or app package metadata declares a Node.js engine
- **THEN** the declared engine requires Node.js `>=22.0.0`
- **AND** it remains compatible with the approved runtime at `/srv/opt/node-v22.16.0`

#### Scenario: Host-level Node removal is considered
- **WHEN** maintainers consider removing or disabling the system Node.js package
- **THEN** they first verify registered services and installed tools outside Bright OS do not depend on it
- **AND** they update the runtime/service registry outside the repository in the same change if Node.js installation or usage changes
