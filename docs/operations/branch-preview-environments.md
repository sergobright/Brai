# Branch Preview Environments

Brai uses one VPS for seven active app environments:

- Production: `app.brai.one`, branch `main`;
- Dev: `dev.brai.one`, branch `dev`;
- Preview A-E: `a.test.brai.one` through `e.test.brai.one`, branches `codex/*`;

## Agent Flow

Read-only questions, planning, investigation without project-file changes, Git-ignored-only local writes, and environment setup outside the project do not need a branch or preview slot. Before the first tracked or non-ignored project-file change for a new task, start from `origin/main` and create `codex/<task-slug>` unless the project owner explicitly chooses another branch/base.

Agents must not reuse an existing `codex/*` branch just because Codex Desktop selected it by default. A new Codex thread must start a new task branch before changing tracked or non-ignored project files, regardless of which branch the UI selected. Direct follow-ups may continue the same branch only inside the same Codex thread while the branch is not accepted into `main`; explicit project-owner branch instructions do not override this thread boundary for project-file writes unless the owner confirms that the former thread is irretrievably lost and the agent uses `node scripts/brai-task.mjs recover-follow-up --from-thread <lost-thread-id>`.

Follow-up branches keep the exact task base recorded by the starter in `.brai-task/task.json`. While the branch is not accepted, agents must not update it from a later `origin/main` with fetch/pull/merge/rebase commands. Background merges into `main` are handled by the eventual PR/merge queue or by starting a new task after acceptance, not by repeatedly rebasing an in-review preview branch.

After the project owner accepts a preview, a dirty acceptance PR is resolved in the same branch with `node scripts/brai-task.mjs acceptance-reconcile <codex-branch>`. That command is the only approved exception to the frozen-base rule: it verifies the accepted PR, merges current `origin/main` into the same `codex/*` branch, and leaves any real conflicts for the agent to resolve before pushing the same branch again. Do not create a replacement branch or PR for accepted conflict resolution.

A pushed preview-class `codex/*` branch allocates or reuses a preview slot through `deploy/scripts/preview-slots.sh`, deploys that slot, and reports the slot URL. If all slots `A` through `E` are occupied, the branch enters the preview queue until a slot is released. No push means no slot/deploy/queue.
`pull_request` opened, synchronize, and reopened events do not run the full delivery workflow; the `codex/*` push run is the authoritative check/deploy source. `pull_request.closed` remains enabled only to record no-preview merges and release abandoned preview slots.
`deploy/scripts/preview-slots.sh status` is read-only: it takes a shared lock and must not rewrite the slot registry.

Each preview slot uses its own Supabase preview branch. After slot allocation, CI creates or reuses
`brai-preview-<safe-codex-branch>-<hash>`, applies `supabase/migrations/*.sql`, refreshes the
preview schema data from the production DB, enables test-only `BRAI_TEST_EMAIL_LOGIN=true`, writes
the branch runtime DSN to
`/srv/projects/brai-envs/<preview>/brai-api.env`, and records only `supabase_branch_name`,
`supabase_branch_id`, and `supabase_branch_status` in `preview-slots.json`. Connection strings and
tokens must never be written to the slot registry.

If a `codex/*` pull request is closed without merge, GitHub Actions releases that branch's preview slot through the same `release-preview-slot` job used for deleted branches and manual releases. This covers superseded preview branches: the accepted replacement branch releases its own slot through production promotion, and the abandoned branch releases its slot when its PR closes.
Slot release deletes the matching Supabase preview branch before freeing the Brai slot. A failed
Supabase branch delete is a delivery blocker because each preview slot must release its isolated
database state before the slot is reused.

If the preview branch changes the Android native boundary, deploy also builds a slot-specific preview APK and records `brai-<slot>-vN-previewM.apk`, APK `vN`, branch-local preview `M`, and `versionCode=N*10000+M` in the preview slot registry. Preview OTA manifests then target the same release key, build kind, stable `N`, and preview `M`, so stale slot APKs block with an APK update screen instead of silently running an incompatible web bundle.

