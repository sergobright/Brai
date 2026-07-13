# android-web-ota-updates Specification

## Purpose
TBD - created by archiving change enable-android-web-ota-updates. Update Purpose after archive.
## Requirements
### Requirement: Android APK includes an offline fallback web layer
Brai Android SHALL include a bundled fallback web layer inside every APK that can start without network access.

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
Brai Android SHALL discover mobile web-layer updates from a self-hosted update manifest.

#### Scenario: Manifest is requested
- **WHEN** the Android app has network access and performs an update check
- **THEN** it requests the configured self-hosted manifest URL
- **AND** the production default is `https://app.brai.one/mobile-update/manifest.json`

#### Scenario: Manifest describes a bundle
- **WHEN** the manifest is valid
- **THEN** it includes `schemaVersion`, `otaVersion`, `targetApkVersion`, `publishedAt`, `archiveUrl`, `sha256`, `sizeBytes`, `entrypoint`, and `mandatory`
- **AND** it may include `targetApkReleaseKey`, `targetApkBuildKind`, `targetApkPreviewIteration`, and `targetApkVersionCode` for APK line compatibility
- **AND** `otaVersion` uses the same `X.Y.Z` version as the browser web release

#### Scenario: Non-production manifest is published
- **WHEN** a Preview mobile OTA manifest is published
- **THEN** its `otaVersion` is an `X.Y.Z` value
- **AND** deploy identity may exist only in metadata or archive paths, not as a fourth public version digit

### Requirement: Android applies only compatible OTA bundles
Brai Android SHALL apply only OTA bundles compatible with the installed APK.

OTA manifests SHALL keep backward-compatible numeric `targetApkVersion` checks and SHALL use APK release key, build kind, stable `N`, and preview iteration `M` when those fields are present.

#### Scenario: Bundle requires newer APK
- **WHEN** the manifest `targetApkVersion` is greater than the installed native APK version
- **THEN** the app skips the bundle
- **AND** records the update as `apk_required`
- **AND** shows an APK update action that links to the release page

#### Scenario: Preview APK does not match
- **WHEN** a Preview Android app checks an OTA manifest
- **AND** the manifest was published for a native-boundary change
- **AND** the installed APK release key, build kind, stable `N`, or preview `M` does not satisfy the manifest target
- **THEN** the bundle is skipped as `apk_required`
- **AND** the app blocks normal Preview use with an APK update screen

#### Scenario: Web-only Preview update is published
- **WHEN** a Preview mobile OTA manifest is published for a web-only change
- **AND** the installed Preview APK is compatible with the existing native bridge
- **THEN** the manifest keeps `targetApkVersion` at the current compatible APK version
- **AND** the app may download and activate the web bundle without installing a new APK

### Requirement: Android verifies OTA bundle integrity before activation
Brai Android SHALL verify downloaded OTA bundles before extracting or activating them.

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
Brai Android SHALL promote a downloaded OTA bundle to stable only after the web layer confirms successful startup.

#### Scenario: Candidate is downloaded while app is visible
- **WHEN** the app downloads a compatible OTA bundle after the current web layer is already visible
- **THEN** the app keeps the current web layer loaded for the rest of the current startup session
- **AND** stores the downloaded bundle as a candidate for the next app startup
- **AND** does not hot-swap the visible WebView to the candidate bundle

#### Scenario: Candidate reports ready
- **WHEN** the app loads a candidate bundle
- **AND** the web layer sends a readiness signal for the same `otaVersion`
- **THEN** the app promotes the candidate to the stable bundle

#### Scenario: Candidate does not report ready
- **WHEN** the app loads a candidate bundle
- **AND** the readiness signal is not received before the configured timeout
- **THEN** the app marks the candidate as failed
- **AND** rolls back to the previous stable bundle or APK fallback

### Requirement: Android rolls back failed OTA updates
Brai Android SHALL preserve a working startup path when OTA update activation fails.

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
Brai SHALL reserve OTA updates for web-layer changes compatible with the installed native shell.

#### Scenario: Web-only change is released
- **WHEN** a release changes UI, Russian copy, styles, client-side logic, ordinary static pages, or web-layer static assets
- **AND** the change is compatible with the installed native bridge and API contract
- **THEN** the change may ship through the mobile OTA bundle channel

#### Scenario: Native change is released
- **WHEN** a release changes Capacitor plugins, Android permissions, `AndroidManifest.xml`, Kotlin or Java code, application id, signing, APK version, SDK versions, icons, splash screen, deep links, notification channels, or native bridge contracts
- **THEN** the release requires a new APK

#### Scenario: Native-boundary change is published
- **WHEN** a change crosses the native Android boundary
- **THEN** the Preview OTA manifest requires the newly published APK through target APK release key, build kind, stable `N`, and preview `M`

### Requirement: OTA update failures are non-blocking for normal startup
Brai Android SHALL continue to start from a known-good local web layer when OTA update checks or downloads fail.

#### Scenario: Manifest is unavailable
- **WHEN** the manifest request fails
- **THEN** the app starts from the current stable local bundle or APK fallback
- **AND** records the update check failure for diagnostics

#### Scenario: Download fails
- **WHEN** a compatible bundle download fails
- **THEN** the app keeps using the current stable local bundle or APK fallback
- **AND** retries only according to normal update retry policy

### Requirement: OTA state is inspectable for verification
Brai Android SHALL expose enough update state for release verification and troubleshooting without exposing secrets.

#### Scenario: Maintainer checks installed update state
- **WHEN** a maintainer verifies an Android OTA release
- **THEN** the app or logs can identify the active bundle version, fallback version, last check status, and last non-secret update error
- **AND** no private tokens, passwords, keys, or hashes are exposed

### Requirement: Android update discovery does not download content

Brai Android SHALL separate update discovery from user-initiated download operations.

#### Scenario: Background update check finds a compatible bundle
- **WHEN** startup, periodic, or Brai CMD logic calls `checkForUpdates()`
- **THEN** Android validates the manifest and exposes the available version
- **AND** it does not download or extract the archive

#### Scenario: User downloads a discovered web update
- **WHEN** a compatible update is available and the user calls `downloadUpdate()`
- **THEN** Android downloads, verifies, and stages the archive using the existing candidate pipeline
- **AND** state identifies the active operation and download result

### Requirement: Android can download its channel APK

Brai Android SHALL queue the installed channel APK through the system DownloadManager.

#### Scenario: Preview B requests an APK
- **WHEN** an installed Preview B app calls `downloadApk()`
- **THEN** it downloads from the public endpoint for release key `b`
- **AND** saves the APK in system Downloads with a visible system notification

#### Scenario: APK download is already active
- **WHEN** `downloadApk()` is called while the tracked APK request is active
- **THEN** Android does not enqueue a duplicate
- **AND** bridge state remains `downloading`

#### Scenario: APK download finishes
- **WHEN** DownloadManager reports the tracked request completed or failed
- **THEN** bridge state reports `downloaded` or `failed`
- **AND** retains only non-secret diagnostic error information
