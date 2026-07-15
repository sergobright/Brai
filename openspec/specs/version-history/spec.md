# version-history Specification

## Purpose
TBD - created by archiving change normalize-version-work-history. Update Purpose after archive.
## Requirements
### Requirement: Version history is normalized and evidence-backed

Brai SHALL store completed works, GitHub pull requests, atomic version details,
and version-to-PR relationships as normalized Postgres data.

#### Scenario: A completed work is recorded
- **WHEN** a release work is finalized
- **THEN** exactly one build version is associated with that work
- **AND** the build has at least one ordered atomic detail
- **AND** every merged owner or support PR registered to that work is linked to the build
- **AND** no PR from another work is linked by timestamp or Git range inference

#### Scenario: One PR affects multiple release types
- **WHEN** a PR belongs to a build and also causes a stable APK release
- **THEN** it may be linked once to the build and once to the APK
- **AND** it cannot be linked to two builds or two APK versions
- **AND** the same invariant applies to future version types such as `macos` and `ios`

### Requirement: Version details describe independent changes

Every version SHALL contain at least one detail whose title and description
identify one independent change and its result.

#### Scenario: One work contains unrelated changes
- **WHEN** a work changes a card, a release script, and an application logo
- **THEN** the version contains three separately ordered detail rows
- **AND** each description states what changed, where, why, previous behavior, new behavior, and resulting effect
- **AND** the parent version remains a concise summary rather than duplicating every detail

#### Scenario: A detail has PR evidence
- **WHEN** a detail was introduced by a known PR
- **THEN** the detail retains a direct reference to that PR
- **AND** the relationship remains queryable independently from display text

#### Scenario: Parent and atomic text are validated
- **WHEN** version metadata is authored or historically reconstructed
- **THEN** the parent detailed summary covers the complete version at a higher level
- **AND** no atomic detail exactly duplicates the parent summary
- **AND** no detail title is made meaningful only by a numeric suffix

### Requirement: GitHub pull request history is complete

Brai SHALL retain the public release-time GitHub metadata required to explain
and audit every version relationship.

#### Scenario: A pull request is registered
- **WHEN** GitHub opens, updates, closes, or merges a Brai PR with a work marker
- **THEN** Brai upserts repository, number, URL, title, full body, author, state, draft status, head/base branches, merge SHA, and GitHub timestamps
- **AND** the PR retains its immutable work identity and owner/support role

#### Scenario: A historical version had no pull request
- **WHEN** the available evidence proves that no PR existed for a version
- **THEN** the version remains valid with zero PR links
- **AND** API and UI explicitly state that no PR is available

### Requirement: Historical version data is restored without guessing

Brai SHALL backfill every existing version from auditable sources while
preserving historical version numbers and release dates.

#### Scenario: Historical evidence is sufficient
- **WHEN** Git, GitHub, release, artifact, Preview, or Temporal evidence proves a detail or relationship
- **THEN** the idempotent backfill writes that fact using stable keys
- **AND** running the backfill again produces no duplicate or reordered rows

#### Scenario: Historical evidence is insufficient
- **WHEN** a detail or PR relationship cannot be proven
- **THEN** the backfill does not infer it from adjacency, timestamp, or commit range alone
- **AND** the item and examined evidence appear in the insufficient-evidence report

#### Scenario: Existing details are normalized again
- **WHEN** the historical manifest is regenerated for the current cutoff
- **THEN** every existing Product and Android APK version is reviewed
- **AND** independent evidenced changes are split into separate meaningful details
- **AND** original version numbers, release dates, refs, and proven PR links are preserved

#### Scenario: APK v11 is restored
- **WHEN** APK v11 is backfilled
- **THEN** its original number and release date remain unchanged
- **AND** it links to PR #279 rather than PR #282
- **AND** its summary, reason, and details describe only the Android changes evidenced by PR #279 and the published build-142 artifact

### Requirement: Public version history is cursor-paginated

Brai SHALL expose complete version history through public read-only
`GET /v1/version-history` without exposing secrets or private runtime data.

#### Scenario: Public history is requested
- **WHEN** a client requests history without authentication
- **THEN** the API returns versions newest first with ordered details, work metadata, full linked PR metadata, and refs
- **AND** the default page size is 30 and the maximum is 100
- **AND** the response contains an opaque next cursor when more rows exist

#### Scenario: History is filtered by version type
- **WHEN** a client supplies a valid `type`
- **THEN** only that version type is returned
- **AND** invalid types, limits, or cursors return `400`

#### Scenario: Public landing requests history
- **WHEN** `https://brai.one` calls the endpoint
- **THEN** CORS allows that origin
- **AND** the response includes no credentials, tokens, cookies, private configuration, local paths, or deployment secrets

### Requirement: The public versions page renders live history safely

The public `brai.one/versions` page SHALL render the shared version-history API
without introducing a second history backend or application runtime.

#### Scenario: A visitor opens the versions page
- **WHEN** history loads successfully
- **THEN** the page shows newest-first versions, type filters, summaries, reasons, details, PR links, complete expandable PR metadata, and progressive pagination
- **AND** all API-provided text is safely escaped or sanitized with raw HTML disabled

#### Scenario: Public history cannot load
- **WHEN** the API is unavailable or rejects the request
- **THEN** the page shows an explicit retryable error
- **AND** it does not present the old hard-coded timeline as current data
