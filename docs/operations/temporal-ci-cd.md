# Temporal CI/CD Orchestration

Brai uses self-host Temporal as the required CI/CD orchestrator for branch previews and promotions. GitHub Actions still runs branch-protection checks and reports external facts, but deploy, release, promotion, and cleanup side effects run as Temporal activities around the existing shell scripts. Temporal is not exposed publicly and no deploy ports are opened.

## Product Workflow Isolation

Inbox normalization is a product workflow and does not run on the CI/CD worker queues. Each Brai API environment starts an embedded Temporal worker from the same deployed source and polls `brai-inbox-normalization-<api-port>`, so production, Dev, and every preview use their own Postgres schema, attachment root, code version, and task queue.

The API starts `InboxNormalizationWorkflow` with stable id `brai:inbox:<inbox-id>`. Workflow code is deterministic; Postgres, file, and LLM work runs only in Activities. `workflow_executions` is the compact product/Admin read model, while Temporal history remains the durable orchestration record. The global `brai-temporal-worker.service` continues to poll only `brai-preview` and `brai-promotion`.

On startup, each API environment reconciles raw Inbox executions still marked `queued`. Starting with the same workflow id is idempotent, so a process crash between Postgres ingest and Temporal start cannot strand the raw record.

## Goal Agent Product Workers

Relations/Goals adds five product worker families; the API-owned context queue is
control-plane infrastructure and is not a sixth agent:

| Agent | Production unit | Queue base |
| --- | --- | --- |
| `activity.classifier` | `brai-agent-activity-classifier.service` | `brai-agent-activity-classifier` |
| `goal.item-matcher` | `brai-agent-goal-item-matcher.service` | `brai-agent-goal-item-matcher` |
| `goal.member-finder` | `brai-agent-goal-member-finder.service` | `brai-agent-goal-member-finder` |
| `goal.discovery` | `brai-agent-goal-discovery.service` | `brai-agent-goal-discovery` |
| `goal.planner` | `brai-agent-goal-planner.service` | `brai-agent-goal-planner` |

Dev appends `-dev` to each unit and `-dev` to each queue base. Preview slots use
`-preview-a` through `-preview-e`. The environment's Brai API separately polls
`brai-agent-context-<environment>`. Deployment health is successful only when
all of the following refer to the exact deployed environment and immutable
workflow definition: systemd unit, agent queue, Temporal poller identity,
workflow type, worker build reference, definition version/hash, and API context
poller. A poller/build from Production, Dev, or another Preview never satisfies
the gate. The branch Preview gate must also inspect the live server as Temporal
Server 1.29.x and complete one real agent-to-API cross-queue context workflow;
unit tests and task-queue description alone are insufficient runtime proof.

The five services run under the dedicated non-login Unix identity
`brai-goal-agent:brai-goal-agent`. They read only
`/etc/brai/brai-goal-agents.env`, which is installed as
`root:brai-goal-agent` mode `0640`. That user must belong to neither `brai` nor
`brai-deploy`; its only supplementary groups are `brai-codex-exec` and
`brai-codex-auth`. It must not read
`/etc/brai/brai-api.env`, and receives no DB URL, Brai API secret, Caddy/deploy
credential, or signing material. Goal-agent units have no public listener or
Caddy route. `CODEX_HOME=/srv/opt/codex-runtime/brai-goal-agent` is `0700`,
shared Codex authentication is group-scoped read-only, deployed source is
read/execute-only to the agent group, and systemd unsets inherited
DB/Supabase/Brai API variables. The managed Codex release sync invokes the same
fixed root-owned runtime helper after every CLI package update, and the independent
Goal-agent deployment gate invokes it again immediately before restart. Verify the effective boundary without printing
environment values:

```bash
id brai-goal-agent
sudo -u brai-goal-agent test ! -r /etc/brai/brai-api.env
systemctl show brai-agent-goal-planner.service -p User -p Group -p SupplementaryGroups -p EnvironmentFiles
```

