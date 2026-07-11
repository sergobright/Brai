## ADDED Requirements

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
