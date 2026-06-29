## ADDED Requirements

### Requirement: Non-production APK builds use exact OTA compatibility
Bright OS SHALL keep Dev and Preview APK artifacts aligned with their OTA manifests through a monotonic technical Android `versionCode`.

#### Scenario: Native preview APK is published
- **WHEN** a `codex/*` branch changes the native Android boundary
- **THEN** the allocated preview slot APK is built with a new Android `versionCode`
- **AND** the preview release metadata records that APK file and `versionCode`

#### Scenario: Accepted native work reaches dev
- **WHEN** native-boundary work is accepted into `dev`
- **THEN** Dev and Preview A-E APKs are rebuilt from the accepted `dev` source
