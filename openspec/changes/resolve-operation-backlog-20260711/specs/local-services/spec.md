## ADDED Requirements

### Requirement: Shared PostgreSQL connections stay bounded
Brai SHALL configure Temporal and Supavisor pools so routine preview delivery
does not consume PostgreSQL reserved connection slots.

#### Scenario: Runtime services restart
- **WHEN** Supabase, Temporal, and Brai services reach steady state
- **THEN** aggregate connections remain below the operational threshold
- **AND** preview database smoke checks can still connect

### Requirement: Branded email has no attachment artifact
Brai SHALL render its email logo without a CID MIME attachment.

#### Scenario: OTP email is delivered
- **WHEN** an OTP email is sent
- **THEN** the logo uses a public HTTPS asset
- **AND** the message has no logo attachment

### Requirement: Shared Docker networking survives recreation
Brai SHALL declare Temporal-to-Supabase network membership and the
`supabase-db` alias in a durable managed configuration.

#### Scenario: Stateful containers are recreated
- **WHEN** Supabase and Temporal containers are recreated or restarted
- **THEN** Temporal resolves `supabase-db` on the shared network
- **AND** no manual network-connect command is required

### Requirement: Runtime secret rotation invalidates exposed values
Brai SHALL replace every runtime secret exposed outside its protected boundary
and SHALL restart all consumers with the replacements.

#### Scenario: Rotation is verified
- **WHEN** the affected integrations are tested after rotation
- **THEN** each replacement credential succeeds where intended
- **AND** each old credential is rejected
- **AND** no credential value appears in repository files or logs

### Requirement: API shutdown is bounded
Brai SHALL close background reconciliation, HTTP listeners, and PostgreSQL
pools on SIGTERM within the configured systemd stop timeout.

#### Scenario: Production service restarts
- **WHEN** systemd sends SIGTERM during active runtime work
- **THEN** shutdown completes without forced kill or terminating-connection errors
- **AND** the restarted health endpoint becomes ready
