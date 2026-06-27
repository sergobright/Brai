# Git, Versioning, And Repository Sync

## Branch Classes

- `main` - production source.
- `dev` - shared development source, temporarily outside the delivery loop.
- `codex/*` - task branches with preview slots.

Preview-class `codex/*` pushes deploy to an allocated preview slot (`a.test` through `e.test`) with that slot's web shell, API service, SQLite data path, and mobile OTA endpoint. Production apps are not updated until the branch is accepted into `main`; `dev.brightos.world` is temporarily outside the delivery loop.

When a preview branch changes the Android native boundary, the preview deploy also builds a slot-specific APK, records its APK file and `versionCode` in the preview slot registry, and publishes an OTA manifest that requires that exact `versionCode`. Accepted native work rebuilds the Preview A-E APK baseline from production source during slot release; unaccepted native preview slot release rebuilds the freed slot baseline from production source.

Infrastructure/documentation-only branches can use the Temporal no-preview path when the delivery class is `infra-docs`. That path records `delivery_classified`, `no_preview_required`, `delivery_handoff_*`, and `auto_merge_*`, marks `preview_deploy`, `accepted_preview_promotion`, and `slot_release` as `not_applicable`, and completes the branch lifecycle at `pr_merged` without a preview slot.

Preview deployments are review environments, not accepted build versions. They record deployment metadata in `deployment_records`, but their visible app/web version must stay on the current production version with a preview OTA bundle suffix. A new public build version becomes real only after the change is accepted into `main` and `deploy-prod` succeeds.

GitHub PRs are review and merge records, not version numbers. Version numbers come from the `build_versions` ledger: accepted working-branch merges into `main` create `Z`, and production releases create `Y`.

Temporal is the required CI/CD control ledger. If a delivery/versioning process changes, update the Temporal workflow state, signals, tests, and `docs/operations/temporal-ci-cd.md` in the same branch. Required delivery work must not live only in GitHub Actions or shell scripts.

Before the first project-file change in every new Codex thread, branch from the latest accepted base. Ordinary future task work starts from `origin/main` unless another base is explicitly requested.

The branch selected by Codex Desktop is not permission to continue that branch. If a new thread will change any project file, start a new `codex/*` branch first, regardless of whether the UI selected `main`, `dev`, or the last used task branch. Existing task branches may receive more project-file changes only from the same Codex thread before the branch is accepted into `main`; after acceptance, any follow-up or refinement starts another new task branch.

Read-only questions, planning, and investigation without project-file changes do not need a branch or preview slot.

Use `scripts/bright-task-start.sh <task-slug>` for normal implementation starts. In Codex Desktop, run it with `sandbox_permissions=require_escalated` immediately because it creates a sibling worktree outside the repository sandbox. It creates a separate worktree from `origin/main`, records the current Codex thread id in `.bright-task/`, enables `.githooks`, links existing ignored `node_modules` directories from the main checkout when present, and prevents accidental upstream tracking of `origin/main`. If the starter cannot create the worktree, stop without project-file changes; do not create or switch to a manual fallback branch in the current checkout. Repository Codex hooks in `.codex/hooks.json` recursively inspect namespaced/custom/nested write tools, allow only explicit read-only shell commands before valid task state, and block writes, commits, pushes, and handoff when this rule is violated, after the hook definition has been locally trusted through Codex `/hooks`.

Implementation work that changes project files is not complete until the task branch is pushed and either CI/deploy has assigned or reused a preview slot, or Temporal has classified the branch as `infra-docs` with `no_preview_required`. Preview-class handoff names the preview letter and URL. Infra-docs no-preview handoff creates or reuses the PR through the agent's GitHub identity before waiting for CI, then names the branch, commit, `deliveryClass=infra-docs`, `handoff=passed`, `autoMerge=enabled`, and merged PR state. When the current branch/commit is actually deployed to a preview slot, the single final handoff response must start with the slot emoji plus `Preview`, for example `🅰️ Preview` (`🅰️`, `🅱️`, `🅲`, `🅳`, or `🅴`); skip the emoji line for intermediary updates, status replies, questions, acceptance monitoring, no-preview handoffs, and any reply where the slot or deployed commit is unverified. If all five preview slots are occupied, the branch is queued for the next released slot; report the queued status and position/source if available, but do not describe preview-class work as complete until a slot letter and URL exist.

After a preview handoff, the project owner saying `Принято`, `принимаю`, `accepted`, or an equivalent acceptance phrase is an acceptance trigger, not a conversational acknowledgement. Negated phrases such as `пока не принято` or `не принято` are not acceptance triggers. Run `deploy/scripts/accept-preview.sh <codex-branch>` immediately; it must verify preview state for the exact branch head before PR or merge actions. Then monitor the GitHub PR/merge queue, `deploy-prod`, and preview-slot release until completion or an explicit blocker/queue state is known. Do not answer with only "принято".

## Commit And Push

Implementation tasks must finish with a clean tracked working tree.

If a task changes project files, commit the intended tracked changes and push the task branch before handing work back, unless the user explicitly requested planning only, local-only work, no commit, or no push.

For Bright OS `codex/*` task branches, pushing to `origin` and triggering the preview deployment is part of the standing CI/CD workflow approved by the project owner. Do not ask for a separate per-task push confirmation for ordinary implementation work. If the execution environment still blocks the push or deploy, report the exact blocker and leave the task marked incomplete.

Enable checked-in Git hooks with `git config core.hooksPath .githooks`. The hooks block protected branch pushes, wrong upstream/refspecs, commits from invalid task branches, generated/runtime/secret-like staged files, and pushes that fail required local guards.

Before the final handoff for preview-class project-file changes, run `scripts/bright-preview-handoff.sh`. Use the preview letter and URL from that verifier output, not from memory or branch naming. For `infra-docs` no-preview work, use the Temporal preview workflow state instead of slot evidence.

Before commit:

- check current branch;
- inspect `git status --short`;
- stage only intended files;
- do not revert unrelated changes;
- run or report relevant checks.

If checks fail or an external blocker prevents commit, push, or preview deploy, report the exact branch, tracked status, failing check or deploy step, and next command instead of implying the task is complete. A full preview pool is a queue state, not a failed task; keep monitoring or report the queued state when the current turn cannot wait.

Ignored generated files may remain local. Do not commit runtime data, build output, signing material, local caches, or generated deploy artifacts.

## GitHub CLI In Codex

Codex sandbox network restrictions can make `gh auth status` falsely report a GitHub CLI login
failure. Before asking the user to re-authenticate, rerun the same `gh` command with network access
outside the sandbox. Treat authentication as broken only if the outside-sandbox check also fails.

## Public Baseline

The public repository starts from a clean baseline history. Do not push old private/bootstrap history, runtime artifacts, generated deploy output, signing material, databases, or personal notes.