Infrastructure/documentation-only branches can use the Temporal no-preview path when the delivery class is `infra-docs`. Strict technical-only branches can use the same no-preview path as `technical-no-preview` when the changed files are limited to tests, test configuration, or narrowly allowed agent-operation bookkeeping that is proven by CI rather than browser review. That path records `delivery_classified` and `no_preview_required`, then dispatches Temporal handoff/merge activities instead of allocating a slot. Temporal marks `supabase_preview`, `goal_agents_deploy`, `preview_deploy`, `accepted_preview_promotion`, `supabase_preview_release`, and `slot_release` as `not_applicable`; after `no_preview_merged`, the branch lifecycle is complete without a slot.

Local dev server URLs are agent-only verification aids. The user-facing handoff for preview-class project changes is the preview slot URL after `deploy-preview` succeeds; if CI/deploy is not complete, report that blocker instead of asking the project owner to open `localhost` or `127.0.0.1`.

## Mechanical Guard Rails

Classify intended write paths with `git check-ignore` before starting work. Git-ignored-only local writes such as `vault/`, scratch files, caches, outputs, and dependency directories stay in the current workspace. Use the checked-in task starter before the first tracked or non-ignored project-file change:

```bash
scripts/brai-task-start.sh <task-slug>
```

The starter fetches `origin/main`, refuses to reuse an existing remote `codex/<task-slug>`, creates a separate worktree under `.codex-worktrees/<task-slug>`, creates `codex/<task-slug>` with `--no-track`, writes ignored local task state under `.brai-task/` including the current Codex thread id, enables `.githooks`, and links existing ignored `node_modules` directories from the main checkout when present. In Codex Desktop run the starter with `sandbox_permissions=require_escalated` immediately because it updates Git worktree metadata. If that is unavailable, stop without project-file changes; do not create or switch to a manual fallback branch in the current checkout, `/srv/projects/brai-worktrees`, or `/tmp`. The main checkout is root-owned read-only for non-root writes, while ignored dependency directories remain writable generated workspace support for `mark`. Registered task worktrees under `.codex-worktrees/*` remain agent-owned in normal flow; main sync must not root-lock them because a paused Codex thread may resume there. After every accepted `main` push, GitHub Actions runs `/srv/opt/brai-main-sync.sh` on the VPS so `/srv/projects/brai` returns to a clean `origin/main` mirror for new threads without breaking existing task worktrees.

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

For broader drift, run the access contract instead of chasing individual modes:

```bash
node scripts/brai-task.mjs access-contract --local
node scripts/brai-task.mjs access-contract --server
deploy/scripts/preview-slots.sh status
deploy/scripts/postgres-smoke.mjs "$BRAI_DATABASE_URL"
```

`access-contract --local` checks guard sync, task metadata, writable caches, and Node/npm availability from the current checkout. `access-contract --server` also checks deploy-owned env roots, preview slot registry, prod source, deploy artifacts, main-sync tooling, and Supabase/Postgres runtime access. A failed contract is a delivery blocker until fixed by Ansible, main-sync, or the official repair/helper scripts.

Repository Codex hooks are defined in `.codex/hooks.json`:

