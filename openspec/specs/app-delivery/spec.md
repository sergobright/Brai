# app-delivery Specification

## Purpose
TBD - created by archiving change migrate-to-next-capacitor-local-first. Update Purpose after archive.
## Requirements
### Requirement: Web deployment publishes Next.js static output
Brai SHALL publish the built Next.js web output to the existing `deploy/web` web root.

#### Scenario: Web assets are published
- **WHEN** the web app is published
- **THEN** `deploy/scripts/publish-web.sh` copies or synchronizes from the Next.js static output
- **AND** removed files are not left behind in `deploy/web`

#### Scenario: Web app calls the Brai API
- **WHEN** the deployed web app calls Brai API endpoints
- **THEN** it uses same-origin `/api/*` URLs
- **AND** the browser bundle does not include the Brai API Bearer token

### Requirement: Caddy route boundaries are preserved
Brai SHALL preserve the existing Caddy route boundaries for web, API proxy, direct API access, and protected releases.

#### Scenario: Web app is deployed
- **WHEN** `app.brai.one` serves the migrated web app
- **THEN** `/api/*` remains routed to the Brai API before the web catch-all
- **AND** `/releases*` remains routed to the release/auth flow before the web catch-all
- **AND** application service ports remain localhost-only

### Requirement: Android release uses Capacitor APK artifacts
Brai SHALL publish Capacitor Android APK artifacts through the existing protected release flow after the migration.

#### Scenario: APK is published
- **WHEN** a Capacitor Android release APK is built
- **THEN** it is copied into `deploy/releases`
- **AND** the protected release page lists the current filename, version, platform, size, app update time, and APK publication time

### Requirement: APK updates are separated from web-only updates
Brai SHALL document which changes require an APK update and which may be delivered as web/OTA bundle updates.

#### Scenario: Web-only code changes
- **WHEN** a release changes only Next.js UI, TypeScript client logic, Tailwind styles, or local database migrations compatible with the existing native shell
- **THEN** the release does not require a new APK after a verified web/OTA update mechanism is available

#### Scenario: Native Android changes
- **WHEN** a release changes Android permissions, Capacitor plugins, native code, signing, manifest values, application id, SDK versions, icons, or splash screens
- **THEN** a new APK or AAB build is required

### Requirement: Mobile OTA bundles are published separately from browser web assets
Brai SHALL publish Android mobile OTA web bundles to a durable mobile update area separate from the clean-synchronized browser web root.

#### Scenario: Browser web assets are published
- **WHEN** `deploy/scripts/publish-web.sh` publishes browser web assets to `deploy/web`
- **THEN** previously published mobile OTA bundles remain available
- **AND** rollback history under the mobile update area is not deleted by browser web publication

#### Scenario: Mobile OTA bundle is published
- **WHEN** a mobile OTA bundle is published
- **THEN** it is stored under a versioned path
- **AND** the stable manifest references that versioned bundle archive

### Requirement: Mobile OTA manifest updates are atomic
Brai SHALL publish the mobile OTA manifest in a way that avoids clients observing a partially written manifest.

#### Scenario: Manifest is replaced
- **WHEN** a new mobile OTA bundle becomes the active update
- **THEN** the manifest is written to a temporary path or equivalent safe staging area
- **AND** the final manifest path is replaced atomically after the bundle archive is already available

### Requirement: Mobile OTA publication preserves rollback versions
Brai SHALL retain enough previous mobile OTA bundles to support rollback.

#### Scenario: New bundle is published
- **WHEN** a new mobile OTA bundle is published
- **THEN** at least 3 previous bundle versions remain available unless an explicit cleanup policy says otherwise
- **AND** cleanup does not remove the bundle currently referenced by the manifest

### Requirement: Delivery commands distinguish APK and web-layer releases
Brai SHALL keep release commands and documentation clear about whether a change is delivered by web OTA or APK.

#### Scenario: Web-layer release is prepared
- **WHEN** a release changes only OTA-eligible web-layer behavior
- **THEN** the release can publish a mobile OTA bundle without publishing a new APK

