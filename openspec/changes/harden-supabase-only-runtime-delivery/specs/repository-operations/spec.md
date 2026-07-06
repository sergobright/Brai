## MODIFIED Requirements

### Requirement: Task branches deploy through preview slots
Agents working on ordinary Brai feature, fix, refactor, or infrastructure implementation tasks SHALL start from the latest `origin/main` branch unless the project owner explicitly requests another base.

Ordinary `codex/*` task branch pushes to `origin` and their preview deploys SHALL be treated as standing Brai CI/CD automation approved by the project owner, not as optional per-task manual confirmations.

Infrastructure/documentation-only task branches MAY skip preview slot allocation only when Temporal classifies the branch as `deliveryClass=infra-docs` and records `no_preview_required`.

Technical test-only task branches MAY skip preview slot allocation only when Temporal classifies the branch as `deliveryClass=technical-no-preview` and records `no_preview_required`.

Native-boundary preview branches SHALL publish a slot-specific preview APK before handoff, and accepted native work SHALL rebuild the stable Production, Dev, and Preview A-E APK baseline from production source.

#### Scenario: Preview work is accepted
- **WHEN** the project owner accepts preview work
- **THEN** the agent runs `deploy/scripts/accept-preview.sh <codex-branch>` instead of replying with a text-only acknowledgement
- **AND** the script creates or reuses a GitHub pull request from the preview branch into `main`
- **AND** the script enables merge or auto-merge for the exact pushed preview head commit
- **AND** the successful `deploy-prod` workflow promotes accepted preview metadata before releasing the preview slot
- **AND** preview-slot release is a required acceptance completion step and fails the workflow if the accepted branch did not release a slot
- **AND** stale previously accepted preview cleanup remains best-effort and cannot make the required accepted branch pass
- **AND** the agent monitors the GitHub PR, merge queue, `deploy-prod`, metadata promotion, and preview-slot release until completion or an explicit blocker is known
- **AND** the work is merged into `main` before production deploy

### Requirement: Agent delivery guards fail closed
Brai SHALL block project-file writes, commits, pushes, and final handoff when local guard state cannot prove that the current task is on a valid same-thread `codex/*` branch from `origin/main` and has the required delivery verification.

#### Scenario: Delivery classification fails in CI
- **WHEN** the delivery classifier fails on a `codex/*` push before producing a delivery class
- **THEN** CI signals Temporal with `delivery_classification_failed`
- **AND** the workflow fails closed
- **AND** no preview, no-preview handoff, or auto-merge job starts from an unknown classification
