# next-capacitor-client Delta

## ADDED Requirements

### Requirement: Engine exposes explicit human-readable update actions

The client SHALL describe discovery, web download, and APK download without user-facing OTA terminology.

#### Scenario: An update state is rendered
- **WHEN** Engine is idle, checking, available, downloading, ready, or requires an APK
- **THEN** its action text and icon match the current operation
- **AND** the latest successful check time appears beside the action
- **AND** user-visible Engine text contains no `OTA`

#### Scenario: Native APK bridge is unavailable
- **WHEN** an APK is required and `downloadApk()` is unavailable
- **THEN** the client opens the installed channel's direct public download URL externally

### Requirement: Navigation supports supplementary status indicators

Navigation controls SHALL accept an arbitrary supplementary React node positioned without changing control geometry.

#### Scenario: A navigation item has an indicator
- **WHEN** an item supplies supplementary content without a position override
- **THEN** it is absolutely positioned at the bottom-right
- **AND** the control retains its original layout dimensions

#### Scenario: Engine has any update
- **WHEN** a web or APK update is available
- **THEN** desktop and mobile Engine icons change from processor to download
- **AND** a small yellow indicator appears at bottom-right
- **AND** the download icon animates during downloads unless reduced motion is preferred

#### Scenario: A hidden mobile item has an indicator
- **WHEN** Engine in the mobile overflow menu has an update
- **THEN** the three-dot button displays an aggregate yellow indicator at bottom-center
- **AND** the three-dot icon does not move
