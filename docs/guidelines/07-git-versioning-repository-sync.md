# Git, Versioning, And Repository Sync

## Branch Policy

- `main` is the accepted production base.
- `codex/*` branches are task branches from the current `origin/main`.
- Preview slots A-E are review environments for preview-class `codex/*` work.
- Read-only analysis, planning, and questions without project-file writes do not need a task branch.
- `npm run app:dev` is only a local development server command; it is not a branch or deploy workflow.

Before the first project-file change in every new Codex thread, run:

```bash
scripts/brai-task-start.sh <task-slug>
```

In Codex Desktop this needs `sandbox_permissions=require_escalated`, because the starter fetches `origin/main`, writes Git worktree metadata, creates `.codex-worktrees/<task-slug>`, writes ignored `.brai-task/` state, enables `.githooks`, and links existing ignored dependency directories.

Staging changes from a task worktree may also require `sandbox_permissions=require_escalated`,
because Git writes the index lock under the main checkout's `.git/worktrees/` metadata. If an
escalated command leaves the task worktree owned by the wrong user, run:

```bash
scripts/brai-task-repair-permissions.sh <task-slug-or-worktree-path>
```

For ignored workspace/cache/output paths only, use the narrower repair and preflight:

```bash
scripts/brai-task-repair-permissions.sh --workspace <task-slug-or-worktree-path>
node scripts/brai-task.mjs preflight --strict
```

Do not create or switch fallback branches manually with `git switch`, `git checkout`, `git branch`, or `git worktree`.

## Access Contract

Use one permission contract instead of ad hoc `chmod`/`chown` fixes:

- source checkouts and Git metadata are locked for agents and are not runtime toolboxes for `brai-deploy`;
- deploy-owned env roots under `/srv/projects/brai-envs/*` are `brai-deploy:brai-deploy`, group-writable, and setgid;
- production SQLite is owned by `brai:brai-deploy`; the DB, WAL, and SHM files are group-writable;
- public web, OTA, and release artifacts are group-writable and public-readable;
- accepted-preview promotion, OTA sync, preview slot release, and baseline APK rebuilds run from deploy-owned source roots under `/srv/projects/brai-envs/*/source`, not from the locked live checkout.

The canonical checks are:

```bash
node scripts/brai-task.mjs access-contract --local
node scripts/brai-task.mjs access-contract --server
deploy/scripts/production-sqlite-maintenance.sh check
deploy/scripts/preview-slots.sh status
```

Manual permission repair is only a break-glass operation through Ansible, `/srv/opt/brai-main-sync.sh`, `scripts/brai-task-repair-permissions.sh`, or deploy helpers such as `deploy/scripts/permissions.sh`. Do not make one-off `chmod/chown` commands part of normal delivery.
Same-host operation cleanup uses `deploy/scripts/complete-operation-activities.sh --host-local ...`;
it still writes SQLite only as the `brai` service user through the narrow sudoers command.

## Branch Reuse

The branch selected by Codex Desktop is not permission to continue that branch. A new thread that will change project files starts a new `codex/*` branch from `origin/main`.

Same-thread follow-up writes may continue an existing `codex/*` branch only before acceptance and only after:

```bash
node scripts/brai-task.mjs follow-up
```

The task base is frozen at starter time in `.brai-task/task.json`. Before acceptance, do not refresh that branch from the later `origin/main`: no `git fetch origin main`, `git pull origin main`, `git merge origin/main`, `git rebase origin/main`, or equivalent base-update command. Continue follow-up work on the same branch and let the acceptance PR/merge surface any real conflict; if the branch was already accepted, start a new task branch from the then-current `origin/main`.

After acceptance starts, merge conflict resolution is allowed only through:

```bash
node scripts/brai-task.mjs acceptance-reconcile <codex-branch>
```

This is the only approved path for updating an accepted preview branch from the current `origin/main`. It keeps the same branch, PR, and preview slot, then requires a new push, preview verification, and rerun of `deploy/scripts/accept-preview.sh`.

After a branch is accepted through PR/merge into `main`, every new write starts a new `codex/*` branch, even inside the same thread.

If a question arrives during implementation and the user did not say stop, pause, or only answer, answer the question, add the new information to context, and continue the task.

## Delivery Classes

Before final handoff, classify the branch with the guard:

- runtime/product work, including runtime bug fixes, requires preview handoff;
- docs/infra guard-fix work uses the `infra-docs` no-preview PR path into `main`;
- technical fixes that only change tests, test config, or narrowly allowed agent-operation bookkeeping use the `technical-no-preview` PR path into `main`;
- blocked or unknown paths must be reported instead of handed off as complete.

Preview-class work is incomplete until the exact branch head is pushed, CI/deploy has verified the slot, release notes have been recorded with `node scripts/brai-task.mjs release-notes --short "..." --details "..." --reason "..."`, and `scripts/brai-preview-handoff.sh` succeeds. The final implementation response must start with that command's verified `<slot emoji> Preview` header, then URL, branch, and commit.

No-preview work is complete only after `node scripts/brai-task.mjs handoff` verifies the no-preview workflow and reports branch, commit, `deliveryClass=infra-docs` or `deliveryClass=technical-no-preview`, `autoMerge=enabled` when applicable, and `prState=MERGED` with merged PR metadata. `autoMerge=enabled` alone is an intermediate state, not final handoff evidence.

## Acceptance

After preview handoff, `Принято`, `принимаю`, `accepted`, or an equivalent non-negated phrase from the user is an acceptance trigger. Run:

```bash
deploy/scripts/accept-preview.sh <codex-branch>
```

Then monitor the PR/merge queue, `deploy-prod`, metadata promotion, and preview-slot release until completion or a concrete blocker.

If acceptance reports `mergeStateStatus: DIRTY` or `BEHIND`, run the same-branch `acceptance-reconcile` command, resolve conflicts if any, push the same branch, rerun preview handoff for the new head, and rerun `accept-preview.sh`. Do not create a replacement branch or PR for accepted conflict resolution.

## Checks

Implementation tasks must finish with a clean tracked working tree, intended changes committed, and the task branch pushed unless the user explicitly requested local-only/no-push work.

Relevant checks:

- public hygiene: `npm run public:guard`
- OpenSpec: `npm run openspec:validate`
- guard/hooks: `npm run task:test`
- Temporal-sensitive changes: `npm run temporal:test`
- access contract-sensitive changes: `node scripts/brai-task.mjs access-contract --local` locally, then `--server` after server remediation
- client/API checks when those surfaces change

Use [CHECKLIST_REPOSITORY_SYNC.md](../checklists/CHECKLIST_REPOSITORY_SYNC.md) before commit/push and [branch-preview-environments.md](../operations/branch-preview-environments.md) for the full runbook.
