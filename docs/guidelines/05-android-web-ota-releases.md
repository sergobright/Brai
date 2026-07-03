# Android, Web, OTA, And Releases

Brai uses separate version lines for APK and OTA/web.

- APK uses the public integer counter `vN`, starting at `v1`.
- Android `versionName` is `N`; Android `versionCode` defaults to the same `N`.
- OTA/web uses `X.Y.Z`; the old fourth public digit is not shown or compared.
- `build_versions` stores accepted production build rows (`version_type_id='build'`) and a separate APK row (`version_type_id='apk'`).
- APK reset affects only the APK line: after reset there is one APK row, `version_type_id='apk', version=1`; existing `build` rows remain.
- Accepted production promotion must create or reuse one `build_versions` build row before the workflow is considered complete.
- Each accepted build row must store Russian `short_changes`, `detailed_changes`, and `reason` from explicit preview/release-note metadata.
- Branch names, commits, domains, and deploy metadata belong in `build_version_refs` or `deployment_records`, not release-note text.
- Manual `release` and `canon` rows are disabled unless a future explicit requirement restores them.

Build and publish a release APK only when native Android code, Capacitor config, permissions, signing, manifest values, application id, SDK versions, icons, splash assets, native plugins, or native compatibility boundaries change.

## Release Page

`/releases/` shows only APK artifacts:

- Production: `Brai`, `brai-vN.apk`
- Dev artifact: `Brai Dev`, `brai-dev-vN.apk`
- Preview A-E: `Brai A`...`Brai E`, `brai-a-vN.apk`...`brai-e-vN.apk`

The Dev APK is an artifact only while the Dev environment is disabled; do not restore Dev deploy paths just to publish it.

## OTA Manifest

The mobile OTA manifest uses schema version 2:

- `otaVersion`: `X.Y.Z`
- `targetApkVersion`: `N`
- `publishedAt`
- `archiveUrl`
- `sha256`
- `sizeBytes`
- `entrypoint`
- `mandatory`

`minApkVersionCode` and `maxApkVersionCode` are retired. If `targetApkVersion` is greater than the installed native APK version, Android reports `apk_required` and the UI links to `/releases/`.

## Shipped APK Ledger Order

For an intentional APK release, resolve `N` from the APK ledger, build all required APK artifacts with `versionName=N` and `versionCode=N`, publish the APK files and release index, then record or reset the single APK ledger row as required by the runbook. Do not use a separate lock-protected `versionCode` allocator.

Release APK signing is env-only. Required variables:

- `BRAI_ANDROID_KEYSTORE_PATH`
- `BRAI_ANDROID_STORE_PASSWORD`
- `BRAI_ANDROID_KEY_ALIAS`
- `BRAI_ANDROID_KEY_PASSWORD`

Do not commit APKs, OTA bundles, release pages, keystores, signing passwords, or generated deploy output.
