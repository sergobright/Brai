# app-delivery Specification

## Purpose
TBD - created by archiving change migrate-to-next-capacitor-local-first. Update Purpose after archive.
## Requirements
### Requirement: Web deployment publishes Next.js static output
Bright OS SHALL publish the built Next.js web output to the existing `deploy/web` web root.

#### Scenario: Web assets are published
- **WHEN** the web app is published
- **THEN** `deploy/scripts/publish-web.sh` copies or synchronizes from the Next.js static output
- **AND** removed files are not left behind in `deploy/web`

#### Scenario: Web app calls the Bright OS API
- **WHEN** the deployed web app calls Bright OS API endpoints
- **THEN** it uses same-origin `/api/*` URLs
- **AND** the browser bundle does not include the Bright OS API Bearer token

### Requirement: Caddy route boundaries are preserved
Bright OS SHALL preserve the existing Caddy route boundaries for web, API proxy, direct API access, and protected releases.

#### Scenario: Web app is deployed
- **WHEN** `app.brightos.world` serves the migrated web app
- **THEN** `/api/*` remains routed to the Bright OS API before the web catch-all
- **AND** `/releases*` remains routed to the release/auth flow before the web catch-all
- **AND** application service ports remain localhost-only

### Requirement: Android release uses Capacitor APK artifacts
Bright OS SHALL publish Capacitor Android APK artifacts through the existing protected release flow after the migration.

#### Scenario: APK is published
- **WHEN** a Capacitor Android release APK is built
- **THEN** it is copied into `deploy/releases`
- **AND** the protected release page lists the current filename, version, platform, size, app update time, and APK publication time

### Requirement: APK updates are separated from web-only updates
Bright OS SHALL document which changes require an APK update and which may be delivered as web/OTA bundle updates.

#### Scenario: Web-only code changes
- **WHEN** a release changes only Next.js UI, TypeScript client logic, Tailwind styles, or local database migrations compatible with the existing native shell
- **THEN** the release does not require a new APK after a verified web/OTA update mechanism is available

#### Scenario: Native Android changes
- **WHEN** a release changes Android permissions, Capacitor plugins, native code, signing, manifest values, application id, SDK versions, icons, or splash screens
- **THEN** a new APK or AAB build is required

### Requirement: Mobile OTA bundles are published separately from browser web assets
Bright OS SHALL publish Android mobile OTA web bundles to a durable mobile update area separate from the clean-synchronized browser web root.

#### Scenario: Browser web assets are published
- **WHEN** `deploy/scripts/publish-web.sh` publishes browser web assets to `deploy/web`
- **THEN** previously published mobile OTA bundles remain available
- **AND** rollback history under the mobile update area is not deleted by browser web publication

#### Scenario: Mobile OTA bundle is published
- **WHEN** a mobile OTA bundle is published
- **THEN** it is stored under a versioned path
- **AND** the stable manifest references that versioned bundle archive

### Requirement: Mobile OTA manifest updates are atomic
Bright OS SHALL publish the mobile OTA manifest in a way that avoids clients observing a partially written manifest.

#### Scenario: Manifest is replaced
- **WHEN** a new mobile OTA bundle becomes the active update
- **THEN** the manifest is written to a temporary path or equivalent safe staging area
- **AND** the final manifest path is replaced atomically after the bundle archive is already available

### Requirement: Mobile OTA publication preserves rollback versions
Bright OS SHALL retain enough previous mobile OTA bundles to support rollback.

#### Scenario: New bundle is published
- **WHEN** a new mobile OTA bundle is published
- **THEN** at least 3 previous bundle versions remain available unless an explicit cleanup policy says otherwise
- **AND** cleanup does not remove the bundle currently referenced by the manifest

### Requirement: Delivery commands distinguish APK and web-layer releases
Bright OS SHALL keep release commands and documentation clear about whether a change is delivered by web OTA or APK.

#### Scenario: Web-layer release is prepared
- **WHEN** a release changes only OTA-eligible web-layer behavior
- **THEN** the release can publish a mobile OTA bundle without publishing a new APK

#### Scenario: Native release is prepared
- **WHEN** a release changes native Android behavior or native compatibility contracts
- **THEN** the release checklist requires a new APK build and publication

### Requirement: Web-layer client releases publish browser web and Android OTA together
Bright OS SHALL publish ordinary client web-layer releases to both the browser web root and Android OTA channel from the same static build.

#### Scenario: Web-layer client release is published
- **WHEN** a release changes only OTA-eligible client web-layer behavior
- **THEN** the release workflow builds one Next.js static output with the supported Bright OS Node runtime
- **AND** publishes that output to `deploy/web`
- **AND** publishes an Android OTA bundle from that same output to `deploy/mobile-update`
- **AND** does not require a new APK
- **AND** uses the same `X.Y.Z.S` version for browser web and Android OTA

### Requirement: Native Android changes publish release APK artifacts
Bright OS SHALL publish a release APK whenever a change crosses the native Android release boundary.

#### Scenario: Native Android release is required
- **WHEN** a release changes Android native code, Capacitor configuration, permissions, signing, manifest values, application id, SDK versions, native plugins, icons, splash assets, or the supported Node runtime used for native build tooling
- **THEN** the release workflow builds a release APK when required by the native boundary
- **AND** publishes the APK artifact to `deploy/releases`
- **AND** updates and verifies the release page metadata

