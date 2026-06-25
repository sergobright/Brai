# Local Services Specification

## Purpose

This specification records stable local service integrations available to Bright OS development workflows.
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

### Requirement: Bright OS API service uses the supported Bright OS Node runtime
The live Bright OS API service SHALL run with the supported Bright OS Node.js runtime installed under `/srv/opt/`.

#### Scenario: Bright OS API service starts
- **WHEN** `brightos-api.service` starts
- **THEN** its Node.js executable is `/srv/opt/node-v22.16.0/bin/node` or an explicitly approved successor runtime
- **AND** it does not rely on `/usr/bin/node` when that binary is an unsupported Node version

#### Scenario: Bright OS API tests are run
- **WHEN** maintainers run `npm --prefix services/bright_os_api test`
- **THEN** the tests execute under the supported Bright OS Node runtime
- **AND** native SQLite dependencies are installed or rebuilt for that runtime
- **AND** the test suite passes without a native `SIGSEGV`

### Requirement: One VPS hosts prod, dev, and preview services behind Caddy
Bright OS SHALL host production, dev, and preview Bright OS API services on localhost-only ports behind Caddy.

#### Scenario: Environment services are installed
- **WHEN** server automation is applied
- **THEN** production uses `127.0.0.1:3020`
- **AND** dev and preview slots use `127.0.0.1:3030` through `127.0.0.1:3035`
- **AND** Caddy exposes only HTTPS/HTTP entrypoints externally while app services remain localhost-only

### Requirement: Deployment credentials stay outside source
Bright OS deployment automation SHALL read deploy host, user, port, repository path, and SSH key from GitHub Actions variables/secrets.

#### Scenario: CI deploys a branch
- **WHEN** GitHub Actions performs a deployment
- **THEN** `BRIGHT_DEPLOY_SSH_KEY` comes from repository secrets
- **AND** deploy host/user/port/repo come from repository variables or safe defaults
- **AND** private deploy keys and server env files are not committed
