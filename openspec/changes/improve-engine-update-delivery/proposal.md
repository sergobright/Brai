# Engine update delivery

## Why

Engine currently treats update discovery as a download, hides native APK updates behind a protected release catalogue, and gives users no persistent navigation signal that an update is waiting. This makes routine updates unclear and prevents the app from safely offering the APK for its installed channel.

## What Changes

- Separate Android update discovery from explicit web-bundle and APK downloads.
- Publish a production-only release page and channel-specific public APK download contract while retaining the protected all-channel developer catalogue.
- Rate-limit APK download starts per client IP and log download outcomes.
- Add human-readable Engine update states and a reusable navigation indicator, including the mobile overflow aggregate indicator.
- Require a new APK because the native bridge and Android `DownloadManager` integration change.

## Capabilities

### Modified capabilities

- `android-web-ota-updates`: discovery becomes read-only and downloads become explicit native operations.
- `app-delivery`: release catalogue visibility and the direct APK download contract are split and rate-limited.
- `next-capacitor-client`: Engine update controls and reusable navigation indicators expose the new states.

## Impact

- API release routes, renderer, Caddy routing, runtime logs, dependencies, and API tests.
- Capacitor Android OTA manager/plugin, DownloadManager integration, bridge state, and native tests.
- Engine UI/model/hooks, desktop/mobile navigation, API types, accessibility, and component tests.
- Release documentation and native release workflow; existing installed APKs use the legacy release page for the one transition update.
