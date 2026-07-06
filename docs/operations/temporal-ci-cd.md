# Temporal CI/CD Orchestration

Brai uses self-host Temporal as the required CI/CD control ledger for branch previews and promotions. GitHub Actions still runs the existing checks and deploy scripts, but every critical transition must be accepted by Temporal before or after the command that changes deploy state. Temporal is not exposed publicly and no deploy ports are opened.

## Process Change Rule

Any change to Brai CI/CD must update the Temporal contract in the same branch when the change adds, removes, reorders, or changes an operation that must always happen, can block delivery, or needs manual recovery. Do not add a hidden deploy side effect only inside a shell script or GitHub Actions step.

For a new required operation, add the matching Temporal event/state before shipping the process change:

- workflow state task in `services/brai_temporal/src/state.mjs`;
- allowlisted client event in `services/brai_temporal/src/client.mjs`;
- GitHub Actions or helper-script signal around the existing command;
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
7. GitHub Actions signals `preview_deploy_started` and `supabase_preview_started`.
8. Existing `deploy-preview` runs `deploy/scripts/ci-ssh-deploy.sh`; the remote deploy creates or reuses the Supabase preview branch, applies migrations, updates the preview env file, deploys the app, and restarts the API.
9. GitHub Actions signals `supabase_preview_passed` and `preview_deploy_passed`, or the matching failed events.
10. A failed classification, check, Supabase preview branch, or preview deploy leaves workflow state at `waiting_for_fix`.
11. Accepted preview completion signals `pr_merged`, `accepted_preview_started`, `accepted_preview_promoted` or `accepted_preview_failed`, `supabase_preview_release_started`, `supabase_preview_released` or `supabase_preview_release_failed`, `slot_release_started`, and `slot_released` or `slot_release_failed`.
12. Manual release requires a real slot release. Delete-triggered release is idempotent: if the slot was already released, Temporal records `branch_deleted`. Closing a `codex/*` PR without merge also runs slot release; if no slot is found, Temporal still records `slot_released` so abandoned preview workflows do not stay in release-started state.

Accepted PR conflict reconciliation does not add a separate Temporal gate. The agent resolves conflicts on the same `codex/*` branch and pushes a new head; the existing `branch_pushed`, `checks_*`, and `preview_deploy_*` events reset and reverify that head before `accept-preview.sh` enables auto-merge again.

The preview slot registry remains `/srv/projects/brai-envs/preview-slots.json`; Temporal does not replace that lock or registry.

Native-boundary preview deploys may build a slot-specific APK inside the existing `preview_deploy_started` to `preview_deploy_passed` gate. Accepted native work rebuilds the Preview A-E APK baseline during preview slot release after production deploy. These APK builds are required deploy/release substeps, not separate Temporal state transitions; failure still reports through `preview_deploy_failed`, `prod_deploy_failed`, or `slot_release_failed`.

Accepted `deploy-prod` reruns are idempotent after a partial success: if the preview slot was already released, promotion may pass only when the production build ledger already records the accepted branch for the target commit, and the release rerun records `slot_released` for the already-free slot instead of leaving the workflow blocked.

## Infra Docs No-preview Path

Infrastructure/documentation-only branches can be classified as `deliveryClass=infra-docs`.
Strict technical-only branches that are proven by CI rather than browser review can be classified
as `deliveryClass=technical-no-preview`. These no-preview classes signal `no_preview_required`;
Temporal marks `preview_deploy`,
`accepted_preview_promotion`, and `slot_release` as `not_applicable`, clears `slot`, and keeps
the branch in the same `BranchPreviewWorkflow` ledger. The state query exposes the
`deliveryClass`, `handoff`, and `autoMerge` fields for this path.

The no-preview path records the handoff attempt with `delivery_handoff_started` or
`delivery_handoff_failed`, and records PR auto-merge setup with `auto_merge_started`,
`auto_merge_enabled`, or `auto_merge_failed`. `auto_merge_enabled` is only an intermediate
state. Successful handoff is complete only after the PR is actually merged: the
`pull_request.closed` merge job sends `delivery_handoff_passed` with merged PR metadata, then
`pr_merged` marks `accepted_for_target` as passed. Failed classification, handoff, or
auto-merge events set `status=waiting_for_fix` and populate `blocker`.

The agent-side `brai-task handoff` may pre-create the infra/docs PR with the agent's GitHub
identity so CI can reuse it even when the repository keeps the default `GITHUB_TOKEN` unable to
create pull requests. GitHub Actions still owns the `auto_merge_*` Temporal signals and must not
push directly to `main`. Local `brai-task handoff` does not write a success receipt until the PR
state is `MERGED` and the receipt includes PR number, URL, and `mergedAt`.

For no-preview classes, `pr_merged` marks the `accepted_for_target` (`Accepted for target`) task as passed.
The no-preview lifecycle completes only after all required gates are passed or not applicable, without
requiring accepted-preview metadata promotion or preview slot release.

## BranchPreviewWorkflow

`BranchPreviewWorkflow` keeps a bounded event log and the current checklist for a `codex/*` branch:

- `branch_pushed`
- `delivery_classified`, `delivery_classification_failed`
- `delivery_handoff_started`, `delivery_handoff_passed`, `delivery_handoff_failed`
- `auto_merge_started`, `auto_merge_enabled`, `auto_merge_failed`
- `no_preview_required`
- `checks_started`, `checks_passed`, `checks_failed`
- `supabase_preview_started`, `supabase_preview_passed`, `supabase_preview_failed`
- `preview_deploy_started`, `preview_deploy_passed`, `preview_deploy_failed`
- `pr_merged`
- `accepted_preview_started`, `accepted_preview_promoted`, `accepted_preview_failed`
- `slot_release_started`, `slot_released`, `slot_release_failed`
- `supabase_preview_release_started`, `supabase_preview_released`, `supabase_preview_release_failed`
- `released`, `branch_deleted`

The `state` query exposes `deliveryClass`, `handoff`, `autoMerge`, `tasks`, `missing`, `blocker`, and `blockers`. A new `branch_pushed` event resets the check/deploy/release checklist for the new SHA so old green state is not inherited. `delivery_classification_failed`, `delivery_handoff_failed`, `auto_merge_failed`, `checks_failed`, `supabase_preview_failed`, `preview_deploy_failed`, `accepted_preview_failed`, `supabase_preview_release_failed`, and `slot_release_failed` set `status` to `waiting_for_fix` and populate `blocker`.

## PromotionWorkflow

`PromotionWorkflow` tracks accepted preview promotion, target deploy, and preview slot release:

- Workflow ID for production deploy: `brai:promotion:prod:<sha>`.
- Workflow ID for Dev deploy: `brai:promotion:dev:<sha>`.
- Prod signals: `prod_deploy_started`, `supabase_prod_migration_started`, `supabase_prod_migration_passed`, `supabase_prod_migration_failed`, `prod_version_recorded`, `accepted_previews_started`, `accepted_previews_passed`, `accepted_previews_failed`, `prod_deploy_passed`, `prod_deploy_failed`.
- Dev signals: `dev_deploy_started`, `dev_supabase_migration_started`, `dev_supabase_migration_passed`, `dev_supabase_migration_failed`, `dev_version_recorded`, `dev_deploy_passed`, `dev_deploy_failed`.

The production checklist requires Supabase migration/smoke, accepted-preview metadata promotion,
version/ledger recording, deployment, and preview-slot cleanup. The production Supabase smoke
requires baseline runtime tables and deployment ledger tables to be present.
During the post-deploy accepted-preview release step, occupied preview OTA manifests are republished
from each preview slot's own source checkout so their `otaVersion` follows the production build
ledger without replacing preview content with production content. `prod_deploy_passed` completes the
promotion workflow only after prior required steps have succeeded in GitHub Actions. Russian
human-readable `build_versions` release notes are part of the existing version/ledger recording
step; changing their text source does not add a new Temporal gate.

Dev deploys are persistent-environment promotions from branch `dev`. They use the long-lived
Supabase branch `brai-dev`, do not refresh from production automatically after the first clone, and
do not require accepted-preview cleanup.

Deploy logic still lives in the existing scripts. Temporal is the required control ledger around
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

The unit does not include GitHub tokens, SSH keys, Caddy credentials, database passwords, or Supabase secrets. If later worker activities need production-grade GitHub or deploy actions, store them outside Git, for example:

```text
/etc/brai/brai-temporal-worker.env
BRAI_TEMPORAL_GITHUB_TOKEN
BRAI_TEMPORAL_DEPLOY_SSH_KEY_PATH
```

Do not add those values to repository docs.

## GitHub Actions Signals

GitHub Actions uses `deploy/scripts/ci-temporal-signal.sh`. The helper opens an SSH tunnel to `127.0.0.1:7233` through the existing deploy SSH boundary, runs the local Temporal client, then closes the tunnel. It does not open Temporal or Postgres ports externally.

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

Then open `https://temporal.brightos.world` with the unified Caddy basic auth and look for workflow ID `brai:preview:codex/temporal-smoke`.

## Failure And Manual Recovery

- Temporal unavailable: the strict CI/CD job fails. Restart or repair `brai-temporal.service` / `brai-temporal-worker.service`, then rerun the failed GitHub Actions job.
- Worker stopped: workflows remain in Temporal; restart `brai-temporal-worker.service`.
- Failed preview deploy: query the workflow state and inspect `status`, `blocker`, `blockers`, and `tasks`, then fix and push the same `codex/*` branch.
- Failed Supabase preview: check `/etc/brai/supabase-deploy.env`, self-hosted schema creation, the per-env `brai-api.env`, and `deploy/scripts/supabase-branch.mjs` output, then rerun `deploy-preview`.
- Failed accepted-preview cleanup: query both `brai:promotion:prod:<sha>` and the affected `brai:preview:<branch>` workflow. Fix metadata promotion or slot release, then rerun the failed `deploy-prod` job.
- Failed production Supabase migration: run the cutover/import smoke from [Supabase Postgres Cutover](supabase-postgres-cutover.md), then rerun `deploy-prod`.
- Failed production deploy: query `brai:promotion:prod:<sha>`, fix the deploy or ledger issue, then rerun the failed production job.
- Stuck slot release: use `deploy/scripts/preview-slots.sh status` on the VPS source checkout, then rerun the existing release workflow or `deploy/scripts/ci-ssh-release-slot.sh`.
- Wrong or sensitive event data: do not mutate Temporal history. Start a new corrected workflow only if the old history contains no secrets; if a secret was signaled, rotate it and treat the Temporal DB as exposed for that secret.