#### Scenario: Native release is prepared
- **WHEN** a release changes native Android behavior or native compatibility contracts
- **THEN** the release checklist requires a new APK build and publication

### Requirement: Web-layer client releases publish browser web and Android OTA together
Brai SHALL publish ordinary client web-layer releases to both the browser web root and Android OTA channel from the same static build.

#### Scenario: Web-layer client release is published
- **WHEN** a release changes only OTA-eligible client web-layer behavior
- **THEN** the release workflow builds one Next.js static output with the supported Brai Node runtime
- **AND** publishes that output to `deploy/web`
- **AND** publishes an Android OTA bundle from that same output to `deploy/mobile-update`
- **AND** does not require a new APK
- **AND** uses the same `X.Y.Z` version for browser web and Android OTA

### Requirement: Native Android changes publish release APK artifacts
Brai SHALL publish a release APK whenever a change crosses the native Android release boundary.

#### Scenario: Native Android release is required
- **WHEN** a release changes Android native code, Capacitor configuration, permissions, signing, manifest values, application id, SDK versions, native plugins, icons, splash assets, or the supported Node runtime used for native build tooling
- **THEN** the release workflow builds a release APK when required by the native boundary
- **AND** publishes the APK artifact to `deploy/releases`
- **AND** updates and verifies the release page metadata

### Requirement: Build, APK, and OTA versions are separate

Brai SHALL track completed project work and public platform releases as
separate version types in Supabase Postgres.

For `version_type_id = build`, `build_versions.version` SHALL be a monotonically
increasing completed-work counter. A build SHALL include all merged owner and
support PRs registered to one release work, including product, server, Android,
CI/CD, infrastructure, documentation, maintenance, and refactoring changes.

`build_versions.version` SHALL NOT be treated as proof that a browser web or
Android OTA artifact with the same number was published. Browser web and
Android OTA SHALL continue to use their published `X.Y.Z` artifact version.

For `version_type_id = apk`, `build_versions.version` SHALL be the stable public
APK counter `N`. Preview iteration `M` and Android version codes SHALL keep the
existing native-preview compatibility rules. Future platform types such as
`macos` and `ios` SHALL follow the same independent platform-version model.

The public type labels SHALL be `Product` for `build`, `Android APK` for `apk`,
`macOS` for `macos`, and `iOS` for `ios`. The future types SHALL exist in the
type registry and filters without fabricated version rows or counters.

Every version SHALL retain Russian human-readable parent summary, detailed
summary, and reason plus normalized atomic details. Branch names, commit SHAs,
domains, and similar refs SHALL remain structured audit metadata rather than
being embedded in the human reason.

#### Scenario: An ordinary work is finalized
- **WHEN** an owner task and all registered support tasks reach terminal PR states
- **THEN** the workflow creates or reuses exactly one build row for that work
- **AND** links every merged PR of the work to that build
- **AND** creates the build even when the completed work changed only server, CI/CD, infrastructure, documentation, maintenance, or refactoring

#### Scenario: A work publishes no client artifact
- **WHEN** a completed work produces a build row but no browser web or Android OTA artifact
- **THEN** the build remains visible in project history
- **AND** the published web/OTA artifact version does not advance solely because the build exists

#### Scenario: A stable APK is published
- **WHEN** a work changes the Android native boundary and successfully publishes a stable APK
- **THEN** the workflow creates or reuses one APK version for that work
- **AND** links only PRs with proven APK relevance
- **AND** stores only APK-specific summary, reason, and atomic details

#### Scenario: No native boundary changed
- **WHEN** work changes only web, OTA, server, CI/CD, infrastructure, documentation, maintenance, or non-native refactoring
- **THEN** it does not create an APK version
- **AND** rebuilding an unchanged APK alone does not create an APK version

### Requirement: Delivery scripts do not depend on unsupported host Node
Brai delivery scripts SHALL select the supported Brai Node runtime before running JavaScript build or publication logic.

#### Scenario: Publish script is run from a clean shell
- **WHEN** a maintainer runs `npm run publish:client-web-layer`
- **THEN** the build, browser web publication, and Android OTA publication use the supported Brai Node runtime
- **AND** the workflow succeeds even when the host default `node` is unsupported

