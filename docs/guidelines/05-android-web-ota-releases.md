# Android, Web, OTA, And Releases

Brai keeps completed work, APK releases, and OTA/web artifacts as separate version lines.

- APK uses the public integer counter `vN`; the current public baseline is `v2`.
- Android `versionName` is `N`; Android `versionCode` defaults to the same `N`.
- Native-boundary preview builds reserve the next stable `N` for the task branch and use a branch-local preview iteration `M`; their Android `versionCode` is `N * 10000 + M`.
- Preview `M` is committed only after the preview deploy is fully ready; failed builds and failed deploys retry the same `M`.
- Preview APK filenames are slot-specific `brai-a-vN-previewM.apk` through `brai-e-vN-previewM.apk`; accepted stable filenames remain `brai-vN.apk`, `brai-dev-vN.apk`, and `brai-a-vN.apk` through `brai-e-vN.apk`.
- Preview APKs are transient separate applications from the stable Preview A-E baseline, so rejected preview APKs cannot update into accepted stable APKs.
- OTA/web uses `X.Y.Z`; the old fourth public digit is not shown or compared.
- `build_versions` stores one completed-work row per finalized release work (`version_type_id='build'`) and independent published platform rows such as `version_type_id='apk'`.
- APK reset affects only the APK line: after reset APK rows `version_type_id='apk', version IN (1, 2)` remain, APK rows above `2` are deleted, and existing `build` rows remain.
- Owner finalization must create or reuse exactly one build row after every registered owner/support PR reaches a terminal state. Merged support PRs join that build; a support merge never creates its own build.
- A build records completed product, server, CI/CD, infrastructure, documentation, maintenance, or refactoring work even when no client artifact was published.
- Creating a build does not advance browser web or Android OTA `X.Y.Z`; those versions advance only with their published artifacts.
- Production clients receive the latest Product ref on the deployed `main` commit's first-parent ancestry. Preview clients receive only the Product version linked to the branch's frozen accepted base commit. Exact current-commit history refs take precedence; the newest Product row returned by the API is never treated as installed merely because it is newest.
- Every build and platform version stores Russian `short_changes`, `detailed_changes`, and `reason` plus at least one normalized atomic detail from structured release metadata. The parent `detailed_changes` briefly summarizes all details and must not duplicate one detail verbatim. Each `--detail <title>::<description>` records one independent change with its own meaningful title and description; agents must pass every detail explicitly, must not combine unrelated changes in one entry, and must not use automatic titles such as `— 1`.
- Branch names, commits, domains, and deploy metadata belong in `build_version_refs` or `deployment_records`, not release-note text.
- Manual `release` and `canon` rows are disabled unless a future explicit requirement restores them.

Build and publish a release APK only when native Android code, Capacitor config, permissions, signing, manifest values, application id, SDK versions, icons, splash assets, native plugins, or native compatibility boundaries change. An APK row is created only after that stable artifact is published and contains only native-relevant PRs and platform release notes. Changes to APK build/deploy orchestration scripts alone do not require a new APK unless they are paired with a real native-boundary input change or an explicitly forced native APK deploy.

## Release Page

`/releases/` is permanently public and always shows the current Production APK so a user without an installed app can install Brai. Every accepted stable APK refreshes this page and download. `/dev-releases/` uses the existing release password/session and shows all APK artifacts:

- Production: `Brai`, `brai-vN.apk`
- Dev: `Brai Dev`, `brai-dev-vN.apk`
- Preview A-E: `Brai A`...`Brai E`, `brai-a-vN.apk`...`brai-e-vN.apk`
- Active native preview work temporarily replaces its slot card with `Preview A`...`Preview E` and the active slot-specific `brai-<slot>-vN-previewM.apk` artifact.

The Dev APK belongs to the persistent protected Dev environment on `dev.brai.one`. Dev deploys use the long-lived Supabase `brai-dev` branch and must keep APK, OTA/web, API, and version ledger in sync.

The production API renders `/releases/` from the shared `releases.json` with the renderer shipped in the production source. APK publishers still refresh the static `index.html` compatibility artifact, but a preview branch's older renderer must not determine the page served to users.

Installed apps download their exact channel from public `GET /releases/download/:releaseKey`, where the key is `production`, `dev`, or `a` through `e`. The current Production filename remains public under `/releases/<filename>` for legacy clients; other filename requests there return `404`. APK streams are limited to 10 starts per derived IP per 3600 seconds in one API process. The API trusts Caddy `X-Forwarded-For` only for a loopback socket peer; otherwise it uses the peer address.

Direct APK responses include the release-index SHA-256. Android downloads the file into app-private `files/updates`, reports actual byte progress, verifies length and SHA-256, and opens the system package installer through FileProvider. A verified candidate remains available for an `Install` retry and is deleted after the updated version starts; partial and stale files are pruned. Do not use DownloadManager for the in-app APK action.

Caddy must route `/releases*` and `/dev-releases*` to the matching API for Production, Dev, and Preview A-E. Preview and Dev env generation must copy `BRAI_RELEASE_PASSWORD` from the production API env so the standard release password is identical everywhere; never copy or document the password value.

## OTA Manifest

The mobile OTA manifest uses schema version 2:

- `otaVersion`: `X.Y.Z`
- `targetApkVersion`: `N`
- optional `targetApkReleaseKey`: `production`, `dev`, or `a` through `e`
- optional `targetApkBuildKind`: `stable` or `preview`
- optional `targetApkPreviewIteration`: `M` for preview targets, `0` or absent for stable targets
- optional `targetApkVersionCode`: Android versionCode for the required APK
- `publishedAt`
- `archiveUrl`
- `sha256`
- `sizeBytes`
- `entrypoint`
- `mandatory`

`minApkVersionCode` and `maxApkVersionCode` are retired. Old manifests use numeric `targetApkVersion`; new manifests compare release key, build kind, stable `N`, and preview `M`. Incompatible APKs report `apk_required` and the UI downloads the installed release key from the public direct endpoint. Clients without the native APK download method open that endpoint in the external browser.

Automatic Android checks at startup, on the periodic timer, and from Brai CMD only discover and validate manifest availability. They never download the archive. A user action calls `downloadUpdate()` for a compatible web bundle or `downloadApk()` for a native-boundary release; APK downloads use the app-private, checksummed flow described above and expose a retryable installer action.

## Shipped APK Ledger Order

For an accepted APK release, resolve `N` from the APK ledger, build all required stable APK artifacts with `versionName=N` and `versionCode=N`, publish the APK files and release index, then record or reset the single APK ledger row as required by the runbook. Preview `M` is only a registry counter for transient branch APKs.

Release APK signing is env-only. Required variables:

- `BRAI_ANDROID_KEYSTORE_PATH`
- `BRAI_ANDROID_STORE_PASSWORD`
- `BRAI_ANDROID_KEY_ALIAS`
- `BRAI_ANDROID_KEY_PASSWORD`

Do not commit APKs, OTA bundles, release pages, keystores, signing passwords, or generated deploy output.
