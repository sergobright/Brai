## ADDED Requirements

### Requirement: Architecture decisions use ADRs
Brai SHALL keep durable architecture decision rationale under `docs/adr/`.

#### Scenario: Architecture decision is made
- **WHEN** a decision affects architecture, data, security, deployment, dependencies, public contracts, or more than one module
- **THEN** an Architecture Decision Record is created or updated under `docs/adr/`
- **AND** the ADR records the status, context, decision, alternatives considered, consequences, confirmation checks, and relevant links

#### Scenario: Accepted behavior is documented
- **WHEN** an ADR describes a choice that changes accepted behavior or workflow rules
- **THEN** the accepted behavior remains recorded in `openspec/specs/`
- **AND** the ADR links to the relevant OpenSpec change or spec instead of replacing it

### Requirement: Accepted ADR history is preserved
Accepted ADRs SHALL be preserved as historical decision records.

#### Scenario: Architecture decision changes
- **WHEN** a later decision replaces an accepted ADR
- **THEN** a new ADR is created for the replacement decision
- **AND** the old ADR is marked as superseded instead of being rewritten to hide the previous choice

### Requirement: ADRs are rendered with Log4brains
Brai SHALL use Log4brains as the repository-local ADR browser and static-site generator.

#### Scenario: ADR site is built
- **WHEN** maintainers run the ADR build command
- **THEN** Log4brains reads ADRs from `docs/adr/`
- **AND** generated static output stays outside committed source

#### Scenario: ADR site is published
- **WHEN** the ADR site is published
- **THEN** it is served from the protected `adr.brightos.world` technical subdomain
- **AND** the route uses the unified Caddy basic authentication directive
