# Repository Sync Checklist

- [ ] Read `docs/guidelines/07-git-versioning-repository-sync.md`.
- [ ] Check current branch.
- [ ] Inspect `git status --short`.
- [ ] Stage only intended files.
- [ ] Do not revert unrelated changes.
- [ ] Run or report relevant checks.
- [ ] Commit intended changes.
- [ ] Push the `codex/*` task branch to `origin` unless the task is explicitly local-only/no-push.
- [ ] Wait for CI/deploy to assign or reuse a preview slot.
- [ ] If all preview slots are occupied, report queued status and queue position/source when available.
- [ ] If the project owner accepts the preview (`Принято`, `принимаю`, `accepted`, or equivalent, but not negated phrases like `пока не принято`), run `deploy/scripts/accept-preview.sh <codex-branch>` instead of replying with an acknowledgement.
- [ ] For accepted preview work, verify the successful `deploy-dev` post-step promoted metadata and released the preview slot; treat a missing release as a blocker.
- [ ] End with clean tracked `git status --short` and report preview letter + URL, or report queued/blocker status explicitly.
