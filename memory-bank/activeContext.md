# Active Context

## Current Focus

Brai now uses the clean public repository baseline as its source of truth.

`main` is production and the accepted base. `codex/*` branches are task branches with preview/deploy checks. Runtime data, release artifacts, signing material, server-only env files, local backups, and personal notes stay outside Git.

## Next Steps

- Keep future requirement changes in `openspec/changes/` until accepted.
- Keep durable accepted behavior in `openspec/specs/`.
- Keep public-safe project facts in `memory-bank/`.
- Run `npm run public:guard` before publishing or merging public branches.
- Start future project-file work from current `origin/main` on `codex/*` branches.
- Keep accepted production builds recorded in `build_versions` as `build` rows with Russian `short_changes`, `detailed_changes`, and `reason`; keep APK releases in the separate `apk` line and OTA/web versions as separate `X.Y.Z`.
- Implementation tasks should end with committed and pushed tracked changes unless explicitly local-only.

## Open Questions

- None for the public baseline.
