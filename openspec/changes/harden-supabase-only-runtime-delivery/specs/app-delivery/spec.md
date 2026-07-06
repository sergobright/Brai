## ADDED Requirements

### Requirement: API health exposes only safe deployment metadata
Brai API health responses SHALL expose only non-secret runtime metadata.

#### Scenario: Health endpoint is requested
- **WHEN** `/health` is requested
- **THEN** the response includes Postgres dialect, Supabase branch marker, branch, and commit when available
- **AND** absent branch or commit values are returned as `null`
- **AND** the response does not include DSNs, credentials, tokens, env dumps, or internal filesystem paths

### Requirement: Browser CORS denies untrusted API origins
Brai API SHALL not send wildcard CORS allow-origin headers to untrusted browser
origins for JSON API routes.

#### Scenario: Untrusted origin sends API preflight
- **WHEN** an `OPTIONS` request includes an untrusted `Origin`
- **THEN** the response does not include `access-control-allow-origin: *`
- **AND** trusted app, dev, preview, Capacitor, and localhost origins continue to receive matching CORS headers
- **AND** requests without `Origin` continue to work for CLI, mobile, and server clients
