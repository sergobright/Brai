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
- Current accepted `dev` build version is `0.0.8.1`.
- The `build_versions` ledger has exactly 8 `build` rows; `Z` must match the build row count and accepted GitHub PR number.

## Current State

- Future work starts from `origin/dev` on `codex/*` branches.
- Task branches do not add `build_versions` rows by themselves.
- Accepted task merges into `dev` add a `build` ledger row and increment `Z`.
- Promotions from `dev` to `main` add a `build` ledger row and increment `Y`.
- Shipped APK releases add an `apk` ledger row and increment `S`.
- Implementation tasks must finish with clean tracked status, committed and pushed, unless explicitly local-only.
