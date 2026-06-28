# android-web-ota-updates Specification

## Purpose
TBD - created by archiving change enable-android-web-ota-updates. Update Purpose after archive.
## Requirements
### Requirement: Android APK includes an offline fallback web layer
Bright OS Android SHALL include a bundled fallback web layer inside every APK that can start without network access.

#### Scenario: App starts without OTA bundle
- **WHEN** the Android app starts and no verified OTA bundle is stored locally
- **THEN** the app loads the bundled APK fallback web layer
- **AND** the app does not require internet access to render the fallback UI

#### Scenario: App starts without internet
- **WHEN** the Android app starts without network access
- **AND** a verified local OTA bundle exists
- **THEN** the app loads the verified local OTA bundle
- **AND** does not block startup on manifest or bundle download

### Requirement: Android uses a self-hosted update manifest
Bright OS Android SHALL discover mobile web-layer updates from a self-hosted update manifest.

#### Scenario: Manifest is requested
- **WHEN** the Android app has network access and performs an update check
- **THEN** it requests the configured self-hosted manifest URL
- **AND** the production default is `https://app.brightos.world/mobile-update/manifest.json`

#### Scenario: Manifest describes a bundle
- **WHEN** the manifest is valid
- **THEN** it includes `schemaVersion`, `channel`, `bundleVersion`, `publishedAt`, `archiveUrl`, `sha256`, `sizeBytes`, `entrypoint`, `minApkVersionCode`, and `mandatory`
- **AND** it may include `maxApkVersionCode`
- **AND** `bundleVersion` uses the same `X.Y.Z.S` version as the browser web release, without a separate OTA suffix

#### Scenario: Non-production manifest is published
- **WHEN** a Preview mobile OTA manifest is published
- **THEN** its `bundleVersion` starts with the accepted public `X.Y.Z.S` version
- **AND** it may include a non-production suffix for deploy identity

### Requirement: Android applies only compatible OTA bundles
Bright OS Android SHALL apply only OTA bundles compatible with the installed APK.

Native-boundary Preview OTA manifests SHALL require exact Android `versionCode` compatibility by setting both `minApkVersionCode` and `maxApkVersionCode` to the required technical APK code. Web-only Preview OTA manifests SHALL NOT force a new APK when the installed native shell is still compatible.

#### Scenario: Bundle requires newer APK
- **WHEN** the manifest `minApkVersionCode` is greater than the installed Android `versionCode`
- **THEN** the app skips the bundle
- **AND** continues using the current stable local bundle or APK fallback

#### Scenario: Bundle excludes installed APK
- **WHEN** the manifest sets `maxApkVersionCode`
- **AND** the installed Android `versionCode` is greater than `maxApkVersionCode`
- **THEN** the app skips the bundle
- **AND** records the update as incompatible for diagnostics

#### Scenario: Preview APK does not match
- **WHEN** a Preview Android app checks an OTA manifest
- **AND** the manifest was published for a native-boundary change
- **AND** the installed Android `versionCode` is lower or higher than the manifest requirement
- **THEN** the bundle is skipped as incompatible
- **AND** the app blocks normal Preview use with an APK update screen

#### Scenario: Web-only Preview update is published
- **WHEN** a Preview mobile OTA manifest is published for a web-only change
- **AND** the installed Preview APK is compatible with the existing native bridge
- **THEN** the manifest does not set an exact APK `versionCode` gate
- **AND** the app may download and activate the web bundle without installing a new APK

### Requirement: Android verifies OTA bundle integrity before activation
Bright OS Android SHALL verify downloaded OTA bundles before extracting or activating them.

#### Scenario: Archive checksum matches
- **WHEN** the app downloads a bundle archive
- **AND** the archive SHA-256 matches the manifest `sha256`
- **THEN** the app may extract the archive into the candidate bundle area

