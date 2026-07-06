## ADDED Requirements

### Requirement: Postgres smoke checks active runtime schema
Brai Postgres smoke checks SHALL validate the active runtime schema selected by
the connection search path instead of assuming `public`.

#### Scenario: Preview schema is smoke-tested
- **WHEN** `deploy/scripts/postgres-smoke.mjs` runs against a preview database URL
- **THEN** it reads `current_schema()` as the runtime schema
- **AND** it verifies required runtime tables, seed rows, RLS trigger/function, and RLS-enabled tables in that schema
- **AND** its JSON output includes `runtimeSchema`

### Requirement: Supabase preview database overrides are explicit and bounded
Brai SHALL reject `SUPABASE_BRANCH_DATABASE_URL` in normal deploy paths.

#### Scenario: Override is provided without explicit allowance
- **WHEN** `SUPABASE_BRANCH_DATABASE_URL` is set
- **AND** `BRAI_ALLOW_SUPABASE_BRANCH_DATABASE_URL_OVERRIDE` is not `true`
- **THEN** Supabase branch setup fails before migrations or seed run

#### Scenario: Override is explicitly allowed
- **WHEN** an allowed test or dry-run flow sets `SUPABASE_BRANCH_DATABASE_URL`
- **THEN** the URL must include the expected branch or schema marker
- **AND** the override must not be accepted as an unmarked production or shared database URL
