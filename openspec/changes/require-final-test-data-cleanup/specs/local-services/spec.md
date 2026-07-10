## MODIFIED Requirements

### Requirement: Brai API service uses the supported Brai Node runtime
The live Brai API service SHALL run with the supported Brai Node.js runtime installed under `/srv/opt/`.

#### Scenario: Brai API tests are run
- **WHEN** maintainers run the API test wrapper
- **THEN** isolated Postgres schemas include branch and run scopes
- **AND** the wrapper removes its run-scoped schemas before reporting completion
- **AND** a cleanup failure makes the test command fail

#### Scenario: An API fixture shutdown fails
- **WHEN** server shutdown throws or rejects
- **THEN** database schema and temporary-file cleanup are still attempted
