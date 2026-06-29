# Progress

## Done

- Public point-zero cleanup plan accepted.
- Public guard is part of the baseline design.
- OpenSpec accepted specs are the durable requirements source.
- Memory Bank has been reset to public-safe project context.
- Clean `main` was pushed to the public repository.
- GitHub Actions deploys production from `main`; the current delivery loop uses `main` and `codex/*`.
- Branch protection requires `public-guard` and `checks`.
- Public baseline version is `0.0.1.1`.
- Historical accepted task versions `0.0.2.1` through `0.0.7.1` were recorded before the current direct-to-`main` acceptance loop.
- Versioning is no longer coupled to GitHub PR numbers.
- Runtime `build_versions` is the source of truth for typed version counters.

## Current State

- Future work starts from `origin/main` on `codex/*` branches.
- Task branches do not add `build_versions` rows by themselves.
- Accepted working-branch merges into `main` add one `build` row and increment only the `build` counter.
- Build ledger `short_changes` and `detailed_changes` are human-readable release notes; `reason` explains the problem or need behind the change; branch/commit/deploy audit metadata belongs in `build_version_refs` or `deployment_records`.
- Production deploys do not create `release` or `canon` rows automatically.
- `release` rows are created only by explicit command and link unlinked `build` rows plus the current `apk` row through `included_in_version_id`.
- `canon` rows are created only by explicit command and link unlinked `release` rows through `included_in_version_id`.
- Shipped APK releases add an `apk` row and increment only the `apk` counter.
- Implementation tasks must finish with clean tracked status, committed, pushed, and deployed to a preview slot with the preview letter and URL reported, unless explicitly local-only. If all preview slots are occupied, the pushed branch is queued and remains incomplete until a slot is assigned.
- Branch/preview enforcement is implemented through `scripts/bright-task.mjs`, `.codex/hooks.json`, `.githooks/`, and `scripts/bright-preview-handoff.sh`. New project-file tasks should start through `scripts/bright-task-start.sh <task-slug>`, local Git hooks should be enabled with `git config core.hooksPath .githooks`, and changed Codex hooks must be trusted through `/hooks`.
- After preview handoff, the project owner saying `Принято` or an equivalent acceptance phrase must run `deploy/scripts/accept-preview.sh <codex-branch>` and monitor PR/merge/deploy/release instead of replying with an acknowledgement. Negated phrases such as `пока не принято` do not trigger acceptance. Accepted preview slots are released by the successful `deploy-prod` post-step after metadata promotion and production deploy, and a missing slot release is a blocker.
- Temporal is integrated as the required CI/CD control ledger for `codex/*` branch previews and production promotions. Existing GitHub Actions checks/deploy jobs and preview slot scripts still execute the deployment work, but strict Temporal signals gate the critical transitions and retain failed checks/deploys/releases as `waiting_for_fix` blockers.
