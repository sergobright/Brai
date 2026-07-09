# Preview APK compatibility

- Status: accepted
- Deciders: Project owner, Codex
- Date: 2026-06-29
- Tags: android, preview, apk, ota

## Context

Preview branches can change the Android native boundary. A stale preview APK must not silently run an incompatible OTA bundle.

## Decision

Native-boundary preview branches publish slot-specific APKs and matching OTA metadata. Preview Android `versionCode` uses `N * 10000 + M`, where `N` is the stable APK version and `M` is the branch-local preview iteration.

## Alternatives Considered

- Reuse production APKs for native preview branches: rejected because native/web compatibility can drift.
- Publish preview OTA without APK compatibility metadata: rejected because incompatible clients would fail late.

## Consequences

- Positive: stale preview APKs are blocked instead of silently running incompatible bundles.
- Negative: native preview deploys are heavier than web-only preview deploys.
- Risk: APK ledger or slot metadata mistakes can block preview handoff.

## Confirmation

Verify native-boundary preview APK metadata, OTA manifest compatibility, and release index entries during preview deploy.

## Links

- `openspec/specs/app-delivery/spec.md`
- `docs/operations/branch-preview-environments.md`
- `docs/guidelines/05-android-web-ota-releases.md`

## Supersedes

None.

## Superseded By

None.