- `PreToolUse` recursively inspects namespaced, custom, and nested tool calls such as `functions.apply_patch`, `custom_tool_call`, and `multi_tool_use.parallel`. Before a valid task state exists, only explicitly read-only shell commands and the official task starter are allowed; unknown shell commands are treated as write-like and blocked.
- Safe SocratiCode codebase tools such as `codebase_status`, `codebase_search`, `codebase_context_search`, graph queries, and symbol queries mark the local task as having used SocratiCode. Destructive SocratiCode maintenance tools are blocked by the guard.
- The local `.brai-task/` marker must come from `scripts/brai-task-start.sh` (`mode: new`) or an explicit same-thread `node scripts/brai-task.mjs follow-up` (`mode: follow-up`). Automatically created or manual markers are invalid for project-file writes.
- The `.brai-task/task.json` `base` SHA is the frozen task base for follow-up, commit, push, and handoff checks. The guard blocks manual `origin/main` refresh commands in active `codex/*` task branches.
- When Codex provides a thread id, the marker must match the current thread. A different or missing thread id blocks project-file writes, commits, and pushes; start a new task branch instead of continuing the auto-selected branch.
- Manual creation or switching of `codex/*` branches through `git switch`, `git checkout`, `git branch`, or `git worktree` is blocked; use the task starter or same-thread follow-up marker instead.
- If the current branch or its remote head is already included in `origin/main`, it is treated as accepted work and cannot receive more project-file changes. Start a new task branch even if Codex Desktop selected the old branch by default.
- `pre-commit` marks local write intent, and `Stop` derives implementation work from Git state: dirty files, staged changes, local commits or diff against `origin/main`, marker validity, SocratiCode usage or exact-only fallback, and the exact preview/delivery receipt for the current `HEAD`. A blocking acceptance marker always overrides an earlier valid preview receipt, so `Stop` cannot allow a final response while merge, production deploy, promotion, or slot release is still pending.
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
node scripts/brai-task.mjs release-notes --short "..." --details "..." --reason "..." --testing "..."
scripts/brai-preview-handoff.sh
```

The verifier requires a clean tree, pushed `origin/<codex-branch>` at `HEAD`, successful `Brai delivery` jobs including `deploy-preview`, explicit Russian release notes with user-testing guidance, and a ready preview slot from the slot registry or Temporal. Once the exact branch/commit is ready, handoff writes that authored guidance into the locked slot registry; Admin reads it as immutable test instructions and does not generate a summary on page load. Handoff then writes an ignored `.brai-task/preview-handoff.json` receipt that the Codex `Stop` hook checks.
`scripts/brai-preview-handoff.sh` is not a one-shot probe anymore: by default it keeps polling transient `queued` / `in_progress` preview states until the preview is actually ready or a real failing blocker appears. Tune the polling window only through `BRAI_PREVIEW_HANDOFF_WAIT_MS` and `BRAI_PREVIEW_HANDOFF_POLL_MS` when you intentionally need a different budget.

The final response format for preview-class work is the top-level handoff contract in `AGENTS.md`: after this command succeeds, the final implementation response starts with the command's `<slot emoji> Preview` header, then includes preview URL, branch, and commit before any summary. Do not print a preview emoji in intermediary updates, status replies, questions, acceptance monitoring, no-preview handoffs, or any reply where the slot or deployed commit is unverified. If the preview letter or URL is missing because every slot is occupied, the response must say the branch is queued and include queue position/source when available. If it is missing for any other reason, the response must say exactly which push, CI, or deploy step blocked it. Ordinary preview-class `codex/*` branch push/deploy is standing Brai CI/CD automation and must not be treated as an optional manual confirmation step or as a reason to stop the task while delivery is still active.

For no-preview work, `node scripts/brai-task.mjs handoff` creates or reuses the PR through the agent's GitHub identity, then polls the CI auto-merge job for a bounded period. The CI job reuses that PR, labels it `brai-delivery:infra-docs` or `brai-delivery:technical-no-preview`, and enables auto-merge without waiting for merge, so it cannot deadlock on required checks. Local handoff writes success only after the PR state is `MERGED` and the receipt includes the PR number, URL, merged timestamp, branch, commit, `deliveryClass`, `no_preview_required`, `handoff=passed`, and `autoMerge=enabled` when applicable. If CI is still running or the PR remains `OPEN`, `BEHIND`, `BLOCKED`, or `DIRTY`, rerun handoff after GitHub Actions or the merge queue advances.

Preview acceptance flow:

```text
codex/* accepted -> accept-preview.sh -> PR/merge queue into main -> production release/deploy -> delete preview/test schemas -> release preview slot -> delete accepted branch/worktree
```

Temporal is the required CI/CD orchestrator for this flow. See
[Temporal CI/CD Orchestration](temporal-ci-cd.md). GitHub Actions still runs checks and reports external facts, but deploy/release/promotion/cleanup side effects run as Temporal activities. Failed Temporal dispatch or a Temporal blocker is not a reason to bypass checks, deploy jobs, slot registry, or branch protection.
If this flow changes, update the Temporal workflow state, dispatch/events, tests, and the Temporal CI/CD document in the same branch; required delivery work must not live only in GitHub Actions or shell scripts.

Acceptance trigger:

- If the project owner says `Принято`, `принимаю`, `accepted`, or an equivalent acceptance phrase after a preview handoff, run `deploy/scripts/accept-preview.sh <codex-branch>` immediately. Negated phrases such as `пока не принято` or `не принято` are not acceptance triggers.
- The script is the single local acceptance entrypoint. It first requires verified preview state for the exact `origin/<codex-branch>` head, then creates or reuses a GitHub PR into `main` and calls `gh pr merge --<method> --auto --match-head-commit <sha>`, defaulting to `squash` unless `BRAI_ACCEPT_MERGE_METHOD` is set to `merge` or `rebase`, so branch protection, checks, merge queue, production deploy, metadata promotion, and preview-slot release stay in GitHub Actions.
- If the acceptance PR is `mergeStateStatus: DIRTY` or `BEHIND`, `accept-preview.sh` writes `status=reconcile_required`. Run `node scripts/brai-task.mjs acceptance-reconcile <codex-branch>`, resolve conflicts if any, commit, push the same branch, rerun `node scripts/brai-task.mjs release-notes ...`, rerun `scripts/brai-preview-handoff.sh`, and rerun `deploy/scripts/accept-preview.sh <codex-branch>`. The original preview slot remains leased to that branch until production promotion releases it.
- After starting acceptance, monitor GitHub Actions until production deploy and preview-slot release finish, or report the exact PR/check/merge-queue/deploy/release blocker. Accepted preview slots are released only by the successful `deploy-prod` post-step, after metadata promotion and production deploy; that step also republishes occupied preview OTA manifests from their own preview source checkouts so slot content stays preview-specific while `otaVersion` catches up to the production build ledger. Occupied preview OTA refreshes reuse the preview source checkout's existing static export and fail if it is missing instead of rebuilding the Next client. The first successful release attempt requires a real slot release and fails if the accepted branch did not release one.
- If `deploy-prod` is rerun after the accepted preview was already promoted and its slot was already released, the rerun is idempotent: promotion succeeds only when the production build ledger already contains the accepted build for the same target commit, and the release step treats the already-free slot as released.
- Before a preview slot is released, CI must delete the branch preview schema and all branch-scoped API test schemas. Legacy unscoped `brai_test_*` schemas are collected only after a 24-hour safety window. After slot release, CI deletes eligible `codex/*` remote head refs through the GitHub API and asks `/srv/opt/brai-main-sync.sh --prune-accepted-branches ...` to remove matching clean local task worktrees under `.codex-worktrees/`. Any cleanup command failure blocks Temporal completion and must be fixed or retried; active or mismatched branches are excluded before destructive cleanup.

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
preview/dev source checkouts, preview/dev web/OTA outputs, per-environment runtime env files, and
preview slot state. For production deploys it also needs write access to the existing production
web/OTA and ADR static-site targets:

```text
/srv/projects/brai/deploy/web
/srv/projects/brai/deploy/mobile-update
/srv/projects/brai-envs/prod/adr
```

Runtime database writes go to Supabase Postgres through `BRAI_DATABASE_URL`. SQLite files are not
runtime, deploy-ledger, Dev, production, or preview fallback databases.

The deploy user must not need read or write access to `/srv/projects/brai/.git`. Sudo should be limited to:

```text
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy
/srv/opt/brai-main-sync.sh *
sudo -u brai /srv/opt/node-v22.16.0/bin/npm --prefix /srv/projects/brai/services/brai_temporal ci
sudo -u brai /srv/projects/brai-envs/prod/source/deploy/scripts/codex-cli-smoke.sh
systemctl restart brai-temporal-worker.service
systemd-run --unit=brai-temporal-worker-delayed-restart --on-active=* --collect /bin/systemctl restart brai-temporal-worker.service
sudo -u brai /srv/projects/brai-envs/prod/source/deploy/scripts/complete-operation-activities.sh --local operation:agent-task:*
systemctl stop brai-api.service
systemctl restart brai-api.service
systemctl stop brai-api-dev.service
systemctl restart brai-api-dev.service
systemctl stop brai-api-preview-a.service
systemctl restart brai-api-preview-a.service
systemctl stop brai-api-preview-b.service
systemctl restart brai-api-preview-b.service
systemctl stop brai-api-preview-c.service
systemctl restart brai-api-preview-c.service
systemctl stop brai-api-preview-d.service
systemctl restart brai-api-preview-d.service
systemctl stop brai-api-preview-e.service
systemctl restart brai-api-preview-e.service
systemctl restart brai-admin.service
systemctl restart brai-admin-dev.service
systemctl restart brai-admin-preview-a.service
systemctl restart brai-admin-preview-b.service
systemctl restart brai-admin-preview-c.service
systemctl restart brai-admin-preview-d.service
systemctl restart brai-admin-preview-e.service
```

The Ansible sudoers template is `deploy/ansible/templates/brai-deploy-sudoers.j2`.

Deploy scripts normalize public web, OTA, release, ADR, and preview slot files through
`deploy/scripts/permissions.sh`. New publish paths must use that helper or Ansible-owned
equivalent logic so they preserve group-write instead of resetting trees to `go=rX`.
Accepted-preview release and OTA sync must execute from `/srv/projects/brai-envs/*/source`;
the live checkout `/srv/projects/brai` is only the locked main mirror and public artifact root.
Ansible must preserve this same permission contract: `/srv/projects/brai` source paths stay in the
`mark` source group under the main-sync lock, Node runtime entrypoints stay executable as `0755`,
and deploy/preview artifact roots stay `2775` so future files inherit `brai-deploy`.

### Supabase Runtime Maintenance

Supabase secrets and the upstream base Compose stay outside Git on the VPS. Brai-owned non-secret
overlay/bootstrap and the maintenance entrypoint are repo-managed and installed by Ansible. The
brai.one server runs self-hosted Supabase, so preview and Dev isolation uses both a separate
Supavisor tenant and separate Postgres schemas with connection URLs carrying an explicit
`search_path`:

```text
/etc/brai/supabase-deploy.env
SUPABASE_SELF_HOSTED=true
SUPABASE_SELF_HOSTED_DATABASE_URL
BRAI_SUPAVISOR_TENANT_ISOLATION=true
```

Production runtime credentials live in `/etc/brai/brai-api.env`, including `BRAI_DATABASE_URL`.
Preview and Dev runtime credentials live in `/srv/projects/brai-envs/<environment>/brai-api.env`
and are deploy-writable so CI can update schema-scoped DSNs after Supabase schema creation.
After `BRAI_SUPAVISOR_TENANT_ISOLATION=true` is enabled by the accepted maintenance rollout,
production DSNs must use `brai-prod`; Dev and Preview DSNs must use `brai-nonprod`.
Deployment rewrites only the Supavisor tenant suffix in the URL username and preserves the password,
database, query parameters, and schema `search_path`. Deployment fails before service cutover when
the target DSN has the wrong tenant.

Do not run direct `docker compose --force-recreate` against the stateful Supabase stack. Install and
use the exact maintenance boundary instead:

Dry-run обязателен перед apply:

```bash
sudo /srv/opt/brai-supabase-maintenance.sh reconfigure-pooler
sudo /srv/opt/brai-supabase-maintenance.sh --apply reconfigure-pooler
```

The command takes production, Dev, Preview A-E, staging, release, and preview-slot locks in canonical
order; stops dependent API services; recreates only Supavisor; starts production first; and returns
previously active non-production services one by one only after health/auth canaries. The wrapper
must delete persistent metadata for legacy `brightos`, `brightos-prod`, and `brightos-nonprod`
tenants, recreate only `brai-prod` and `brai-nonprod`, and verify that exact target set before any
runtime DSN is switched or API client is restarted. Failed Preview slots remain stopped and are
restored only by their normal deploy workflow. If a canary fails, leave the offending
non-production service stopped, reset only Supavisor, and repeat the production canary. Never widen
the recovery into a whole-stack or database recreation.

Dev and Preview rebuilds copy current production data into their schema after migrations, excluding
production Better Auth session, account, and verification rows. Those test env files set
`BRAI_TEST_EMAIL_LOGIN=true`. Preview/Dev web and Android still start on the login screen and
create a normal Better Auth Brai session only after the user enters an email; they never ask for a
password or OTP. The first email-only test login creates that environment's user, and repeated
logins with the same email reuse it. Opening either surface never creates a session by itself.
Production env files must not set this flag, and production web/Android keep OTP login.

Use [Supabase Postgres Cutover](supabase-postgres-cutover.md) only as the archived record of the
completed cutover. Active production, Dev, and preview writes use Supabase Postgres only.

Use `deploy/scripts/list-operation-activities.sh [--status New|Done|all] [--limit <N>] [--json]`
to list Codex operation activities. Default mode SSHes through `brai-deploy@localhost` and
executes the helper from deploy-owned `/srv/projects/brai-envs/prod/source`, then re-enters
the protected runtime boundary as `brai`. Default output is a table of open `New` rows with
`id`, `title`, `status`, UTC timestamps, truncated `reason`, and truncated `description_md`.
For same-host maintenance without a deploy SSH key, use `--host-local`; for machine-readable
output use `--json`.

```bash
deploy/scripts/list-operation-activities.sh --host-local --status New --limit 50
```

Use `deploy/scripts/complete-operation-activities.sh <operation-activity-id>...` to
mark Codex operation activities as `Done`. The default mode SSHes through
`brai-deploy@localhost` and executes the helper from deploy-owned
`/srv/projects/brai-envs/prod/source`, then re-enters the protected runtime boundary.
It validates that every supplied id is an undeleted
`activity_type_id='operation'` row authored by `Codex`, updates only `New` rows, and prints the
verified rows. Reruns over already `Done` rows are read-only.
For same-host maintenance without a deploy SSH key, use `--host-local`; it still re-enters
only through the narrow sudoers command as `brai`.

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

The first deployment containing Goal agents requires this Ansible apply before any branch
deploy. It creates the isolated Unix identity and protected EnvironmentFile, installs all 35
systemd units (five service families across Production, Dev, and Preview A-E), and installs the
narrow deploy sudo rules plus the fixed root-owned Codex runtime preparation helper. Every later
Goal-agent deploy gate invokes that helper without arguments immediately before the five exact
systemd restarts, restoring only the `brai-codex-exec` traversal/read contract and proving
`codex --version` as `brai-goal-agent`. Ansible also appends the same fixed helper to the managed
Codex release sync, after its ordinary package/symlink update, so the daily CLI timer cannot restore
the old `brai-deploy`-only package access after a successful Preview. A branch deploy intentionally
fails instead of fabricating missing units, accepting an unusable Codex runtime, or widening permissions.

The current local VPS setup keeps the existing production service name `brai-api.service`.
Production and preview API services run from the source checkout uploaded into
`/srv/projects/brai-envs/<environment>/source/services/brai_api`; Admin services run from the
matching `/srv/projects/brai-envs/<environment>/source/admin` checkout as the configured service user/group.
The limited `brai-deploy` user owns `/srv/projects/brai-envs`, publishes only the deployment
artifacts above, and uses sudo only for Caddy validation/reload, the Temporal maintenance commands,
matching Brai API/Admin restarts, and exact restart/enable/stop commands for those 35 Goal-agent units.
The Brai runtime user also belongs to the `brai-deploy` group and API units run with
`SupplementaryGroups=brai-deploy` for deploy artifact coordination without broadening the sudo
boundary. Runtime DB access uses protected Supabase Postgres env values.

Production Caddy routes keep `app.brai.one` public: the app shell is not protected by
Caddy Basic Auth, `/api/*` is proxied to the production Brai API without injected Bearer
headers, `/admin` is proxied to Brai Admin without Caddy Basic Auth but still requires the
Brai primary-user account gate, `/mobile-update/*` remains public for Android OTA, and retired live URLs
`/timer*` and `/history*` stay 404 unless a later accepted requirement brings them back.
Application auth owns browser sessions and `/v1/*` data access. Before installing the
managed Brai block, Ansible prunes legacy unmanaged Brai blocks from `/etc/caddy/Caddyfile`.
The direct API route is part of the same managed block and legacy `.brightos.world` hosts return
permanent redirects to their `.brai.one` counterparts.

Preview Caddy routes keep the app shell protected with the unified Caddy Basic Auth login, but
`/mobile-update/*` stays public for Android OTA and `/api/*` is proxied to the matching Brai API without
Caddy Basic Auth or injected bearer headers. `/admin` is also behind unified Caddy Basic Auth and then
the Brai primary-user account gate. Brai API auth remains responsible for `/v1/*` data access, so newly
installed Preview A-E apps may need their own in-app login session before sync turns green.

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
