# Branch Preview Environments

Bright OS uses one VPS for seven environments:

- Production: `app.brightos.world`, branch `main`;
- Dev: `dev.brightos.world`, branch `dev` (temporarily outside the delivery loop);
- Preview A-E: `a.test.brightos.world` through `e.test.brightos.world`, branches `codex/*`;
- Preview status: `previews.brightos.world`.

## Agent Flow

Read-only questions, planning, investigation without project-file changes, and environment setup outside the project do not need a branch or preview slot. Before the first project-file change for a new task, start from `origin/main` and create `codex/<task-slug>` unless the project owner explicitly chooses another branch/base.

Agents must not reuse an existing `codex/*` branch just because Codex Desktop selected it by default. A new Codex thread must start a new task branch before changing project files, regardless of which branch the UI selected. Direct follow-ups may continue the same branch only inside the same Codex thread while the branch is not accepted into `main`; explicit project-owner branch instructions do not override this thread boundary for project-file writes.

A pushed preview-class `codex/*` branch allocates or reuses a preview slot through `deploy/scripts/preview-slots.sh`, deploys that slot, and reports the slot URL. If all slots `A` through `E` are occupied, the branch enters the preview queue until a slot is released. No push means no slot/deploy/queue.

If the preview branch changes the Android native boundary, deploy also builds a slot-specific APK and records the APK file plus Android `versionCode` in the preview slot registry/status page. Dev/Preview OTA manifests then require that exact `versionCode`, so stale slot APKs block with an APK update screen instead of silently running an incompatible web bundle.

Infrastructure/documentation-only branches can use the Temporal no-preview path when the delivery class is `infra-docs`. That path records `delivery_classified`, `no_preview_required`, `delivery_handoff_*`, and `auto_merge_*` events instead of allocating a slot. Temporal then marks `preview_deploy`, `accepted_preview_promotion`, and `slot_release` as `not_applicable`; after `pr_merged`, the branch lifecycle is complete without a slot.

Local dev server URLs are agent-only verification aids. The user-facing handoff for preview-class project changes is the preview slot URL after `deploy-preview` succeeds; if CI/deploy is not complete, report that blocker instead of asking the project owner to open `localhost` or `127.0.0.1`.

## Mechanical Guard Rails

Use the checked-in task starter before the first project-file change:

```bash
scripts/bright-task-start.sh <task-slug>
```

The starter fetches `origin/main`, refuses to reuse an existing remote `codex/<task-slug>`, creates a separate worktree under `../bright-os-worktrees/<task-slug>`, creates `codex/<task-slug>` with `--no-track`, writes ignored local task state under `.bright-task/` including the current Codex thread id, enables `.githooks`, and links existing ignored `node_modules` directories from the main checkout when present. In Codex Desktop this sibling worktree is outside the normal repository sandbox, so run the starter with `sandbox_permissions=require_escalated` immediately. If that is unavailable, stop without project-file changes; do not create or switch to a manual fallback branch in the current checkout.

Repository Codex hooks are defined in `.codex/hooks.json`:

- `PreToolUse` recursively inspects namespaced, custom, and nested tool calls such as `functions.apply_patch`, `custom_tool_call`, and `multi_tool_use.parallel`. Before a valid task state exists, only explicitly read-only shell commands and the official task starter are allowed; unknown shell commands are treated as write-like and blocked.
- The local `.bright-task/` marker must come from `scripts/bright-task-start.sh` (`mode: new`) or an explicit same-thread `node scripts/bright-task.mjs follow-up` (`mode: follow-up`). Automatically created or manual markers are invalid for project-file writes.
- When Codex provides a thread id, the marker must match the current thread. A different or missing thread id blocks project-file writes, commits, and pushes; start a new task branch instead of continuing the auto-selected branch.
- Manual creation or switching of `codex/*` branches through `git switch`, `git checkout`, `git branch`, or `git worktree` is blocked; use the task starter or same-thread follow-up marker instead.
- If the current branch or its remote head is already included in `origin/main`, it is treated as accepted work and cannot receive more project-file changes. Start a new task branch even if Codex Desktop selected the old branch by default.
- `pre-commit` marks local write intent, and `Stop` derives implementation work from Git state: dirty files, staged changes, local commits or diff against `origin/main`, marker validity, and the exact preview receipt for the current `HEAD`.
- `node scripts/bright-task.mjs doctor --strict` prints the same guard state and exits nonzero when the checkout is not ready for handoff.

