# Android, Web, OTA, And Releases

Bright OS version rows use four `version_type_id` values: `apk`, `build`, `release`, `canon`.

- `build_versions.version` is an integer counter scoped to `version_type_id`.
- The public app version is assembled as `canon.release.build.apk` from the latest counters; missing `canon` or `release` is `0`.
- Accepted `codex/*` work records one `build` row only.
- `release` rows are created only by explicit command; a release links all unlinked `build` rows and the current `apk` row through `included_in_version_id`.
- `canon` rows are created only by explicit command; a canon links all unlinked `release` rows through `included_in_version_id`.
- APK rows are created only when a shipped APK is built.
- Branch names, commits, domains, and deploy metadata belong in `build_version_refs` or `deployment_records`, not visible release-note text.

Build and publish a release APK only when native Android code, Capacitor config, permissions, signing, manifest values, application id, SDK versions, icons, splash assets, native plugins, or native compatibility boundaries change.

## Shipped APK Ledger Order

For a production shipped APK, resolve the APK `versionName` from the production `build_versions` ledger as `canon.release.build.(apk + 1)` before the Gradle build, publish the APK with that exact `X.Y.Z.S`, then record the new `apk` row immediately after the APK is published. If the same target branch/commit is retried, reuse its existing `apk` row instead of incrementing again. Preview APKs and non-production baseline APK rebuilds must not create `apk` rows.

Release APK signing is env-only. Required variables:

- `BRIGHT_OS_ANDROID_KEYSTORE_PATH`
- `BRIGHT_OS_ANDROID_STORE_PASSWORD`
- `BRIGHT_OS_ANDROID_KEY_ALIAS`
- `BRIGHT_OS_ANDROID_KEY_PASSWORD`

Do not commit APKs, OTA bundles, release pages, keystores, signing passwords, or generated deploy output.
