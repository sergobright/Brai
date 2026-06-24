# Active Context

## Current Focus

Bright OS now uses the clean public repository baseline as its source of truth.

`main` is production, `dev` is the shared integration branch, and `codex/*` branches are task branches with preview/deploy checks. Runtime data, release artifacts, signing material, server-only env files, local backups, and personal notes stay outside Git.

## Next Steps

- Keep future requirement changes in `openspec/changes/` until accepted.
- Keep durable accepted behavior in `openspec/specs/`.
- Keep public-safe project facts in `memory-bank/`.
- Run `npm run public:guard` before publishing or merging public branches.
- Use `dev` for shared development and `codex/*` branches for preview work.
- Keep public release versions aligned with the `build_versions` ledger.

## Open Questions

- None for the public baseline.