Codex requires new or changed repo hooks to be reviewed and trusted through `/hooks`; that trust is local Codex security state and is not committed to Git.

Git hooks live in `.githooks/`. Enable them in each local clone/worktree:

```bash
git config core.hooksPath .githooks
```

`pre-commit` blocks commits outside valid same-thread `codex/*` task branches and rejects staged generated/runtime/secret-like files. `pre-push` blocks direct `main`/`dev` pushes, ref mismatches, wrong-thread branches, accepted branches, branches not based on `origin/main`, and pushes that fail the public guard. CI/CD-sensitive pushes also run the Temporal test suite before leaving the machine.

Before a final preview-class implementation handoff, run:

```bash
scripts/bright-preview-handoff.sh
```

The verifier requires a clean tree, pushed `origin/<codex-branch>` at `HEAD`, successful `Bright OS delivery` jobs including `deploy-preview`, and a ready preview slot from the slot registry or Temporal. It writes an ignored `.bright-task/preview-handoff.json` receipt that the Codex `Stop` hook checks.

The final response format for preview-class work is the top-level handoff contract in `AGENTS.md`: after this command succeeds, the final implementation response starts with the command's `<slot emoji> Preview` header, then includes preview URL, branch, and commit before any summary. Do not print a preview emoji in intermediary updates, status replies, questions, acceptance monitoring, no-preview handoffs, or any reply where the slot or deployed commit is unverified. If the preview letter or URL is missing because every slot is occupied, the response must say the branch is queued and include queue position/source when available. If it is missing for any other reason, the response must say exactly which push, CI, or deploy step blocked it. Ordinary preview-class `codex/*` branch push/deploy is standing Bright OS CI/CD automation and must not be treated as an optional manual confirmation step.

For `infra-docs` no-preview work, `node scripts/bright-task.mjs handoff` creates or reuses the PR through the agent's GitHub identity before waiting for the CI auto-merge job. The CI job then reuses that PR, labels it `bright-delivery:infra-docs`, enables auto-merge, and reports the branch, commit, `deliveryClass=infra-docs`, `no_preview_required`, `handoff=passed`, `autoMerge=enabled`, and the merged PR state instead of a preview slot URL.

Preview acceptance flow while dev is disabled:

```text
codex/* accepted -> accept-preview.sh -> PR/merge queue into main -> production release/deploy -> release preview slot
```

Temporal is the required CI/CD control ledger for this flow. See
[Temporal CI/CD Orchestration](temporal-ci-cd.md). GitHub Actions still runs the existing checks and deploy scripts, but strict Temporal signals gate the critical transitions. Failed Temporal recording is a blocker, not a reason to bypass checks, deploy jobs, slot registry, or branch protection.
If this flow changes, update the Temporal workflow state, signals, tests, and the Temporal CI/CD document in the same branch; required delivery work must not live only in GitHub Actions or shell scripts.

Acceptance trigger:

- If the project owner says `Принято`, `принимаю`, `accepted`, or an equivalent acceptance phrase after a preview handoff, run `deploy/scripts/accept-preview.sh <codex-branch>` immediately. Negated phrases such as `пока не принято` or `не принято` are not acceptance triggers.
- The script is the single local acceptance entrypoint. It first requires verified preview state for the exact `origin/<codex-branch>` head, then creates or reuses a GitHub PR into `main` and calls `gh pr merge --<method> --auto --match-head-commit <sha>`, defaulting to `squash` unless `BRIGHT_OS_ACCEPT_MERGE_METHOD` is set to `merge` or `rebase`, so branch protection, checks, merge queue, production deploy, metadata promotion, and preview-slot release stay in GitHub Actions.
- After starting acceptance, monitor GitHub Actions until production deploy and preview-slot release finish, or report the exact PR/check/merge-queue/deploy/release blocker. Accepted preview slots are released only by the successful `deploy-prod` post-step, after metadata promotion and production deploy; that step requires a real slot release and fails if the accepted branch did not release one.