The API context worker is the only database authority. Every context Activity
must arrive from a real Temporal workflow on the exact context queue. It checks
`activityInfo()` workflow ID/type/run against the frozen execution contract and
checks a per-execution 32-byte capability against the stored SHA-256 digest.
The first valid call atomically binds the actual run ID; a wrong workflow/type,
queue, capability, run, direct call, or reference replay fails closed before a
context descriptor/page is returned. Never place the raw capability in logs,
Admin, model input, or diagnostic output.

To disable all new automatic Goal-agent work in one environment, set
`BRAI_GOAL_AGENTS_ENABLED=false` in that environment's protected Brai API
configuration, restart only its Brai API unit, and stop its five exact
environment-qualified Goal-agent units. This prevents new context workers,
reconciliation, dispatch, planner requests, and model executions; existing
queued rows and discovery watermarks remain untouched. Manual Goal/Relation HTTP
and sync commands and existing Inbox normalization continue. Restore the flag,
restart the API, start the five units, and pass the exact queue/build/poller
health gate to re-enable. Do not delete canonical Relations, decisions, queued
executions, or watermarks as a rollback mechanism.

Failure isolation is per agent queue: a stopped planner leaves planner workflows
queued/retrying but does not justify routing them to another agent or stopping
manual Goal/Relation work. Check the environment-specific unit journal, API
context poller heartbeat, workflow execution/attempt, and `ai_logs` provenance;
do not infer domain success from an ordinary process log alone.

## Process Change Rule

Any change to Brai CI/CD must update the Temporal contract in the same branch when the change adds, removes, reorders, or changes an operation that must always happen, can block delivery, or needs manual recovery. Do not add a hidden deploy side effect only inside a shell script or GitHub Actions step.

For a new required operation, add the matching Temporal event/state before shipping the process change:

- workflow state task in `services/brai_temporal/src/state.mjs`;
- allowlisted client event in `services/brai_temporal/src/client.mjs`;
- workflow activity/dispatch code around the existing command;
- state test in `services/brai_temporal/test/state.test.mjs`;
- docs in this file and, when agent behavior changes, `docs/operations/branch-preview-environments.md`.

Use started/passed/failed events for operations that can block delivery. Examples: publishing an accepted version to another system, uploading an artifact, adding a manual approval gate, changing slot release semantics, or adding a production verification step. If the operation is optional telemetry, document why it is not a Temporal gate.

## Terms

- Temporal address: `127.0.0.1:7233` on the VPS. It is not exposed publicly.
- Worker service: `brai-temporal-worker.service`.
- Preview task queue: `brai-preview`.
- Promotion task queue: `brai-promotion`.
- Preview workflow ID: `brai:preview:<branch>`.
- Promotion workflow ID: `brai:promotion:<target>:<sha>`.
- State query name: `state`.
- Signal name: `event`.

## Preview Slot Lease Lifecycle

Preview slots are still allocated and released by the existing slot scripts:

1. A `codex/*` push starts or signals `BranchPreviewWorkflow`.
2. GitHub Actions signals `branch_pushed`, then `delivery_classified` or `delivery_classification_failed`.
3. GitHub Actions signals `checks_started`.
4. Existing `checks` job runs unchanged.
5. GitHub Actions signals `checks_passed` or `checks_failed`.
6. Preview-class branches continue to `deploy-preview`, which waits for `temporal-worker-check`.
7. GitHub Actions opens the existing SSH tunnel, starts a transient worker from the exact pushed checkout on `brai-preview-branch-<sha>`, and dispatches SHA-isolated workflow `brai:preview-deploy:<branch>:<sha>`. The long-lived `brai-temporal-worker.service` keeps the canonical branch ledger but never executes unaccepted branch orchestration code.
8. The SHA-isolated workflow records `preview_deploy_started` and `supabase_preview_started`, then an activity runs `deploy/scripts/ci-ssh-deploy.sh` from the exact checkout. Before dependency install, migration, or source swap, the remote helper verifies the dedicated user/group, Goal-agent EnvironmentFile, and all five target-environment units. For an existing target, after dependencies are staged and while its deploy lock is held, the helper gracefully stops and fully quiesces only the exact API producer, then checks old target DB and Temporal nonterminal Goal-agent state against the incoming content-bound agent and API-context builds. Old/different/unknown builds or an unavailable existing-target check fail before source swap and restart the old API. A genuinely absent source with an inactive API is the only first-install exception. Valid same-build nonterminal Dev/Preview work forces branch-bound preservation of existing target data instead of Production reseed; otherwise the ordinary refresh may run. The helper applies migrations/data setup from the incoming checkout and repeats the bounded exact-environment DB/Temporal check before swap. A source swap is provisional until the exact new API passes bounded health; failure first restores prior source/API state. Generic deployment then publishes web/Admin and restarts Admin only; it does not restart the five Goal-agent workers and leaves the slot lease in `deploying`.
9. After generic deployment passes, the workflow records `goal_agents_deploy_started` and runs an independent Goal-agent restart/verification activity. Before restart it invokes the fixed root-owned runtime helper through the narrow deploy sudo rule; the helper restores only the shared Codex package's `brai-codex-exec` access and proves real CLI startup as `brai-goal-agent`. The same activity then proves five exact environment pollers/builds, the API context poller, worker-deployment promotion, and one bounded non-destructive real agent-to-API cross-queue workflow on the deployed Temporal Server 1.29.x. Any preparation failure is reported by the existing `goal_agents_deploy_failed` gate. A final activity may mark the slot `ready` only by compare-and-set on the same branch/SHA lease. The workflow then records `goal_agents_deploy_passed` and `preview_deploy_passed`; each phase reports only its own failure.
10. A failed classification, check, Supabase preview branch, Goal-agent deploy, or preview deploy leaves workflow state at `waiting_for_fix`.
11. Accepted preview completion runs during production promotion activities. The accepted-preview helper signals the affected preview workflows with the source branch SHA while promotion/release scripts move metadata, release the Supabase preview branch, and free the slot.
12. Manual release requires a real slot release. Delete-triggered release is idempotent: if the slot was already released, Temporal records `branch_deleted`. Closing a `codex/*` PR without merge also runs slot release; if no slot is found, Temporal still records `slot_released` so abandoned preview workflows do not stay in release-started state.

Accepted PR conflict reconciliation does not add a separate Temporal gate. The agent resolves conflicts on the same `codex/*` branch and pushes a new head; the existing `branch_pushed`, `checks_*`, and `preview_deploy_*` events reset and reverify that head before `accept-preview.sh` enables auto-merge again.

The preview slot registry remains `/srv/projects/brai-envs/preview-slots.json`; Temporal does not replace that lock or registry. Commit-bearing updates are compare-and-set mutations. A late SHA A deploy cannot change a lease already advanced to SHA B, and handoff requires the exact SHA in the successful GitHub run, SHA-isolated Temporal workflow, and ready slot entry.

Native-boundary preview deploys may build a slot-specific APK inside the existing `preview_deploy_started` to `preview_deploy_passed` gate. Accepted native work rebuilds the production, Dev, and Preview A-E stable APK baselines during the production deploy from one static client export; preview slot release reuses the published stable slot APK when the release index and file are already present, and only rebuilds that slot as a fallback. These APK builds are required deploy/release substeps, not separate Temporal state transitions; failure still reports through `preview_deploy_failed`, `prod_deploy_failed`, or `slot_release_failed`.

Accepted `deploy-prod` reruns are idempotent after a partial success: if the preview slot was already released, promotion may pass only when the production build ledger already records the accepted branch for the target commit, and the release rerun records `slot_released` for the already-free slot instead of leaving the workflow blocked.

Branch cleanup is a required Temporal gate. Preview/test database schemas are removed before the preview slot can be released. After release, accepted-branch cleanup deletes remote refs through the GitHub API and prunes clean local task worktrees through main-sync. A database, branch, or worktree cleanup command failure keeps the workflow non-terminal at `waiting_for_fix`; rerunning the same delivery is idempotent.

## Infra Docs No-preview Path

