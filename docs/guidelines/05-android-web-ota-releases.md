# Android, Web, OTA, And Releases

Bright OS uses public version format `X.Y.Z.S`.

- Current public baseline: `0.0.1.1`.
- `X` is reserved for explicit major product epochs.
- Production releases increment `Y`.
- Accepted task merges into `main` increment `Z`.
- APK releases increment `S`.
- Browser web and Android OTA use the same public version.
- Android `versionCode` is technical install metadata; baseline is `1`.

Version ledger rules:

- The baseline contains two `build_versions` rows: `build` and `apk`, both at `0.0.1.1`.
- A task branch does not create a version ledger row by itself.
- An accepted working-branch merge into `main` increments `Z` and writes one detailed `build` row with `release_version = 0`.
- `Z` is the accepted build sequence in `build_versions`; GitHub PR numbers are review metadata and must not define version numbers.
- Production deploy increments `Y` and writes one detailed production `build` row with `release_version = Y`, `build_version = latest included Z`, and references to the accepted build rows included since the previous production release.
- A task that requires a shipped APK release increments `S` and writes one `apk` row.
- `short_changes` and `detailed_changes` are release notes for humans: what changed and why it matters.
- `reason` is the human reason for the change: the problem, risk, or product/workflow need that made the change necessary. Do not put branch names, commit SHAs, domains, or target/source movement in `reason`.
- Branch names, commit SHAs, domains, and target/source metadata belong in `build_version_refs` or `deployment_records`, not in the visible change/reason text.
- Do not reuse `0.0.1.1` after the public baseline.
- Example: after 10 accepted tasks, the accepted build is `0.0.10.1`; the first production release of that accepted state writes `0.1.10.1`.

Use one build for ordinary web-layer publication:

```bash
npm run publish:client-web-layer
```

Build and publish a release APK only when native Android code, Capacitor config, permissions, signing, manifest values, application id, SDK versions, icons, splash assets, native plugins, or native compatibility boundaries change.

Preview OTA manifests use exact Android `versionCode` compatibility. Web-only changes keep using OTA without an APK rebuild. Native-boundary changes build a new APK for the target environment, and accepted native work rebuilds the shared Preview A-E APK baseline from production source during slot release.

Preview slot status records branch-specific APK file and `versionCode` when a `codex/*` native preview publishes a slot APK. Releasing a slot with a branch-specific APK rebuilds that slot's baseline APK from production source before freeing the slot.

Release APK signing is env-only. Required variables:

- `BRIGHT_OS_ANDROID_KEYSTORE_PATH`
- `BRIGHT_OS_ANDROID_STORE_PASSWORD`
- `BRIGHT_OS_ANDROID_KEY_ALIAS`
- `BRIGHT_OS_ANDROID_KEY_PASSWORD`

Do not commit APKs, OTA bundles, release pages, keystores, signing passwords, or generated deploy output.
