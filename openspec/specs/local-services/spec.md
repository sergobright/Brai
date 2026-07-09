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
- **WHEN** maintainers run `npm --prefix services/brai_api test`
- **THEN** the tests execute under the supported Brai Node runtime
- **AND** `BRAI_TEST_DATABASE_URL` points at a writable Postgres database for isolated test schemas
- **AND** the test suite passes without a native `SIGSEGV`

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