#### Scenario: Archive checksum fails
- **WHEN** the app downloads a bundle archive
- **AND** the archive SHA-256 does not match the manifest `sha256`
- **THEN** the app rejects the archive
- **AND** does not activate or retain it as a stable bundle

#### Scenario: Archive entry is unsafe
- **WHEN** an archive entry would extract outside the intended bundle directory
- **THEN** the app rejects the archive
- **AND** does not activate the bundle

### Requirement: Candidate bundles require successful startup confirmation
Bright OS Android SHALL promote a downloaded OTA bundle to stable only after the web layer confirms successful startup.

#### Scenario: Candidate is downloaded while app is visible
- **WHEN** the app downloads a compatible OTA bundle after the current web layer is already visible
- **THEN** the app keeps the current web layer loaded for the rest of the current startup session
- **AND** stores the downloaded bundle as a candidate for the next app startup
- **AND** does not hot-swap the visible WebView to the candidate bundle

#### Scenario: Candidate reports ready
- **WHEN** the app loads a candidate bundle
- **AND** the web layer sends a readiness signal for the same `bundleVersion`
- **THEN** the app promotes the candidate to the stable bundle

#### Scenario: Candidate does not report ready
- **WHEN** the app loads a candidate bundle
- **AND** the readiness signal is not received before the configured timeout
- **THEN** the app marks the candidate as failed
- **AND** rolls back to the previous stable bundle or APK fallback

### Requirement: Android rolls back failed OTA updates
Bright OS Android SHALL preserve a working startup path when OTA update activation fails.

#### Scenario: Previous stable bundle exists
- **WHEN** a candidate bundle fails activation
- **AND** a previous stable OTA bundle exists
- **THEN** the app loads the previous stable OTA bundle

#### Scenario: No previous stable bundle exists
- **WHEN** a candidate bundle fails activation
- **AND** no previous stable OTA bundle exists
- **THEN** the app loads the bundled APK fallback

#### Scenario: Same bundle failed before
- **WHEN** a bundle version is already marked as failed
- **THEN** the app does not repeatedly activate that failed bundle in a startup loop

### Requirement: OTA updates are limited to the web layer
Bright OS SHALL reserve OTA updates for web-layer changes compatible with the installed native shell.

#### Scenario: Web-only change is released
- **WHEN** a release changes UI, Russian copy, styles, client-side logic, ordinary static pages, or web-layer static assets
- **AND** the change is compatible with the installed native bridge and API contract
- **THEN** the change may ship through the mobile OTA bundle channel

#### Scenario: Native change is released
- **WHEN** a release changes Capacitor plugins, Android permissions, `AndroidManifest.xml`, Kotlin or Java code, application id, signing, `versionCode`, SDK versions, icons, splash screen, deep links, notification channels, or native bridge contracts
- **THEN** the release requires a new APK

#### Scenario: Native-boundary change is published
- **WHEN** a change crosses the native Android boundary
- **THEN** the Dev or Preview OTA manifest requires the newly published APK `versionCode`

### Requirement: OTA update failures are non-blocking for normal startup
Bright OS Android SHALL continue to start from a known-good local web layer when OTA update checks or downloads fail.

#### Scenario: Manifest is unavailable
- **WHEN** the manifest request fails
- **THEN** the app starts from the current stable local bundle or APK fallback
- **AND** records the update check failure for diagnostics

#### Scenario: Download fails
- **WHEN** a compatible bundle download fails
- **THEN** the app keeps using the current stable local bundle or APK fallback
- **AND** retries only according to normal update retry policy

### Requirement: OTA state is inspectable for verification
Bright OS Android SHALL expose enough update state for release verification and troubleshooting without exposing secrets.

#### Scenario: Maintainer checks installed update state
- **WHEN** a maintainer verifies an Android OTA release
- **THEN** the app or logs can identify the active bundle version, fallback version, last check status, and last non-secret update error
- **AND** no private tokens, passwords, keys, or hashes are exposed
