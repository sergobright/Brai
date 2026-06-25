# Progress

## Done

- Public point-zero cleanup plan accepted.
- Public guard is part of the baseline design.
- OpenSpec accepted specs are the durable requirements source.
- Memory Bank has been reset to public-safe project context.
- Clean `main` and `dev` were pushed to the public repository.
- GitHub Actions deploys from `main` and `dev`.
- Branch protection requires `public-guard` and `checks`.
- Public baseline version is `0.0.1.1`.
- First accepted `dev` task version is `0.0.2.1`.
- Second accepted `dev` task version is `0.0.3.1`.
- Third accepted `dev` task version is `0.0.4.1`.
- Fourth accepted `dev` task version is `0.0.5.1`.
- Fifth accepted `dev` task version is `0.0.6.1`.
- Sixth accepted `dev` task version is `0.0.7.1`.
- Versioning is no longer coupled to GitHub PR numbers.
- Runtime `build_versions` is the source of truth for current accepted dev builds and production releases.

## Current State

- Future work starts from `origin/dev` on `codex/*` branches.
- Task branches do not add `build_versions` rows by themselves.
- Accepted working-branch merges into `dev` add a detailed `build` ledger row with `release_version = 0` and increment `Z`.
- Promotions from `dev` to `main` add a detailed production `build` ledger row, increment `Y`, keep the latest included `Z`, and reference the accepted dev build rows included in the release.
- Shipped APK releases add an `apk` ledger row and increment `S`.
- Implementation tasks must finish with clean tracked status, committed, pushed, and deployed to a preview slot with the preview letter and URL reported, unless explicitly local-only. If all preview slots are occupied, the pushed branch is queued and remains incomplete until a slot is assigned.
- After preview handoff, the project owner saying `Принято` or an equivalent acceptance phrase must run `deploy/scripts/accept-preview.sh <codex-branch>` and monitor PR/merge/deploy/release instead of replying with an acknowledgement. Negated phrases such as `пока не принято` do not trigger acceptance. Accepted preview slots are released by the successful `deploy-dev` post-step after metadata promotion, and a missing slot release is a blocker.