### Requirement: Retired timer and history URLs are not served
Brai SHALL not serve retired `/timer*` or `/history*` web app URLs after Timer is renamed to Focus and History is merged into Focus.

#### Scenario: Focus static route is served
- **WHEN** `app.brai.one/focus` is requested
- **THEN** Caddy serves the static exported Focus route

#### Scenario: Timer URL is retired
- **WHEN** `app.brai.one/timer` or a nested `/timer*` path is requested
- **THEN** Caddy returns 404
- **AND** it does not serve the app fallback

#### Scenario: History URL is retired
- **WHEN** `app.brai.one/history` or a nested `/history*` path is requested
- **THEN** Caddy returns 404
- **AND** it does not serve the app fallback

### Requirement: Branch classes map to production and preview environments
Brai SHALL use one production environment and five preview environments.

#### Scenario: A branch is deployed
- **WHEN** `main` is deployed
- **THEN** it targets production at `app.brai.one`
- **WHEN** a `codex/*` branch is deployed
- **THEN** it allocates or reuses one preview slot from `A` through `E`

### Requirement: Preview Android apps are separately installable
Brai SHALL provide non-production Android flavors for preview slots `A` through `E`.

#### Scenario: Non-production Android apps are built
- **WHEN** preview APKs are built
- **THEN** they use separate application ids, labels, icons, and OTA channels
- **AND** they can be installed side-by-side with production
- **AND** transient branch preview APKs use a separate application id from the accepted Preview A-E stable baseline

### Requirement: Non-production APK builds use APK target compatibility
Brai SHALL keep Preview APK artifacts aligned with their OTA manifests through the public APK counter `N`.

#### Scenario: Native preview APK is published
- **WHEN** a `codex/*` branch changes the native Android boundary
- **THEN** the allocated preview slot APK is built with Android `versionName=N` and `versionCode=N * 10000 + M`
- **AND** the preview release metadata records slot-specific `brai-<slot>-vN-previewM.apk`, APK version `N`, and branch-local preview iteration `M`
- **AND** the Preview OTA manifest targets release key, build kind, stable `N`, and preview `M`
- **AND** `M` is committed only after the preview deployment is fully ready, so failed builds and failed deployments retry the same `M`

#### Scenario: Accepted native work reaches production
- **WHEN** native-boundary work is accepted into `main`
- **THEN** Production, Dev, and Preview A-E APKs are rebuilt from production source as stable `vN` APKs

### Requirement: Deployment metadata is recorded per environment
Brai SHALL record deployment metadata for production and preview environments.

#### Scenario: Branch deployment completes
- **WHEN** a branch deploy succeeds
- **THEN** the target environment database records environment, slot when applicable, branch, commit, domain, web/OTA version, APK version when applicable, deployment time, and reason
- **AND** preview metadata can be promoted directly into production through accepted branch flow

### Requirement: Brai Admin is served under each app environment
Brai SHALL serve the technical admin panel at `/admin` inside each Brai runtime
environment domain instead of a standalone admin subdomain.

#### Scenario: Production admin is requested
- **WHEN** `https://app.brai.one/admin` is requested
- **THEN** Caddy routes the request to the production admin service before the web catch-all
- **AND** Caddy does not apply Basic Auth to the production admin route
- **AND** the admin app grants access only to the Brai primary user account

#### Scenario: Non-production admin is requested
- **WHEN** `/admin` is requested on the Dev or Preview A-E environment domains
- **THEN** Caddy applies the unified Basic Auth directive before proxying to the matching admin service
- **AND** the admin app grants access only to the Brai primary user account for that environment database

#### Scenario: Old admin subdomain is removed
- **WHEN** Brai managed Caddy routes are installed
- **THEN** retired standalone admin hostnames are removed from unmanaged Brai site blocks
- **AND** no standalone admin Caddy site remains required

### Requirement: Release catalogues separate public and operational visibility

Brai SHALL permanently publish a public current-Production APK and a protected all-channel developer catalogue.