## Required GitHub Settings

Repository variables:

- `BRIGHT_DEPLOY_HOST` - VPS host or DNS name;
- `BRIGHT_DEPLOY_USER` - deploy user, for example `bright-deploy`;
- `BRIGHT_DEPLOY_SSH_PORT` - optional, defaults to `22`;
- `BRIGHT_DEPLOY_REPO` - optional, defaults to `/srv/projects/bright-os`.

Repository secret:

- `BRIGHT_DEPLOY_SSH_KEY` - private key for the deploy user. Do not commit it or write it into docs.

## Deploy User Boundary

The deploy user needs write access to `/srv/projects/bright-os-envs/` for CI uploads,
prod/dev/preview source checkouts, dev/preview web/OTA outputs, SQLite deployment metadata, and preview slot state.
For production deploys it also needs write access to the existing production web/OTA targets and
Bright OS SQLite file:

```text
/srv/projects/bright-os/deploy/web
/srv/projects/bright-os/deploy/mobile-update
/srv/projects/bright-os/data/bright_os.sqlite
/srv/projects/bright-os/data/bright_os.sqlite-wal when present
/srv/projects/bright-os/data/bright_os.sqlite-shm when present
```

The deploy user must not need read or write access to `/srv/projects/bright-os/.git`. Sudo should be limited to:

```text
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy
systemctl restart brightos-api.service
systemctl restart brightos-api-dev.service
systemctl restart brightos-api-preview-a.service
systemctl restart brightos-api-preview-b.service
systemctl restart brightos-api-preview-c.service
systemctl restart brightos-api-preview-d.service
systemctl restart brightos-api-preview-e.service
```

The Ansible sudoers template is `deploy/ansible/templates/brightos-deploy-sudoers.j2`.

## Server Setup

Run Ansible as `root` or another server admin account with full `become`, not as the limited CI deploy user. The playbook creates `bright-deploy`; add the CI public SSH key to that user outside source.

Dry run:

```bash
ansible-playbook -i deploy/ansible/inventory.example.ini deploy/ansible/bright-os.yml --check --diff
```

Apply after check mode passes and secrets/env files exist on the VPS:

```bash
ansible-playbook -i deploy/ansible/inventory.example.ini deploy/ansible/bright-os.yml
```

The current local VPS setup keeps the existing production service name `brightos-api.service`.
Prod, dev, and preview services run from the source checkout uploaded into
`/srv/projects/bright-os-envs/<environment>/source/services/bright_os_api` as the configured service user/group.
The limited `bright-deploy` user owns `/srv/projects/bright-os-envs`, publishes only the deployment
artifacts above, and uses sudo only for Caddy validation, Caddy reload, and matching Bright OS API service restarts.

Non-production Caddy routes keep the app shell protected with the unified Caddy Basic Auth login, but
`/mobile-update/*` stays public for Android OTA and `/api/*` is proxied to the matching Bright OS API without
Caddy Basic Auth or injected bearer headers. Bright OS API auth remains responsible for `/v1/*` data access,
so newly installed Dev/A-E apps may need their own in-app login session before sync turns green.

If an environment exists before its first CI deploy, publish a baseline web/OTA layer without changing APK
versions:

```bash
BRIGHT_OS_MIN_APK_VERSION_CODE=1 deploy/scripts/publish-environment-web-layer.sh dev preview-b preview-c preview-d preview-e
```

Ansible templates do not store passwords, Caddy auth hashes, deploy keys, Android signing secrets, or Bright OS API secrets. Per-environment Bright OS API secret env files live outside source under:

```text
/srv/projects/bright-os-envs/<environment>/bright-os-api.env
```

## Public Branch Protection

After the clean public repository has its initial public `main`, configure GitHub branch protection/ruleset for public `main`:

- require pull requests;
- require status checks from `Bright OS public main CI`;
- require `node scripts/check-public-branch.mjs`;
- block direct pushes;
- block force pushes;
- block branch deletion.

The public guard is required for `main`, `dev`, pull requests, and `codex/*` branches in the clean public repository.
