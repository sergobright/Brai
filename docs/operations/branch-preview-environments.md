# Branch Preview Environments

Brai uses one VPS for six active app environments:

- Production: `app.brightos.world`, branch `main`;
- Preview A-E: `a.test.brightos.world` through `e.test.brightos.world`, branches `codex/*`;
- Preview status: `previews.brightos.world`.

## Agent Flow

Read-only questions, planning, investigation without project-file changes, and environment setup outside the project do not need a branch or preview slot. Before the first project-file change for a new task, start from `origin/main` and create `codex/<task-slug>` unless the project owner explicitly chooses another branch/base.

Agents must not reuse an existing `codex/*` branch just because Codex Desktop selected it by default. A new Codex thread must start a new task branch before changing project files, regardless of which branch the UI selected. Direct follow-ups may continue the same branch only inside the same Codex thread while the branch is not accepted into `main`; explicit project-owner branch instructions do not override this thread boundary for project-file writes.

Follow-up branches keep the exact task base recorded by the starter in `.brai-task/task.json`. While the branch is not accepted, agents must not update it from a later `origin/main` with fetch/pull/merge/rebase commands. Background merges into `main` are handled by the eventual PR/merge queue or by starting a new task after acceptance, not by repeatedly rebasing an in-review preview branch.

After the project owner accepts a preview, a dirty acceptance PR is resolved in the same branch with `node scripts/brai-task.mjs acceptance-reconcile <codex-branch>`. That command is the only approved exception to the frozen-base rule: it verifies the accepted PR, merges current `origin/main` into the same `codex/*` branch, and leaves any real conflicts for the agent to resolve before pushing the same branch again. Do not create a replacement branch or PR for accepted conflict resolution.

A pushed preview-class `codex/*` branch allocates or reuses a preview slot through `deploy/scripts/preview-slots.sh`, deploys that slot, and reports the slot URL. If all slots `A` through `E` are occupied, the branch enters the preview queue until a slot is released. No push means no slot/deploy/queue.
`deploy/scripts/preview-slots.sh status` is read-only: it takes a shared lock and must not rewrite the slot registry or status page.

If a `codex/*` pull request is closed without merge, GitHub Actions releases that branch's preview slot through the same `release-preview-slot` job used for deleted branches and manual releases. This covers superseded preview branches: the accepted replacement branch releases its own slot through production promotion, and the abandoned branch releases its slot when its PR closes.

If the preview branch changes the Android native boundary, deploy also builds a slot-specific APK and records the APK file plus APK `vN` in the preview slot registry/status page. Preview OTA manifests then require `targetApkVersion=N`, so stale slot APKs block with an APK update screen instead of silently running an incompatible web bundle.

Infrastructure/documentation-only branches can use the Temporal no-preview path when the delivery class is `infra-docs`. Strict technical-only branches can use the same no-preview path as `technical-no-preview` when the changed files are limited to tests, test configuration, or narrowly allowed agent-operation bookkeeping that is proven by CI rather than browser review. That path records `delivery_classified`, `no_preview_required`, `delivery_handoff_*`, and `auto_merge_*` events instead of allocating a slot. Temporal then marks `preview_deploy`, `accepted_preview_promotion`, and `slot_release` as `not_applicable`; after `pr_merged`, the branch lifecycle is complete without a slot.

Local dev server URLs are agent-only verification aids. The user-facing handoff for preview-class project changes is the preview slot URL after `deploy-preview` succeeds; if CI/deploy is not complete, report that blocker instead of asking the project owner to open `localhost` or `127.0.0.1`.

## Mechanical Guard Rails

Use the checked-in task starter before the first project-file change:

```bash
scripts/brai-task-start.sh <task-slug>
```

The starter fetches `origin/main`, refuses to reuse an existing remote `codex/<task-slug>`, creates a separate worktree under `.codex-worktrees/<task-slug>`, creates `codex/<task-slug>` with `--no-track`, writes ignored local task state under `.brai-task/` including the current Codex thread id, enables `.githooks`, and links existing ignored `node_modules` directories from the main checkout when present. In Codex Desktop run the starter with `sandbox_permissions=require_escalated` immediately because it updates Git worktree metadata. If that is unavailable, stop without project-file changes; do not create or switch to a manual fallback branch in the current checkout, `/srv/projects/brai-worktrees`, or `/tmp`. The main checkout and registered non-current worktrees are root-owned read-only because Codex internal file-change events can bypass lifecycle hooks; only ignored `.brai-task/` receipt files remain writable as local task state. After every accepted `main` push, GitHub Actions runs `/srv/opt/brai-main-sync.sh` on the VPS so `/srv/projects/brai` returns to a clean `origin/main` mirror for new threads and old registered worktrees become read-only.