Infrastructure/documentation-only branches can be classified as `deliveryClass=infra-docs`.
Strict technical-only branches that are proven by CI rather than browser review can be classified
as `deliveryClass=technical-no-preview`. These no-preview classes signal `no_preview_required`;
Temporal marks `supabase_preview`, `goal_agents_deploy`, `preview_deploy`,
`accepted_preview_promotion`, `supabase_preview_release`, and `slot_release` as
`not_applicable`, clears `slot`, and keeps
the branch in the same `BranchPreviewWorkflow` ledger. The state query exposes the
`deliveryClass`, `handoff`, and `autoMerge` fields for this path.

The no-preview path dispatches `no_preview_handoff_requested`; the workflow records
`delivery_handoff_started` and `auto_merge_started`, then an activity runs
`deploy/scripts/accept-preview.sh` from a temporary checkout of the exact pushed SHA.
`auto_merge_enabled` is only an intermediate state. Successful handoff is complete only after
the PR is actually merged: the `pull_request.closed` merge job dispatches
`no_preview_merged_requested`, the workflow records `delivery_handoff_passed`, runs accepted
branch cleanup as hygiene, then records `pr_merged` / `no_preview_merged`. Failed classification,
handoff, or auto-merge events set `status=waiting_for_fix` and populate `blocker`.

The agent-side `brai-task handoff` may pre-create the infra/docs PR with the agent's GitHub
identity so the Temporal no-preview handoff activity can reuse it even when the repository keeps
the default `GITHUB_TOKEN` unable to create pull requests. GitHub Actions must not push directly
to `main`. Local `brai-task handoff` does not write a success receipt until the PR
state is `MERGED` and the receipt includes PR number, URL, and `mergedAt`.

For no-preview classes, `pr_merged` marks the `accepted_for_target` (`Accepted for target`) task as passed.
The no-preview lifecycle completes only after all required gates are passed or not applicable, without
requiring accepted-preview metadata promotion or preview slot release.

## BranchPreviewWorkflow

`BranchPreviewWorkflow` keeps a bounded event log and the current checklist for a `codex/*` branch:

- `branch_pushed`
- `preview_deploy_requested`, `no_preview_handoff_requested`, `no_preview_merged_requested`, `slot_release_requested`
- `delivery_classified`, `delivery_classification_failed`
- `delivery_handoff_started`, `delivery_handoff_passed`, `delivery_handoff_failed`
- `auto_merge_started`, `auto_merge_enabled`, `auto_merge_failed`
- `no_preview_required`
- `checks_started`, `checks_passed`, `checks_failed`
- `supabase_preview_started`, `supabase_preview_passed`, `supabase_preview_failed`
- `goal_agents_deploy_started`, `goal_agents_deploy_passed`, `goal_agents_deploy_failed`
- `preview_deploy_started`, `preview_deploy_passed`, `preview_deploy_failed`
- `pr_merged`
- `accepted_preview_started`, `accepted_preview_promoted`, `accepted_preview_failed`
- `slot_release_started`, `slot_released`, `slot_release_failed`
- `supabase_preview_release_started`, `supabase_preview_released`, `supabase_preview_release_failed`
- `released`, `abandoned_closed`, `no_preview_merged`, `superseded_closed`, `branch_deleted`

The `state` query exposes `deliveryClass`, `handoff`, `autoMerge`, `tasks`, `missing`, `blocker`, and `blockers`. A new `branch_pushed` event resets the check/deploy/release checklist for the new SHA so old green state is not inherited. `delivery_classification_failed`, `delivery_handoff_failed`, `auto_merge_failed`, `checks_failed`, `supabase_preview_failed`, `goal_agents_deploy_failed`, `preview_deploy_failed`, `accepted_preview_failed`, `supabase_preview_release_failed`, and `slot_release_failed` set `status` to `waiting_for_fix` and populate `blocker`.

## PromotionWorkflow

`PromotionWorkflow` tracks accepted preview promotion, target deploy, and preview slot release:

- Workflow ID for production deploy: `brai:promotion:prod:<sha>`.
- Workflow ID for Dev deploy: `brai:promotion:dev:<sha>`.
- Prod dispatch/event sequence: `promotion_requested`, `prod_deploy_started`, `accepted_previews_started`, `supabase_prod_migration_started`, `prod_version_recorded`, `goal_agents_deploy_started`, `supabase_prod_migration_passed` or `supabase_prod_migration_failed`, `goal_agents_deploy_passed` or `goal_agents_deploy_failed`, `accepted_previews_passed` or `accepted_previews_failed`, `prod_deploy_passed` or `prod_deploy_failed`, `released`.
- Dev dispatch/event sequence: `promotion_requested`, `dev_deploy_started`, `dev_supabase_migration_started`, `goal_agents_deploy_started`, `dev_supabase_migration_passed` or `dev_supabase_migration_failed`, `goal_agents_deploy_passed` or `goal_agents_deploy_failed`, `dev_version_recorded`, `dev_deploy_passed` or `dev_deploy_failed`, `released`.

The production checklist requires Supabase migration/smoke, exact Goal-agent deployment health,
accepted-preview metadata promotion, version/ledger recording, deployment, and preview-slot cleanup. The production Supabase smoke
requires baseline runtime tables and deployment ledger tables to be present.
During the post-deploy accepted-preview release step, occupied preview OTA manifests are republished
from each preview slot's own source checkout so their `otaVersion` follows the production build
ledger without replacing preview content with production content. That refresh reuses the preview
source checkout's existing static export and only rewrites runtime config, `version.json`, and OTA
metadata. Failed preview slots are skipped by this OTA refresh because their source checkout may not
have a valid static export; recovering or releasing the failed preview remains a separate preview
workflow task. `prod_deploy_passed` completes the
promotion workflow only after prior required steps have succeeded in GitHub Actions. Russian
human-readable `build_versions` release notes are part of the existing version/ledger recording
step; changing their text source does not add a new Temporal gate.

Dev deploys are persistent-environment promotions from branch `dev`. They use the long-lived
Supabase branch `brai-dev`, do not refresh from production automatically after the first clone, and
do not require accepted-preview cleanup.

Deploy logic still lives in the existing scripts. Temporal activities are the required owner around
those scripts; GitHub branch protection, merge queue, preview slot locking, Supabase branch
lifecycle, and Postgres ledger writes remain the underlying authorities for their own data.

## Worker Permissions

The worker unit runs as `brai` with supplementary `brai-deploy` group and connects to local Temporal only:

```bash
sudo systemctl enable --now brai-temporal-worker.service
sudo systemctl status brai-temporal-worker.service
```

Install dependencies before enabling the unit:

```bash
npm --prefix /srv/projects/brai/services/brai_temporal ci
```

The unit loads `/etc/brai/brai-temporal-worker.env` if present. Ansible installs this file from
`deploy/ansible/templates/brai-temporal-worker.env.j2` and refuses to create the referenced
secret files from source. Create those files on the VPS outside Git before applying the playbook:

- `/etc/brai/brai-temporal-deploy-ssh-key` - private key that can SSH as `brai-deploy`;
- `/etc/brai/brai-temporal-github-token` - GitHub token for PR/branch cleanup and accepted-preview metadata.

The checked-in unit and template must not contain GitHub tokens, SSH keys, Caddy credentials,
database passwords, or Supabase secrets. Store only secret file paths or deploy coordinates there,
for example:

```text
/etc/brai/brai-temporal-worker.env
BRAI_TEMPORAL_DEPLOY_HOST=127.0.0.1
BRAI_TEMPORAL_DEPLOY_USER=brai-deploy
BRAI_TEMPORAL_DEPLOY_SSH_PORT=22
BRAI_TEMPORAL_DEPLOY_REPO=/srv/projects/brai
BRAI_TEMPORAL_DEPLOY_SSH_KEY_PATH=/etc/brai/brai-temporal-deploy-ssh-key
BRAI_TEMPORAL_GITHUB_TOKEN_PATH=/etc/brai/brai-temporal-github-token
GITHUB_REPOSITORY=sergobright/Brai
```

