# Android, Web, OTA, And Releases

Bright OS uses public version format `X.Y.Z.S`.

- Current public baseline: `0.0.1.1`.
- `X` is reserved for explicit major product epochs.
- Promotion from `dev` to `main` increments `Y`.
- Accepted task merges into `dev` increment `Z`.
- APK releases increment `S`.
- Browser web and Android OTA use the same public version.
- Android `versionCode` is technical install metadata; baseline is `1`.

Version ledger rules:

- The baseline contains two `build_versions` rows: `build` and `apk`, both at `0.0.1.1`.
- A task branch does not create a version ledger row by itself.
- An accepted task merge into `dev` increments `Z` and writes one `build` row.
- On `dev`, `Z` must match the accepted GitHub PR number and the count of `build_versions` rows with `version_type_id = 'build'`.
- A promotion from `dev` to `main` increments `Y` and writes one `build` row.
- A task that requires a shipped APK release increments `S` and writes one `apk` row.
- Do not reuse `0.0.1.1` after the public baseline.
- Example: after 10 accepted tasks in `dev`, version is `0.0.10.1`; promoting that `dev` to `main` makes it `0.1.10.1`.

Use one build for ordinary web-layer publication:

```bash
npm run publish:client-web-layer
```

Build and publish a release APK only when native Android code, Capacitor config, permissions, signing, manifest values, application id, SDK versions, icons, splash assets, native plugins, or native compatibility boundaries change.

Release APK signing is env-only. Required variables:

- `BRIGHT_OS_ANDROID_KEYSTORE_PATH`
- `BRIGHT_OS_ANDROID_STORE_PASSWORD`
- `BRIGHT_OS_ANDROID_KEY_ALIAS`
- `BRIGHT_OS_ANDROID_KEY_PASSWORD`

Do not commit APKs, OTA bundles, release pages, keystores, signing passwords, or generated deploy output.
