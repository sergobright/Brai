# entity-role-architecture Specification

## Purpose
Define the canonical entity-role model, raw role records, active-role cardinality, and role-linked domain events.

## Requirements
### Requirement: Entities are represented through roles
Brai SHALL represent domain entities through `items`, `item_role_types`, `item_roles`, and role tables.

#### Scenario: A normalized role record belongs to an entity
- **WHEN** a role-table record has been normalized
- **THEN** `items` stores the fact that the entity exists
- **AND** `item_roles` stores the entity-role relationship
- **AND** the role table stores role-specific data only
- **AND** the role table does not directly reference `items`

### Requirement: Role table records link through item_roles
Every normalized role-table record SHALL reference `item_roles.id` through an `item_roles_id` field.

#### Scenario: The system resolves an entity from a role record
- **WHEN** Brai needs the entity for a normalized role-table record
- **THEN** it resolves the entity through `role_table.item_roles_id -> item_roles.id -> items.id`
- **AND** it does not require a direct `items_id` field on the role table

#### Scenario: A new role table is added
- **WHEN** a future role table is introduced
- **THEN** the table uses the same `item_roles_id` link pattern
- **AND** it does not introduce a direct role-table foreign key to `items`

### Requirement: Raw role records are unlinked role table records
Brai SHALL define a raw role record as a role-table row that does not yet have `item_roles_id`.

#### Scenario: A role record is created by ingest
- **WHEN** ingest creates a new role-table row
- **THEN** the row is raw while `item_roles_id` is empty
- **AND** the row stops being raw only after workflow creates `items`, creates `item_roles`, and writes `item_roles_id`

### Requirement: Active role cardinality is constrained
Brai SHALL prevent one entity from having more than one active role of the same type at the same time.

#### Scenario: A duplicate active role is attempted
- **WHEN** an item already has an active role of a given type
- **THEN** Brai rejects creation of another active role of that same type for the same item

#### Scenario: A role type returns after closure
- **WHEN** an item has a closed role of a given type
- **THEN** that historical closed role does not prevent a later active role of the same type

### Requirement: Role state changes are domain events
Brai SHALL record domain events for role lifecycle and role-state changes through `item_roles_id`.

#### Scenario: A role lifecycle change is recorded
- **WHEN** a role is created, normalized, closed, restored, or otherwise changes lifecycle state
- **THEN** Brai records a domain event linked through `item_roles_id`
- **AND** the event does not store a direct foreign key to the concrete role table

### Requirement: Raw ingest event is attached later
Brai SHALL create the first ingest event before `item_roles_id` exists and attach it to role state after normalization.

#### Scenario: A raw record is ingested
- **WHEN** ingest creates a raw role-table record
- **THEN** ingest also creates an event with no `item_roles_id`
- **AND** the raw record stores a reference to that initial event

#### Scenario: Normalization creates the role link
- **WHEN** `apply_normalized_raw` creates `item_roles`
- **THEN** it fills the initial event's missing `item_roles_id` exactly once
- **AND** it does not change the event payload, timestamp, or type
