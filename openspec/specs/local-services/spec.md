# Local Services Specification

## Purpose

This specification records stable local service integrations available to Brai development workflows.
## Requirements
### Requirement: Kroki is available for diagram rendering
The project SHALL treat Kroki at `http://127.0.0.1:8000` as the local diagram rendering service.

#### Scenario: Diagram output is needed
- **WHEN** a task needs rendering or exporting text-based diagrams or visualizations
- **THEN** Kroki is used when it supports the requested format

### Requirement: Kroki uses the shared Docker network
Kroki SHALL be considered available on the shared Docker network named `bright-net`.

#### Scenario: A containerized workflow needs Kroki
- **WHEN** a project workflow runs in a container and needs diagram rendering
- **THEN** it connects to Kroki over the `bright-net` network

### Requirement: SVG is the preferred diagram output
Diagram rendering tasks SHALL prefer SVG output unless the user asks for another format.

#### Scenario: No output format is specified
- **WHEN** a diagram or visualization export is requested without an explicit format
- **THEN** SVG is selected as the default output format

### Requirement: Brai API service uses the supported Brai Node runtime
The live Brai API service SHALL run with the supported Brai Node.js runtime installed under `/srv/opt/`.

#### Scenario: Brai API service starts
- **WHEN** `brai-api.service` starts
- **THEN** its Node.js executable is `/srv/opt/node-v22.16.0/bin/node` or an explicitly approved successor runtime
- **AND** it does not rely on `/usr/bin/node` when that binary is an unsupported Node version

#### Scenario: Brai API tests are run
- **WHEN** maintainers run `scripts/brai-api-test.sh`
- **THEN** the tests execute under the supported Brai Node runtime
- **AND** `BRAI_TEST_DATABASE_URL` points at a writable Postgres database for isolated test schemas
- **AND** isolated schemas include branch and run scopes
- **AND** the wrapper removes its run-scoped schemas before reporting completion
- **AND** a cleanup failure makes the test command fail
- **AND** the test suite passes without a native `SIGSEGV`

#### Scenario: An API fixture shutdown fails
- **WHEN** server shutdown throws or rejects
- **THEN** database schema and temporary-file cleanup are still attempted

### Requirement: One VPS hosts production and preview services behind Caddy
Brai SHALL host production and preview Brai API and Admin services on localhost-only
ports behind Caddy.

#### Scenario: Environment services are installed
- **WHEN** server automation is applied
- **THEN** production API uses `127.0.0.1:3020`
- **AND** production Admin uses `127.0.0.1:3040`
- **AND** Dev Admin uses `127.0.0.1:3041`
- **AND** Preview A-E Admin uses `127.0.0.1:3042` through `127.0.0.1:3046`
- **AND** preview API slots use `127.0.0.1:3031` through `127.0.0.1:3035`
- **AND** Caddy exposes only HTTPS/HTTP entrypoints externally while app services remain localhost-only

### Requirement: Deployment credentials stay outside source
Brai deployment automation SHALL read deploy host, user, port, repository path, and SSH key from GitHub Actions variables/secrets.

#### Scenario: CI deploys a branch
- **WHEN** GitHub Actions performs a deployment
- **THEN** `BRAI_DEPLOY_SSH_KEY` comes from repository secrets
- **AND** deploy host/user/port/repo come from repository variables or safe defaults
- **AND** private deploy keys and server env files are not committed

### Requirement: Preview data copy preserves identity allocation safety
Brai SHALL leave every copied preview serial or identity sequence in a state where
subsequent default inserts cannot collide with copied rows.

#### Scenario: Production rows are copied with explicit IDs
- **WHEN** preview refresh copies production rows using explicit identity values
- **THEN** every owned sequence for copied tables is advanced inside the same transaction
- **AND** an already-ahead sequence is never moved backwards
- **AND** empty copied tables retain their existing safe allocation state

#### Scenario: Preview readiness checks sequences
- **WHEN** preview database smoke checks run after refresh
- **THEN** every owned serial or identity sequence is checked against existing table values
- **AND** readiness fails before the API starts if a future default value can collide

#### Scenario: Preview schema is refreshed
- **WHEN** deployment truncates and recopies a preview schema
- **THEN** truncate, copy, and sequence repair remain in one locked transaction
- **AND** required post-seed migrations run inside that same transaction before commit
- **AND** concurrent writes cannot observe or modify partial copied state
- **AND** the API moves to the new source through the existing deploy cutover after migrations and database smoke checks pass

### Requirement: Authentication readiness fails closed

Brai API SHALL expose authentication backend outages as unavailable service state instead of anonymous user state.

#### Scenario: Better Auth is unavailable

- **WHEN** Better Auth throws, times out, returns a non-OK response, or returns a malformed success while resolving a session
- **THEN** `/auth/session` and session-protected `/v1/*` return `503` with `auth_backend_unavailable`
- **AND** WebSocket upgrade returns Service Unavailable rather than Unauthorized
- **AND** no connection details or credentials are exposed

#### Scenario: API readiness is checked

- **WHEN** either the product Postgres pool or the Better Auth Postgres pool cannot execute its health query
- **THEN** `/health` returns `503`
- **AND** deployment readiness does not report success

### Requirement: Production and non-production use isolated Supavisor tenants

Supavisor SHALL provide separate production and non-production circuit-breaker boundaries.

#### Scenario: Runtime DSNs are generated

- **WHEN** production, Dev, or Preview database URLs are written after tenant isolation is enabled
- **THEN** production uses tenant `brai-prod`
- **AND** Dev and Preview use tenant `brai-nonprod`
- **AND** password, database, port, query parameters, and schema `search_path` remain unchanged

#### Scenario: Maintenance removes legacy tenant metadata

- **WHEN** guarded Supavisor maintenance recreates the pooler
- **THEN** persistent tenant metadata contains exactly `brai-prod` and `brai-nonprod`
- **AND** legacy `brightos`, `brightos-prod`, and `brightos-nonprod` tenants and their dependent metadata are removed
- **AND** any unexpected remaining tenant makes maintenance fail closed before API clients restart

#### Scenario: Deployment validates a runtime environment

- **WHEN** an API environment is deployed after tenant isolation is enabled
- **THEN** deployment fails before service cutover if its DSN does not use the expected tenant
