# Branch Preview Environments

Bright OS uses one VPS for seven environments:

- Production: `app.brightos.world`, branch `main`;
- Dev: `dev.brightos.world`, branch `dev`;
- Preview A-E: `a.test.brightos.world` through `e.test.brightos.world`, branches `codex/*`;
- Preview status: `previews.brightos.world`.

## Agent Flow

Read-only questions, planning, investigation without project-file changes, and environment setup outside the project do not need a branch or preview slot. Before the first project-file change for a new task, start from `origin/dev` and create `codex/<task-slug>` unless the project owner explicitly chooses another branch/base.

Agents must not reuse an existing unrelated `codex/*` branch just because it is the current checkout. Direct follow-ups may continue the same branch, and explicit project-owner branch instructions override the default.

A pushed `codex/*` branch allocates or reuses a preview slot through `deploy/scripts/preview-slots.sh`, deploys that slot, and reports the slot URL. If all slots `A` through `E` are occupied, the branch enters the preview queue until a slot is released. No push means no slot/deploy/queue.

Local dev server URLs are agent-only verification aids. The user-facing handoff for project changes is the preview slot URL after `deploy-preview` succeeds; if CI/deploy is not complete, report that blocker instead of asking the project owner to open `localhost` or `127.0.0.1`.

## Mechanical Guard Rails

Use the checked-in task starter before the first project-file change:

```bash
scripts/bright-task-start.sh <task-slug>
```

The starter fetches `origin/dev`, refuses to reuse an existing remote `codex/<task-slug>`, creates a separate worktree under `../bright-os-worktrees/<task-slug>`, creates `codex/<task-slug>` with `--no-track`, and writes ignored local task state under `.bright-task/`.

Repository Codex hooks are defined in `.codex/hooks.json`:

- `PreToolUse` blocks write-like `exec_command`/`Bash` commands and `apply_patch` unless the checkout is a valid `codex/*` task branch based on `origin/dev`.
- A pushed existing `codex/*` branch also needs local `.bright-task/` task state, so a new task cannot silently reuse an old preview branch. If the project owner explicitly asks for a direct follow-up on the current branch, run `node scripts/bright-task.mjs follow-up` first.
- `Stop` blocks handoff when the working tree is dirty or when project-file writes were made without a verified preview receipt.

Codex requires new or changed repo hooks to be reviewed and trusted through `/hooks`; that trust is local Codex security state and is not committed to Git.

Git hooks live in `.githooks/`. Enable them in each local clone/worktree:

```bash
git config core.hooksPath .githooks
```

`pre-commit` blocks commits outside valid `codex/*` task branches and rejects staged generated/runtime/secret-like files. `pre-push` blocks direct `main`/`dev` pushes, ref mismatches, branches not based on `origin/dev`, and pushes that fail the public guard. CI/CD-sensitive pushes also run the Temporal test suite before leaving the machine.

Before a final implementation handoff, run:

```bash
scripts/bright-preview-handoff.sh
```

The verifier requires a clean tree, pushed `origin/<codex-branch>` at `HEAD`, successful `Bright OS delivery` jobs including `deploy-preview`, and a ready preview slot from the slot registry or Temporal. It writes an ignored `.bright-task/preview-handoff.json` receipt that the Codex `Stop` hook checks.

For implementation tasks, the final handoff response must include the preview letter (`A` through `E`), preview URL, branch, and commit. When the current branch/commit is actually deployed to a preview slot, that single final handoff response must start with the slot emoji plus `Preview`, for example `🅰️ Preview` (`🅰️`, `🅱️`, `🅲`, `🅳`, or `🅴`). Do not print a preview emoji in intermediary updates, status replies, questions, acceptance monitoring, or any reply where the slot or deployed commit is unverified. If the preview letter or URL is missing because every slot is occupied, the response must say the branch is queued and include queue position/source when available. If it is missing for any other reason, the response must say exactly which push, CI, or deploy step blocked it. Ordinary `codex/*` branch push/deploy is standing Bright OS CI/CD automation and must not be treated as an optional manual confirmation step.

Preview acceptance flow:

```text
codex/* accepted -> accept-preview.sh -> PR/merge queue into dev -> deploy dev -> release preview slot
dev accepted     -> merge into main -> production release/deploy
```

Temporal is the required CI/CD control ledger for this flow. See
[Temporal CI/CD Orchestration](temporal-ci-cd.md). GitHub Actions still runs the existing checks and deploy scripts, but strict Temporal signals gate the critical transitions. Failed Temporal recording is a blocker, not a reason to bypass checks, deploy jobs, slot registry, or branch protection.
If this flow changes, update the Temporal workflow state, signals, tests, and the Temporal CI/CD document in the same branch; required delivery work must not live only in GitHub Actions or shell scripts.

Acceptance trigger:

- If the project owner says `Принято`, `принимаю`, `accepted`, or an equivalent acceptance phrase after a preview handoff, run `deploy/scripts/accept-preview.sh <codex-branch>` immediately. Negated phrases such as `пока не принято` or `не принято` are not acceptance triggers.
- The script is the single local acceptance entrypoint. It creates or reuses a GitHub PR into `dev` and calls `gh pr merge --merge --auto --match-head-commit <sha>` so branch protection, checks, merge queue, `deploy-dev`, metadata promotion, and preview-slot release stay in GitHub Actions.
- After starting acceptance, monitor GitHub Actions until `dev` deploy and preview-slot release finish, or report the exact PR/check/merge-queue/deploy/release blocker. Accepted preview slots are released only by the successful `deploy-dev` post-step, after metadata promotion; that step requires a real slot release and fails if the accepted branch did not release one.

The development repository default branch should be `dev` once `dev` exists. If `dev` is missing during the first accepted preview, bootstrap it from the latest accepted workflow/source commit, set GitHub default branch to `dev`, then merge the accepted `codex/*` branch into `dev` through a PR so the normal promotion and slot-release jobs run.

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
