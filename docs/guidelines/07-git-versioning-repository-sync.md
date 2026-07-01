# Git, Versioning, And Repository Sync

## Branch Policy

- `main` is the accepted production base.
- `codex/*` branches are task branches from the current `origin/main`.
- Preview slots A-E are review environments for preview-class `codex/*` work.
- Read-only analysis, planning, and questions without project-file writes do not need a task branch.
- `npm run app:dev` is only a local development server command; it is not a branch or deploy workflow.

Before the first project-file change in every new Codex thread, run:

```bash
scripts/bright-task-start.sh <task-slug>
```

In Codex Desktop this needs `sandbox_permissions=require_escalated`, because the starter fetches `origin/main`, writes Git worktree metadata, creates `.codex-worktrees/<task-slug>`, writes ignored `.bright-task/` state, enables `.githooks`, and links existing ignored dependency directories.

Staging changes from a task worktree may also require `sandbox_permissions=require_escalated`,
because Git writes the index lock under the main checkout's `.git/worktrees/` metadata. If an
escalated command leaves the task worktree owned by the wrong user, run:

```bash
scripts/bright-task-repair-permissions.sh <task-slug-or-worktree-path>
```

Do not create or switch fallback branches manually with `git switch`, `git checkout`, `git branch`, or `git worktree`.

## Branch Reuse

The branch selected by Codex Desktop is not permission to continue that branch. A new thread that will change project files starts a new `codex/*` branch from `origin/main`.

Same-thread follow-up writes may continue an existing `codex/*` branch only before acceptance and only after:

```bash
node scripts/bright-task.mjs follow-up
```

The task base is frozen at starter time in `.bright-task/task.json`. Before acceptance, do not refresh that branch from the later `origin/main`: no `git fetch origin main`, `git pull origin main`, `git merge origin/main`, `git rebase origin/main`, or equivalent base-update command. Continue follow-up work on the same branch and let the acceptance PR/merge surface any real conflict; if the branch was already accepted, start a new task branch from the then-current `origin/main`.

After a branch is accepted through PR/merge into `main`, every new write starts a new `codex/*` branch, even inside the same thread.

If a question arrives during implementation and the user did not say stop, pause, or only answer, answer the question, add the new information to context, and continue the task.

## Delivery Classes

Before final handoff, classify the branch with the guard:

- runtime/product work, including runtime bug fixes, requires preview handoff;
- docs/infra guard-fix work uses the `infra-docs` no-preview PR path into `main`;
- blocked or unknown paths must be reported instead of handed off as complete.

Preview-class work is incomplete until the exact branch head is pushed, CI/deploy has verified the slot, and `scripts/bright-preview-handoff.sh` succeeds. The final implementation response must start with that command's verified `<slot emoji> Preview` header, then URL, branch, and commit.

Infra-docs work is complete only after `node scripts/bright-task.mjs handoff` verifies the no-preview workflow and reports branch, commit, `deliveryClass=infra-docs`, `autoMerge=enabled` when applicable, and `prState=MERGED` with merged PR metadata. `autoMerge=enabled` alone is an intermediate state, not final handoff evidence.

## Acceptance

After preview handoff, `Принято`, `принимаю`, `accepted`, or an equivalent non-negated phrase from the user is an acceptance trigger. Run:

```bash
deploy/scripts/accept-preview.sh <codex-branch>
```

Then monitor the PR/merge queue, `deploy-prod`, metadata promotion, and preview-slot release until completion or a concrete blocker.

## Checks

Implementation tasks must finish with a clean tracked working tree, intended changes committed, and the task branch pushed unless the user explicitly requested local-only/no-push work.

Relevant checks:

- public hygiene: `npm run public:guard`
- OpenSpec: `npm run openspec:validate`
- guard/hooks: `npm run task:test`
- Temporal-sensitive changes: `npm run temporal:test`
- client/API checks when those surfaces change

Use [CHECKLIST_REPOSITORY_SYNC.md](../checklists/CHECKLIST_REPOSITORY_SYNC.md) before commit/push and [branch-preview-environments.md](../operations/branch-preview-environments.md) for the full runbook.