In Codex Desktop, staging from a task worktree can also need `sandbox_permissions=require_escalated`
because the worktree index lock is stored under the main checkout's `.git/worktrees/` metadata.
If an escalated command leaves the task worktree with unusable ownership, repair only that task
worktree with:

```bash
scripts/brai-task-repair-permissions.sh <task-slug-or-worktree-path>
```

The repo-local starter runs the narrower workspace repair and `node scripts/brai-task.mjs preflight --strict` after a task worktree is created. For later cache/output permission drift, prefer:

```bash
scripts/brai-task-repair-permissions.sh --workspace <task-slug-or-worktree-path>
node scripts/brai-task.mjs preflight --strict
```

Repository Codex hooks are defined in `.codex/hooks.json`:

- `PreToolUse` recursively inspects namespaced, custom, and nested tool calls such as `functions.apply_patch`, `custom_tool_call`, and `multi_tool_use.parallel`. Before a valid task state exists, only explicitly read-only shell commands and the official task starter are allowed; unknown shell commands are treated as write-like and blocked.
- The local `.brai-task/` marker must come from `scripts/brai-task-start.sh` (`mode: new`) or an explicit same-thread `node scripts/brai-task.mjs follow-up` (`mode: follow-up`). Automatically created or manual markers are invalid for project-file writes.
- The `.brai-task/task.json` `base` SHA is the frozen task base for follow-up, commit, push, and handoff checks. The guard blocks manual `origin/main` refresh commands in active `codex/*` task branches.
- When Codex provides a thread id, the marker must match the current thread. A different or missing thread id blocks project-file writes, commits, and pushes; start a new task branch instead of continuing the auto-selected branch.
- Manual creation or switching of `codex/*` branches through `git switch`, `git checkout`, `git branch`, or `git worktree` is blocked; use the task starter or same-thread follow-up marker instead.
- If the current branch or its remote head is already included in `origin/main`, it is treated as accepted work and cannot receive more project-file changes. Start a new task branch even if Codex Desktop selected the old branch by default.
- `pre-commit` marks local write intent, and `Stop` derives implementation work from Git state: dirty files, staged changes, local commits or diff against `origin/main`, marker validity, and the exact preview receipt for the current `HEAD`.
- `node scripts/brai-task.mjs doctor --strict` prints the same guard state and exits nonzero when the checkout is not ready for handoff.

Codex requires new or changed repo hooks to be reviewed and trusted through `/hooks`; that trust is local Codex security state and is not committed to Git.

Codex hooks execute the installed stable guard copy under `/srv/opt/brai-codex-plugins/plugins/brai-guard/hooks/`. After changing `scripts/brai-task.mjs`, check drift with:

```bash
scripts/brai-guard-sync-check.sh --check
```

If it reports drift, sync the installed copy with escalation:

```bash
scripts/brai-guard-sync-check.sh --install
```

Git hooks live in `.githooks/`. Enable them in each local clone/worktree:

```bash
git config core.hooksPath .githooks
```

`pre-commit` blocks commits outside valid same-thread `codex/*` task branches and rejects staged generated/runtime/secret-like files. `pre-push` blocks direct `main` pushes, ref mismatches, wrong-thread branches, accepted branches, branches not based on `origin/main`, and pushes that fail the public guard. CI/CD-sensitive pushes also run the Temporal test suite before leaving the machine. The guard may also block other non-`codex/*` pushes; the public workflow documents only `main` and `codex/*`.

Before a final preview-class implementation handoff, run:

```bash
node scripts/brai-task.mjs release-notes --short "..." --details "..." --reason "..."
scripts/brai-preview-handoff.sh
```

The verifier requires a clean tree, pushed `origin/<codex-branch>` at `HEAD`, successful `Brai delivery` jobs including `deploy-preview`, explicit Russian release notes, and a ready preview slot from the slot registry or Temporal. It writes an ignored `.brai-task/preview-handoff.json` receipt that the Codex `Stop` hook checks.

