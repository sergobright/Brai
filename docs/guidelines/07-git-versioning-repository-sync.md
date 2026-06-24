# Git, Versioning, And Repository Sync

## Branch Classes

- `main` - production source.
- `dev` - shared development source.
- `codex/*` - task branches with preview slots.

`codex/*` pushes deploy to an allocated preview slot (`a.test` through `e.test`) with that slot's web shell, API service, SQLite data path, and mobile OTA endpoint. Production apps and `dev.brightos.world` are not updated until the branch is accepted into `dev` or promoted to `main`.

Preview deployments are review environments, not accepted build versions. They record deployment metadata in `deployment_records`, but their visible app/web version must stay on the current accepted `dev` version with a preview OTA bundle suffix. A new public build version becomes real only after the change is accepted into `dev` and `deploy-dev` succeeds.

Before the first project-file change for a task, branch from the latest accepted base. Ordinary future task work starts from `origin/dev` unless another base is explicitly requested.

Read-only questions, planning, and investigation without project-file changes do not need a branch or preview slot.

## Commit And Push

Implementation tasks must finish with a clean tracked working tree.

If a task changes project files, commit the intended tracked changes and push the task branch before handing work back, unless the user explicitly requested planning only, local-only work, no commit, or no push.

Before commit:

- check current branch;
- inspect `git status --short`;
- stage only intended files;
- do not revert unrelated changes;
- run or report relevant checks.

If checks fail or an external blocker prevents commit or push, report the exact branch, tracked status, failing check, and next command instead of implying the task is complete.

Ignored generated files may remain local. Do not commit runtime data, build output, signing material, local caches, or generated deploy artifacts.

## Public Baseline

The public repository starts from a clean baseline history. Do not push old private/bootstrap history, runtime artifacts, generated deploy output, signing material, databases, or personal notes.
