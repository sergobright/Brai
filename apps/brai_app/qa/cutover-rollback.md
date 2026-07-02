# Brai Release Runbook

## Public Baseline

- Source baseline version: `0.0.1.1`.
- Web client: Next.js static export from `apps/brai_app/out`, published operationally to `deploy/web`.
- Android client: Capacitor APK/AAB generated operationally under `deploy/releases`.
- Mobile OTA channel: generated operationally under `deploy/mobile-update`.
- Generated release artifacts are ignored source-control outputs, not repository history.
- Android application id remains `world.brightos.brai`.

## Web Publication

- Preferred web-layer release command: `npm run publish:client-web-layer`. It builds once, publishes browser web assets to `deploy/web`, and publishes an Android OTA bundle from the same output.
- `deploy/scripts/publish-web.sh` synchronizes the current Next static output.
- The web output should be republished after every client build that changes served assets.
- Removed files must not remain in `deploy/web` after publication.

## APK Versus Web/OTA Updates

- Android web-layer OTA uses the Brai native loader and Capacitor's local server path.
- Web-layer changes intended for live use should publish both browser web and Android OTA with `npm run publish:client-web-layer`.
- Use `npm run publish:web` or `npm run publish:mobile-bundle` alone only for targeted diagnostics or recovery.
- Native changes always require a new APK/AAB: permissions, Capacitor plugins, Java/Kotlin code, signing, manifest values, application id, SDK versions, icons, and splash assets.
- Local database migrations delivered by OTA must remain backward-compatible with the previous stable OTA bundle and APK fallback.

## Mobile OTA Publication

- Public version format: `X.Y.Z.S`, for example `0.0.1.1`.
- The bundle archive root contains the static export entrypoint `index.html`, `_next/`, app assets, `version.json`, and non-secret `metadata.json`.
- `deploy/scripts/publish-mobile-bundle.sh` writes `deploy/mobile-update/bundles/<bundleVersion>/bundle.zip`, writes adjacent `metadata.json`, and atomically replaces `deploy/mobile-update/manifest.json`.
- The publish script retains the current bundle plus at least 3 previous bundle directories.
- `/mobile-update/*` must be served by Caddy before the protected web catch-all.

## Verification Status

- Automated unit, component, build, and Playwright smoke coverage exercises the shared web/Android shell behavior.
- Physical Android install/update QA remains environment-dependent because it requires an attached target device.

## Rollback

- Browser web rollback means publishing a newer fixed web build.
- Mobile OTA rollback means republishing the manifest to a retained compatible operational bundle or publishing a newer fixed bundle.
- Candidate OTA bundles roll back automatically to the previous stable bundle or APK fallback if readiness fails.
- Native rollback still requires publishing a newer fixed APK.
- Retired source and release artifacts are not kept in Git as an active rollback surface.