The final response format for preview-class work is the top-level handoff contract in `AGENTS.md`: after this command succeeds, the final implementation response starts with the command's `<slot emoji> Preview` header, then includes preview URL, branch, and commit before any summary. Do not print a preview emoji in intermediary updates, status replies, questions, acceptance monitoring, no-preview handoffs, or any reply where the slot or deployed commit is unverified. If the preview letter or URL is missing because every slot is occupied, the response must say the branch is queued and include queue position/source when available. If it is missing for any other reason, the response must say exactly which push, CI, or deploy step blocked it. Ordinary preview-class `codex/*` branch push/deploy is standing Brai CI/CD automation and must not be treated as an optional manual confirmation step.

For no-preview work, `node scripts/brai-task.mjs handoff` creates or reuses the PR through the agent's GitHub identity, then polls the CI auto-merge job for a bounded period. The CI job reuses that PR, labels it `brai-delivery:infra-docs` or `brai-delivery:technical-no-preview`, and enables auto-merge without waiting for merge, so it cannot deadlock on required checks. Local handoff writes success only after the PR state is `MERGED` and the receipt includes the PR number, URL, merged timestamp, branch, commit, `deliveryClass`, `no_preview_required`, `handoff=passed`, and `autoMerge=enabled` when applicable. If CI is still running or the PR remains `OPEN`, `BEHIND`, `BLOCKED`, or `DIRTY`, rerun handoff after GitHub Actions or the merge queue advances.

Preview acceptance flow:

```text
codex/* accepted -> accept-preview.sh -> PR/merge queue into main -> production release/deploy -> release preview slot
```

Temporal is the required CI/CD control ledger for this flow. See
[Temporal CI/CD Orchestration](temporal-ci-cd.md). GitHub Actions still runs the existing checks and deploy scripts, but strict Temporal signals gate the critical transitions. Failed Temporal recording is a blocker, not a reason to bypass checks, deploy jobs, slot registry, or branch protection.
If this flow changes, update the Temporal workflow state, signals, tests, and the Temporal CI/CD document in the same branch; required delivery work must not live only in GitHub Actions or shell scripts.

Acceptance trigger:

- If the project owner says `Принято`, `принимаю`, `accepted`, or an equivalent acceptance phrase after a preview handoff, run `deploy/scripts/accept-preview.sh <codex-branch>` immediately. Negated phrases such as `пока не принято` or `не принято` are not acceptance triggers.
- The script is the single local acceptance entrypoint. It first requires verified preview state for the exact `origin/<codex-branch>` head, then creates or reuses a GitHub PR into `main` and calls `gh pr merge --<method> --auto --match-head-commit <sha>`, defaulting to `squash` unless `BRAI_ACCEPT_MERGE_METHOD` is set to `merge` or `rebase`, so branch protection, checks, merge queue, production deploy, metadata promotion, and preview-slot release stay in GitHub Actions.
- If the acceptance PR is `mergeStateStatus: DIRTY` or `BEHIND`, `accept-preview.sh` writes `status=reconcile_required`. Run `node scripts/brai-task.mjs acceptance-reconcile <codex-branch>`, resolve conflicts if any, commit, push the same branch, rerun `node scripts/brai-task.mjs release-notes ...`, rerun `scripts/brai-preview-handoff.sh`, and rerun `deploy/scripts/accept-preview.sh <codex-branch>`. The original preview slot remains leased to that branch until production promotion releases it.
- After starting acceptance, monitor GitHub Actions until production deploy and preview-slot release finish, or report the exact PR/check/merge-queue/deploy/release blocker. Accepted preview slots are released only by the successful `deploy-prod` post-step, after metadata promotion and production deploy; that step also republishes occupied preview OTA manifests from their own preview source checkouts so slot content stays preview-specific while `otaVersion` catches up to the production build ledger. The step requires a real slot release and fails if the accepted branch did not release one.

## Required GitHub Settings

Repository variables:

- `BRAI_DEPLOY_HOST` - VPS host or DNS name;
- `BRAI_DEPLOY_USER` - deploy user, for example `brai-deploy`;
- `BRAI_DEPLOY_SSH_PORT` - optional, defaults to `22`;
- `BRAI_DEPLOY_REPO` - optional, defaults to `/srv/projects/brai`.