### Requirement: Release versions use one build ledger
Bright OS SHALL track public release versions in the server SQLite `build_versions` table with type metadata from `version_types`.

`short_changes` and `detailed_changes` SHALL contain human-readable release notes about what changed in the product or delivery workflow.

`reason` SHALL describe the human reason for the change: the problem, risk, or product/workflow need that made the change necessary. Branch names, commit SHAs, target commits, domains, and similar audit metadata SHALL NOT be stored in `reason`; it belongs in `build_version_refs` or deployment records.

#### Scenario: Task branch is prepared
- **WHEN** a `codex/*` task branch is created or updated before acceptance
- **THEN** it does not write a `build_versions` row by itself
- **AND** defers the version ledger row until the task is accepted into `main`

#### Scenario: Accepted task lands in main
- **WHEN** a `codex/*` task branch is accepted and merged into `main`
- **THEN** the workflow increments only `Z` in `X.Y.Z.S`
- **AND** keeps `X`, `Y`, and `S` unchanged
- **AND** writes one `build_versions` row with all four numeric fields, the full version string, short changes, detailed changes, release time, reason, and `version_type_id = build`

#### Scenario: Main is deployed to production
- **WHEN** accepted `main` is deployed to production
- **THEN** the workflow increments only `Y` in `X.Y.Z.S`
- **AND** keeps `X`, `Z`, and `S` unchanged
- **AND** writes one `build_versions` row with all four numeric fields, the full version string, short changes, detailed changes, release time, reason, and `version_type_id = build`
- **AND** preserves the accepted task index, for example `0.0.10.1` becomes `0.1.10.1`

#### Scenario: APK release is prepared
- **WHEN** the project owner asks to make or publish an APK release
- **THEN** the workflow increments only `S` in `X.Y.Z.S`
- **AND** keeps `X`, `Y`, and `Z` unchanged
- **AND** writes one `build_versions` row with all four numeric fields, the full version string, short changes, detailed changes, release time, reason, and `version_type_id = apk`

#### Scenario: Separate web or OTA version is requested
- **WHEN** a request asks to publish or update only browser web, only OTA, or different browser web and Android OTA versions
- **THEN** the workflow stops before changing files or publishing artifacts
- **AND** reports that Bright OS forbids separate web/OTA versions until the versioning rules are explicitly changed

### Requirement: Delivery scripts do not depend on unsupported host Node
Bright OS delivery scripts SHALL select the supported Bright OS Node runtime before running JavaScript build or publication logic.

#### Scenario: Publish script is run from a clean shell
- **WHEN** a maintainer runs `npm run publish:client-web-layer`
- **THEN** the build, browser web publication, and Android OTA publication use the supported Bright OS Node runtime
- **AND** the workflow succeeds even when the host default `node` is unsupported

### Requirement: Retired timer and history URLs are not served
Bright OS SHALL not serve retired `/timer*` or `/history*` web app URLs after Timer is renamed to Focus and History is merged into Focus.

#### Scenario: Focus static route is served
- **WHEN** `app.brightos.world/focus` is requested
- **THEN** Caddy serves the static exported Focus route

#### Scenario: Timer URL is retired
- **WHEN** `app.brightos.world/timer` or a nested `/timer*` path is requested
- **THEN** Caddy returns 404
- **AND** it does not serve the app fallback

#### Scenario: History URL is retired
- **WHEN** `app.brightos.world/history` or a nested `/history*` path is requested
- **THEN** Caddy returns 404
- **AND** it does not serve the app fallback

### Requirement: Branch classes map to production and preview environments
Bright OS SHALL use one production environment and five preview environments.

#### Scenario: A branch is deployed
- **WHEN** `main` is deployed
- **THEN** it targets production at `app.brightos.world`
- **WHEN** a `codex/*` branch is deployed
- **THEN** it allocates or reuses one preview slot from `A` through `E`

### Requirement: Preview Android apps are separately installable
Bright OS SHALL provide non-production Android flavors for preview slots `A` through `E`.

#### Scenario: Non-production Android apps are built
- **WHEN** preview APKs are built
- **THEN** they use separate application ids, labels, icons, and OTA channels
- **AND** they can be installed side-by-side with production

### Requirement: Non-production APK builds use exact OTA compatibility
Bright OS SHALL keep Preview APK artifacts aligned with their OTA manifests through a monotonic technical Android `versionCode`.

#### Scenario: Native preview APK is published
- **WHEN** a `codex/*` branch changes the native Android boundary
- **THEN** the allocated preview slot APK is built with a new Android `versionCode`
- **AND** the preview release metadata records that APK file and `versionCode`

#### Scenario: Accepted native work reaches production
- **WHEN** native-boundary work is accepted into `main`
- **THEN** Preview A-E APKs are rebuilt from production source during slot release

### Requirement: Deployment metadata is recorded per environment
Bright OS SHALL record deployment metadata for production and preview environments.

#### Scenario: Branch deployment completes
- **WHEN** a branch deploy succeeds
- **THEN** the target environment database records environment, slot when applicable, branch, commit, domain, web/OTA version, APK version when applicable, deployment time, and reason
- **AND** preview metadata can be promoted directly into production through accepted branch flow
