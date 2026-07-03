# self-hosted-distribution Specification

## Purpose
TBD - created by archiving change migrate-to-next-capacitor-local-first. Update Purpose after archive.
## Requirements
### Requirement: Source does not contain private credentials
Brai source SHALL NOT contain plaintext tokens, passwords, private keys, password hashes, or private deployment credentials.

#### Scenario: Android artifact needs authorization
- **WHEN** an Android artifact requires private API authorization for a private release
- **THEN** the credential comes from an external non-committed build input
- **AND** the credential value is not printed, committed, or documented

### Requirement: Android release signing is env-only
Brai release APK signing SHALL use signing material supplied outside the repository.

#### Scenario: Release APK is built
- **WHEN** a release APK build runs
- **THEN** the keystore path, store password, key alias, and key password come from environment variables
- **AND** no debug keystore path, debug alias, signing password fallback, keystore file, or signing secret is committed

### Requirement: Store distribution remains policy-aware
Brai SHALL keep future app-store distribution compatible with a self-hosted open-source productivity app model.

#### Scenario: Store-ready Android build is prepared
- **WHEN** a Google Play or equivalent store build is prepared
- **THEN** native code updates, permissions, signing, version codes, data disclosures, and app description are reviewed before submission
- **AND** web/OTA updates are limited to behavior consistent with the disclosed app purpose and store policies

### Requirement: Open-source dependency and service choices are explicit
Brai SHALL distinguish open-source/self-hostable dependencies from managed proprietary services in architecture decisions.

#### Scenario: OTA update mechanism is selected
- **WHEN** an Android web-bundle update mechanism is chosen
- **THEN** the decision records whether the mechanism is open-source/self-hostable or a managed service
- **AND** records any operational trade-offs before relying on it for releases

### Requirement: Client uses deployment-controlled server configuration
Brai SHALL select its API base URL from deployment/runtime configuration rather than exposing an in-app user-editable server URL setting.

#### Scenario: Production web deployment runs
- **WHEN** the client runs as the `app.brightos.world` web app
- **THEN** it uses same-origin `/api/*`
- **AND** Brai API authorizes data requests using session cookies or explicit Bearer auth without exposing private tokens in the browser bundle

#### Scenario: Production Android app runs
- **WHEN** the client runs inside the production Android shell
- **THEN** it uses the configured production API endpoint
- **AND** the Settings screen does not expose a server URL editor

### Requirement: Android web OTA updates are self-hosted
Brai SHALL host Android web-layer OTA updates on the configured Brai server rather than requiring a managed third-party OTA service.

#### Scenario: Production app checks for updates
- **WHEN** the production Android app checks for web-layer updates
- **THEN** it uses the Brai self-hosted update manifest under `app.brightos.world`
- **AND** does not require a proprietary OTA service account

#### Scenario: Self-hosted deployment is configured
- **WHEN** a self-hosted Brai deployment configures its own app server
- **THEN** Android update checks can target that deployment's configured update manifest
- **AND** update credentials are not committed to source control

### Requirement: OTA update artifacts do not contain private credentials
Brai SHALL keep private credentials out of OTA manifests, bundle archives, and committed update metadata.

#### Scenario: OTA bundle is built
- **WHEN** a mobile OTA bundle is generated
- **THEN** it does not include plaintext tokens, passwords, private keys, password hashes, or signing secrets

#### Scenario: OTA manifest is published
- **WHEN** the mobile OTA manifest is published
- **THEN** it contains only non-secret metadata needed for versioning, compatibility, integrity, and download

### Requirement: OTA mechanism choice is recorded before implementation
Brai SHALL record the selected self-hosted Android OTA mechanism before implementation proceeds.

#### Scenario: Updater implementation is selected
- **WHEN** maintainers choose between a vetted self-hostable Capacitor updater and a Brai native loader
- **THEN** the design records the selected mechanism
- **AND** records operational trade-offs, maintenance cost, rollback behavior, and security assumptions