Do not add those values to repository docs.

## GitHub Actions Dispatch

GitHub Actions uses `deploy/scripts/ci-temporal-signal.sh` for both external fact signals and dispatch/wait commands. The helper opens an SSH tunnel to `127.0.0.1:7233` through the existing deploy SSH boundary, runs the local Temporal client, then closes the tunnel. It does not open Temporal or Postgres ports externally.

The delivery workflow sets `BRAI_TEMPORAL_REQUIRED=true`. If Temporal, SSH tunnel setup, or the client call fails, the relevant CI/CD job fails and the deploy/release must be retried after the Temporal blocker is fixed. The helper default remains best-effort only for ad hoc local/manual commands that do not set `BRAI_TEMPORAL_REQUIRED=true`.

## Manual Smoke Test

Start the worker:

```bash
TEMPORAL_ADDRESS=127.0.0.1:7233 npm --prefix services/brai_temporal start
```

Start a fake preview workflow:

```bash
TEMPORAL_ADDRESS=127.0.0.1:7233 npm --prefix services/brai_temporal run signal -- demo --branch codex/temporal-smoke
```

Query state:

```bash
TEMPORAL_ADDRESS=127.0.0.1:7233 npm --prefix services/brai_temporal run signal -- query-preview --branch codex/temporal-smoke
```

Inventory running workflows:

```bash
TEMPORAL_ADDRESS=127.0.0.1:7233 npm --prefix services/brai_temporal run signal -- inventory --status RUNNING --prefix brai:
```

The inventory output groups rows by workflow family and by operational category:
`active`, `blocked`, `stale`, and `legacy`.

Then open `https://temporal.brai.one` with the unified Caddy basic auth and look for workflow ID `brai:preview:codex/temporal-smoke`.

## Failure And Manual Recovery

- One-time post-orchestrator recovery: run `inventory --status RUNNING`; terminate legacy
  `bright-os:*` workflows because no worker polls those task queues; release failed preview slots
  with `dispatch-release-preview --close-outcome released --require-release true`; and rerun or
  supersede stale `brai:promotion:prod:*` workflows. A successful new prod promotion automatically
  signals older running prod promotions as `superseded_closed`.
- Temporal unavailable: the strict CI/CD job fails. Restart or repair `brai-temporal.service` / `brai-temporal-worker.service`, then rerun the failed GitHub Actions job. The repo-managed `brai-supabase.service` always loads `/srv/opt/supabase/docker/docker-compose.brai.yml`, so recreated `supabase-db` containers retain the shared `brai-supabase` network used by Temporal.
- Worker stopped: workflows remain in Temporal; restart `brai-temporal-worker.service`.
- Failed preview deploy: query the workflow state and inspect `status`, `blocker`, `blockers`, and `tasks`, then fix and push the same `codex/*` branch.
- Failed Supabase preview: check `/etc/brai/supabase-deploy.env`, self-hosted schema creation, the per-env `brai-api.env`, and `deploy/scripts/supabase-branch.mjs` output, then rerun `deploy-preview`.
- Failed accepted-preview cleanup: query both `brai:promotion:prod:<sha>` and the affected `brai:preview:<branch>` workflow. Check preview/test schema deletion, remote branch cleanup, and local worktree pruning; then rerun the failed `deploy-prod` job.
- Failed production Supabase migration: run the cutover/import smoke from [Supabase Postgres Cutover](supabase-postgres-cutover.md), then rerun `deploy-prod`.
- Failed production deploy: query `brai:promotion:prod:<sha>`, fix the deploy or ledger issue, then rerun the failed production job.
- Stuck slot release: use `deploy/scripts/preview-slots.sh status` on the VPS source checkout, then rerun the existing release workflow or `deploy/scripts/ci-ssh-release-slot.sh`.
- Wrong or sensitive event data: do not mutate Temporal history. Start a new corrected workflow only if the old history contains no secrets; if a secret was signaled, rotate it and treat the Temporal DB as exposed for that secret.
