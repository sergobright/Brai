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