Repository secret:

- `BRAI_DEPLOY_SSH_KEY` - private key for the deploy user. Do not commit it or write it into docs.

## Deploy User Boundary

The deploy user needs write access to `/srv/projects/brai-envs/` for CI uploads,
preview source checkouts, preview web/OTA outputs, SQLite deployment metadata, and preview slot state.
For production deploys it also needs write access to the existing production web/OTA targets and
Brai SQLite file:

```text
/srv/projects/brai/deploy/web
/srv/projects/brai/deploy/mobile-update
/srv/projects/brai/data/brai.sqlite
/srv/projects/brai/data/brai.sqlite-wal when present
/srv/projects/brai/data/brai.sqlite-shm when present
```

The deploy user must not need read or write access to `/srv/projects/brai/.git`. Sudo should be limited to:

```text
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy
systemctl restart brai-api.service
systemctl restart brai-api-preview-a.service
systemctl restart brai-api-preview-b.service
systemctl restart brai-api-preview-c.service
systemctl restart brai-api-preview-d.service
systemctl restart brai-api-preview-e.service
```

The Ansible sudoers template is `deploy/ansible/templates/brai-deploy-sudoers.j2`.

### Production SQLite maintenance

Production SQLite maintenance goes through `deploy/scripts/production-sqlite-maintenance.sh`.
It defaults to `/srv/projects/brai/data/brai.sqlite`, uses backups under
`/srv/projects/brai/data/backups`, and uses `/srv/opt/android-sdk/platform-tools/sqlite3`.
Run `check` for read-only inspection. Run write commands such as `backup` and `exec-sql`
as the `brai` service user; the wrapper rejects `root`, `mark`, and other users.
Ansible keeps `data`, `data/backups`, `brai.sqlite`, and existing WAL/SHM sidecars owned
by `brai:brai-deploy` with group-write modes so the runtime and deploy scripts share the
same narrow maintenance boundary.

## Server Setup

Run Ansible as `root` or another server admin account with full `become`, not as the limited CI deploy user. The playbook creates `brai-deploy`; add the CI public SSH key to that user outside source.

Dry run:

```bash
ansible-playbook -i deploy/ansible/inventory.example.ini deploy/ansible/brai.yml --check --diff
```

Apply after check mode passes and secrets/env files exist on the VPS:

```bash
ansible-playbook -i deploy/ansible/inventory.example.ini deploy/ansible/brai.yml
```

The current local VPS setup keeps the existing production service name `brai-api.service`.
Production and preview services run from the source checkout uploaded into
`/srv/projects/brai-envs/<environment>/source/services/brai_api` as the configured service user/group.
The limited `brai-deploy` user owns `/srv/projects/brai-envs`, publishes only the deployment
artifacts above, and uses sudo only for Caddy validation, Caddy reload, and matching Brai API service restarts.
The Brai runtime user also belongs to the `brai-deploy` group and API units run with
`SupplementaryGroups=brai-deploy`, so SQLite files created by the runtime stay writable by deploy scripts
without broadening the sudo boundary.

Preview Caddy routes keep the app shell protected with the unified Caddy Basic Auth login, but
`/mobile-update/*` stays public for Android OTA and `/api/*` is proxied to the matching Brai API without
Caddy Basic Auth or injected bearer headers. Brai API auth remains responsible for `/v1/*` data access,
so newly installed Preview A-E apps may need their own in-app login session before sync turns green.

If an environment exists before its first CI deploy, publish a baseline web/OTA layer without changing APK versions:

```bash
BRAI_TARGET_APK_VERSION=1 deploy/scripts/publish-environment-web-layer.sh preview-a preview-b preview-c preview-d preview-e
```

Ansible templates do not store passwords, Caddy auth hashes, deploy keys, Android signing secrets, or Brai API secrets. Per-environment Brai API secret env files live outside source under:

```text
/srv/projects/brai-envs/<environment>/brai-api.env
```

## Public Branch Protection

After the clean public repository has its initial public `main`, configure GitHub branch protection/ruleset for public `main`:

- require pull requests;
- require status checks from `Brai public main CI`;
- require `node scripts/check-public-branch.mjs`;
- block direct pushes;
- block force pushes;
- block branch deletion.

The public guard is required for `main`, pull requests, and `codex/*` branches in the clean public repository.
