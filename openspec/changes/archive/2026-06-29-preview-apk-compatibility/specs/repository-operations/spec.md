## MODIFIED Requirements

### Requirement: Task branches deploy through preview slots
Native-boundary preview branches SHALL publish a slot-specific APK before handoff, and accepted native work SHALL rebuild the shared Dev and Preview A-E APK baseline from `dev`.

#### Scenario: Native preview branch is handed off
- **WHEN** a `codex/*` branch changes native Android behavior
- **THEN** the handoff includes the preview APK link and Android `versionCode`

#### Scenario: Native preview branch is accepted
- **WHEN** a native preview branch is merged into `dev`
- **THEN** the shared non-production APK baseline is rebuilt from `dev`
