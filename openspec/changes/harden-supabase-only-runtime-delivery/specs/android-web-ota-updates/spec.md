## ADDED Requirements

### Requirement: Android backup excludes private Brai state
Brai Android SHALL prevent Android platform backup from exporting private app
state such as Brai Cmd bearer tokens.

#### Scenario: Android manifest is packaged
- **WHEN** the Android app manifest is inspected
- **THEN** platform backup is disabled or an equivalent backup policy excludes private shared preferences and credential state
