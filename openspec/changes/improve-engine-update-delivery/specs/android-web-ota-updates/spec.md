# android-web-ota-updates Delta

## ADDED Requirements

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
