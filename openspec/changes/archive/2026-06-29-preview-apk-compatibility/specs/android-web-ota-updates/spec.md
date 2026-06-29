## MODIFIED Requirements

### Requirement: Android uses a self-hosted update manifest
Production `bundleVersion` SHALL stay on public `X.Y.Z.S`; non-production bundle versions SHALL start with accepted `X.Y.Z.S` and may add preview/build suffixes.

#### Scenario: Non-production manifest is published
- **WHEN** a Dev or Preview mobile OTA manifest is published
- **THEN** its `bundleVersion` starts with the accepted public `X.Y.Z.S` version
- **AND** it may include a non-production suffix for deploy identity

### Requirement: Android applies only compatible OTA bundles
Dev and Preview OTA manifests SHALL require exact Android `versionCode` compatibility by setting both `minApkVersionCode` and `maxApkVersionCode` to the required technical APK code.

#### Scenario: Dev or Preview APK does not match
- **WHEN** a Dev or Preview Android app checks an OTA manifest
- **AND** the installed Android `versionCode` is lower or higher than the manifest requirement
- **THEN** the bundle is skipped as incompatible
- **AND** the app blocks normal Dev/Preview use with an APK update screen

### Requirement: OTA updates are limited to the web layer
Native-boundary changes SHALL require a new APK and SHALL make Dev/Preview OTA manifests require that APK exactly.

#### Scenario: Native-boundary change is published
- **WHEN** a change crosses the native Android boundary
- **THEN** the Dev or Preview OTA manifest requires the newly published APK `versionCode`
