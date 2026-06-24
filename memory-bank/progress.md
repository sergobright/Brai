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

## Current State

- Future work starts from `origin/dev` on `codex/*` branches.
- Task branches do not add `build_versions` rows by themselves.
- Accepted task merges into `dev` add a `build` ledger row and increment `Z`.
- Promotions from `dev` to `main` add a `build` ledger row and increment `Y`.
- Shipped APK releases add an `apk` ledger row and increment `S`.
