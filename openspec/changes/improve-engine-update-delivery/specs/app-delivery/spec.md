# app-delivery Delta

## ADDED Requirements

### Requirement: Release catalogues separate public and operational visibility

Brai SHALL publish a public Production catalogue and a protected all-channel developer catalogue.

#### Scenario: Public release page is opened
- **WHEN** a client requests `GET /releases/`
- **THEN** the page contains only the current Production APK
- **AND** it requires no release password

#### Scenario: Developer release page is opened
- **WHEN** an authenticated release-session requests `GET /dev-releases/`
- **THEN** the page contains Production, Dev, and Preview A–E artifacts
- **AND** unauthenticated requests receive the existing release login flow

#### Scenario: Legacy release login is used
- **WHEN** a client requests `/releases/login`
- **THEN** it is redirected to `/dev-releases/`

### Requirement: Installed apps can download a channel APK directly

Brai SHALL expose the current APK for a known release key without application or release authentication.

#### Scenario: Known channel is downloaded
- **WHEN** a client requests `GET /releases/download/:releaseKey` for `production`, `dev`, or `a`–`e`
- **THEN** the current matching APK is streamed with APK content type, content length, and attachment disposition

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
