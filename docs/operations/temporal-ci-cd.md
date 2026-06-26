# Temporal CI/CD Orchestration

Bright OS uses self-host Temporal as the required CI/CD control ledger for branch previews and promotions. GitHub Actions still runs the existing checks and deploy scripts, but every critical transition must be accepted by Temporal before or after the command that changes deploy state. Temporal is not exposed publicly and no deploy ports are opened.

## Process Change Rule

Any change to Bright OS CI/CD must update the Temporal contract in the same branch when the change adds, removes, reorders, or changes an operation that must always happen, can block delivery, or needs manual recovery. Do not add a hidden deploy side effect only inside a shell script or GitHub Actions step.

For a new required operation, add the matching Temporal event/state before shipping the process change:

- workflow state task in `services/bright_os_temporal/src/state.mjs`;
- allowlisted client event in `services/bright_os_temporal/src/client.mjs`;
- GitHub Actions or helper-script signal around the existing command;
- state test in `services/bright_os_temporal/test/state.test.mjs`;
- docs in this file and, when agent behavior changes, `docs/operations/branch-preview-environments.md`.

Use started/passed/failed events for operations that can block delivery. Examples: publishing an accepted version to another system, uploading an artifact, adding a manual approval gate, changing slot release semantics, or adding a production verification step. If the operation is optional telemetry, document why it is not a Temporal gate.

## Terms

- Temporal address: `127.0.0.1:7233` on the VPS. It is not exposed publicly.
- Worker service: `brightos-temporal-worker.service`.
- Preview task queue: `bright-os-preview`.
- Promotion task queue: `bright-os-promotion`.
- Preview workflow ID: `bright-os:preview:<branch>`.
- Promotion workflow ID: `bright-os:promotion:<target>:<sha>`.
- State query name: `state`.
- Signal name: `event`.

## Preview Slot Lease Lifecycle

Preview slots are still allocated and released by the existing slot scripts:

1. A `codex/*` push starts or signals `BranchPreviewWorkflow`.
2. GitHub Actions signals `branch_pushed` and `checks_started`.
3. Existing `checks` job runs unchanged.
4. GitHub Actions signals `checks_passed` or `checks_failed`.
5. `deploy-preview` waits for `temporal-worker-check`.
6. GitHub Actions signals `preview_deploy_started`.
7. Existing `deploy-preview` runs `deploy/scripts/ci-ssh-deploy.sh`.
8. GitHub Actions signals `preview_deploy_passed` or `preview_deploy_failed`.
9. A failed check or preview deploy leaves workflow state at `waiting_for_fix`.
10. Accepted preview completion signals `pr_merged`, `accepted_preview_started`, `accepted_preview_promoted` or `accepted_preview_failed`, `slot_release_started`, and `slot_released` or `slot_release_failed`.
11. Manual release requires a real slot release. Delete-triggered release is idempotent: if the slot was already released, Temporal records `branch_deleted`.

The preview slot registry remains `/srv/projects/bright-os-envs/preview-slots.json`; Temporal does not replace that lock or registry.

## BranchPreviewWorkflow

`BranchPreviewWorkflow` keeps a bounded event log and the current checklist for a `codex/*` branch:

- `branch_pushed`
- `checks_started`, `checks_passed`, `checks_failed`
- `preview_deploy_started`, `preview_deploy_passed`, `preview_deploy_failed`
- `pr_merged`
- `accepted_preview_started`, `accepted_preview_promoted`, `accepted_preview_failed`
- `slot_release_started`, `slot_released`, `slot_release_failed`
- `released`, `branch_deleted`

The `state` query exposes `tasks`, `missing`, `blocker`, and `blockers`. A new `branch_pushed` event resets the check/deploy/release checklist for the new SHA so old green state is not inherited. `checks_failed`, `preview_deploy_failed`, `accepted_preview_failed`, and `slot_release_failed` set `status` to `waiting_for_fix` and populate `blocker`.

## PromotionWorkflow

`PromotionWorkflow` tracks accepted preview to `dev`, and `dev` to production:

- Workflow ID for dev deploy: `bright-os:promotion:dev:<sha>`.
- Workflow ID for production deploy: `bright-os:promotion:prod:<sha>`.
- Dev signals: `dev_deploy_started`, `dev_version_recorded`, `accepted_previews_started`, `accepted_previews_passed`, `accepted_previews_failed`, `dev_deploy_passed`, `dev_deploy_failed`.
- Prod signals: `prod_deploy_started`, `prod_version_recorded`, `prod_deploy_passed`, `prod_deploy_failed`.

The dev promotion checklist requires deployment, version/ledger recording, and accepted-preview metadata/slot cleanup. The production checklist requires deployment and production version/ledger recording. `dev_deploy_passed` and `prod_deploy_passed` complete their promotion workflows only after prior required steps have succeeded in GitHub Actions. Human-readable `build_versions` release notes are part of the existing version/ledger recording step; changing their text source does not add a new Temporal gate.

Deploy logic still lives in the existing scripts. Temporal is the required control ledger around those scripts; GitHub branch protection, merge queue, preview slot locking, and SQLite ledger writes remain the underlying authorities for their own data.

## Worker Permissions

The worker unit runs as `bright-os` with supplementary `bright-deploy` group and connects to local Temporal only:

```bash
sudo systemctl enable --now brightos-temporal-worker.service
sudo systemctl status brightos-temporal-worker.service
```

Install dependencies before enabling the unit:

```bash
npm --prefix /srv/projects/bright-os/services/bright_os_temporal ci
```

The unit does not include GitHub tokens, SSH keys, Caddy credentials, database passwords, or Supabase secrets. If later worker activities need production-grade GitHub or deploy actions, store them outside Git, for example:

```text
/etc/bright-os/brightos-temporal-worker.env
BRIGHT_TEMPORAL_GITHUB_TOKEN
BRIGHT_TEMPORAL_DEPLOY_SSH_KEY_PATH
```

Do not add those values to repository docs.

## GitHub Actions Signals

GitHub Actions uses `deploy/scripts/ci-temporal-signal.sh`. The helper opens an SSH tunnel to `127.0.0.1:7233` through the existing deploy SSH boundary, runs the local Temporal client, then closes the tunnel. It does not open Temporal or Postgres ports externally.

The delivery workflow sets `BRIGHT_TEMPORAL_REQUIRED=true`. If Temporal, SSH tunnel setup, or the client call fails, the relevant CI/CD job fails and the deploy/release must be retried after the Temporal blocker is fixed. The helper default remains best-effort only for ad hoc local/manual commands that do not set `BRIGHT_TEMPORAL_REQUIRED=true`.

## Manual Smoke Test

Start the worker:

```bash
TEMPORAL_ADDRESS=127.0.0.1:7233 npm --prefix services/bright_os_temporal start
```

Start a fake preview workflow:

```bash
TEMPORAL_ADDRESS=127.0.0.1:7233 npm --prefix services/bright_os_temporal run signal -- demo --branch codex/temporal-smoke
```

Query state:

```bash
TEMPORAL_ADDRESS=127.0.0.1:7233 npm --prefix services/bright_os_temporal run signal -- query-preview --branch codex/temporal-smoke
```

Then open `https://temporal.brightos.world` with the unified Caddy basic auth and look for workflow ID `bright-os:preview:codex/temporal-smoke`.

## Failure And Manual Recovery

- Temporal unavailable: the strict CI/CD job fails. Restart or repair `brightos-temporal.service` / `brightos-temporal-worker.service`, then rerun the failed GitHub Actions job.
- Worker stopped: workflows remain in Temporal; restart `brightos-temporal-worker.service`.
- Failed preview deploy: query the workflow state and inspect `status`, `blocker`, `blockers`, and `tasks`, then fix and push the same `codex/*` branch.
- Failed dev acceptance cleanup: query both `bright-os:promotion:dev:<sha>` and the affected `bright-os:preview:<branch>` workflow. Fix metadata promotion or slot release, then rerun the failed `deploy-dev` job.
- Failed production deploy: query `bright-os:promotion:prod:<sha>`, fix the deploy or ledger issue, then rerun the failed production job.
- Stuck slot release: use `deploy/scripts/preview-slots.sh status` on the VPS source checkout, then rerun the existing release workflow or `deploy/scripts/ci-ssh-release-slot.sh`.
- Wrong or sensitive event data: do not mutate Temporal history. Start a new corrected workflow only if the old history contains no secrets; if a secret was signaled, rotate it and treat the Temporal DB as exposed for that secret.
