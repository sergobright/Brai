# Self-hosted Android OTA updates

- Status: accepted
- Deciders: Project owner, Codex
- Date: 2026-06-28
- Tags: android, ota, self-hosted, deployment

## Context

Brai is a self-hosted productivity app. Android web-layer updates need a durable update mechanism without requiring a managed proprietary OTA service account.

## Decision

Brai hosts Android web-layer OTA manifests and bundles on the configured Brai server. OTA artifacts must not contain private credentials, and future self-hosted deployments can target their own update manifests.

## Alternatives Considered

- Use a managed proprietary OTA service: rejected for the default path because it weakens the self-hosted model.
- Require every web-layer change to ship as a new APK: rejected because OTA-eligible web changes can be delivered without crossing the native boundary.

## Consequences

- Positive: update infrastructure remains self-hostable and under project control.
- Negative: Brai owns manifest publishing, rollback retention, and compatibility checks.
- Risk: native-boundary changes still require APK releases and compatibility gating.

## Confirmation

Verify OTA manifests and bundles through the Android web OTA release checklist before release.

## Links

- `openspec/specs/self-hosted-distribution/spec.md`
- `openspec/specs/app-delivery/spec.md`
- `docs/guidelines/05-android-web-ota-releases.md`

## Supersedes

None.

## Superseded By

None.