#### Scenario: Public release page is opened
- **WHEN** a client requests `GET /releases/`
- **THEN** the page contains only the current Production APK
- **AND** it requires no release password

#### Scenario: Developer release page is opened
- **WHEN** an authenticated release-session requests `GET /dev-releases/`
- **THEN** the page contains Production, Dev, and Preview A–E artifacts
- **AND** unauthenticated requests receive the release login flow

#### Scenario: Legacy release login is used
- **WHEN** a client requests `/releases/login`
- **THEN** it is redirected to `/dev-releases/`

#### Scenario: Production APK is published
- **WHEN** a new stable Production APK is accepted
- **THEN** `/releases/` and its public Production download are updated
- **AND** a user without Brai installed can always install the current Production APK from the web

#### Scenario: developer catalogue is opened in any environment
- **WHEN** a client requests `/dev-releases/` on Production, Dev, or Preview A-E
- **THEN** Caddy routes it to the matching API
- **AND** the existing release login accepts the same configured standard release password in every environment

### Requirement: Installed apps can download a channel APK directly

Brai SHALL expose integrity metadata with each current channel APK.

#### Scenario: known channel is downloaded
- **WHEN** `GET /releases/download/:releaseKey` streams an APK
- **THEN** the response includes content length and the release-index SHA-256 in a stable response header
- **AND** the streamed file matches both values

#### Scenario: Unknown or hidden file is requested
- **WHEN** the release key is unknown or a non-Production filename is requested through `/releases/<filename>`
- **THEN** the API returns `404`

### Requirement: APK download starts are rate limited per client IP

Brai SHALL allow at most ten started APK streams per derived client IP in 3600 seconds in one API process.

#### Scenario: Eleventh download starts within the window
- **WHEN** the same derived IP has started ten APK downloads in the current window
- **THEN** the API returns `429` and `Retry-After`
- **AND** does not open the APK stream

#### Scenario: Request passes through local Caddy
- **WHEN** the socket peer is loopback and `X-Forwarded-For` is present
- **THEN** the limiter uses the client address supplied by Caddy
- **AND** otherwise it uses the socket peer address

### Requirement: Structured release metadata separates work and platforms

Brai SHALL carry version metadata through `brai-release-notes-v2` with immutable
work identity, owner/support role, atomic build details, and independent
platform release blocks.

#### Scenario: An owner prepares handoff
- **WHEN** an owner writes release notes
- **THEN** the receipt contains the work key, owner role, build parent summary, reason, at least one atomic detail, and testing instructions
- **AND** finalization aggregates atomic build details from every merged support PR of the same work

#### Scenario: A support PR prepares handoff
- **WHEN** a support task writes release notes
- **THEN** it inherits the owner's work key
- **AND** contributes its own atomic build details without replacing the owner build summary

#### Scenario: Native metadata is missing
- **WHEN** a native detector reports an APK boundary change but no complete APK platform block exists
- **THEN** Preview and acceptance fail before stable publication
- **AND** generic APK fallback text is not written

#### Scenario: A legacy v1 receipt is encountered
- **WHEN** a non-native PR was already open before v2 deployment
- **THEN** the workflow may map its v1 detailed text to one build detail
- **AND** newly created PRs and every native release require v2

#### Scenario: New release notes omit atomic details
- **WHEN** an owner or support task writes v2 release notes without an explicit atomic detail
- **THEN** release-note creation fails with a correction message
- **AND** the parent detailed summary is not copied into a synthetic single detail

#### Scenario: New release notes contain duplicate details
- **WHEN** a detail repeats the parent summary, duplicates another detail, or uses an automatically numbered title
- **THEN** release-note creation fails before handoff
- **AND** every accepted detail retains a meaningful independent title and description

### Requirement: Product history contains accepted work only

Product versions SHALL be allocated only when work is accepted and finalized.
Preview browser/OTA artifact versions SHALL remain independent runtime facts.

#### Scenario: Preview advances its browser artifact
- **WHEN** a Preview publishes a new `X.Y.Z` browser or OTA artifact
- **THEN** no provisional Product version is created
- **AND** the Preview receives the Product baseline of its frozen accepted base for installed-state comparison
