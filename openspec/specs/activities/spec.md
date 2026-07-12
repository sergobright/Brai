# activities Specification

## Purpose
TBD - created by archiving change add-actions-task-list. Update Purpose after archive.
## Requirements
### Requirement: Activities are synced tasks
Brai SHALL provide an Activities module for task records synchronized between Web and Android.

Activity records SHALL reference `activity_types` through `activity_type_id`.
Product-created user task records SHALL use `activity_type_id = action`.
Future product-created user operation records MAY use `activity_type_id = operation`.
Agent service logs SHALL NOT use raw `activities` as their ingest sink.

#### Scenario: Activity is deleted
- **WHEN** the user deletes an activity
- **THEN** the activity is removed from the active Activities list
- **AND** the activity is marked as deleted in canonical storage
- **AND** the deletion synchronizes to other clients

#### Scenario: Activity is restored
- **WHEN** the user restores a deleted activity
- **THEN** the activity is removed from the archived list
- **AND** the activity returns to the active Activities list as `New`
- **AND** it appears above older active activities without manual order

#### Scenario: User activity is recorded
- **WHEN** a user creates an activity from the product interface
- **THEN** it is stored with `activity_type_id = action`

#### Scenario: User operation is recorded
- **WHEN** a future product interface creates an operation activity
- **THEN** it is stored with `activity_type_id = operation`
- **AND** it enters the same raw normalization workflow as user-created actions

### Requirement: Raw Activities are AI-normalized into item roles
Activities created through the sync path SHALL start as raw records when
`item_roles_id` is null and SHALL be normalized by the Activity workflow before
they are linked into `items` and `item_roles`.

#### Scenario: User action is created as raw data
- **WHEN** a user creates an action through Activity sync
- **THEN** the Activity is stored without `item_roles_id`
- **AND** a queued `activity.raw-normalization` workflow execution is created

#### Scenario: Activity normalization is applied
- **WHEN** the Activity workflow accepts normalized output
- **THEN** it may update `title`, `description_md`, and `reason`
- **AND** it does not change `activity_type_id`, `author`, `status`, `completed_at_utc`, `sort_order`, or deletion fields
- **AND** it creates or updates the related `items` and `item_roles` records
- **AND** it writes an `activity.normalized` event

#### Scenario: User changes arrive before normalization completes
- **WHEN** status, deletion, restore, or ordering changes are accepted before Activity normalization applies
- **THEN** those user changes are preserved after workflow apply

### Requirement: Activities use two statuses
Activity records SHALL store status directly on the record as either `New` or `Done`.

#### Scenario: Activity is created
- **WHEN** the user creates an activity
- **THEN** it is stored with status `New`

#### Scenario: Activity is completed
- **WHEN** the user marks an activity complete
- **THEN** it is stored with status `Done`

### Requirement: Activities synchronize offline-first
Brai clients SHALL record activity mutations locally before showing the mutation as applied and synchronize those mutations through the API when connectivity is available.

#### Scenario: Activity is restored offline
- **WHEN** the user restores an archived activity while disconnected
- **THEN** the activity appears immediately in the active list
- **AND** the pending restore event survives reload or app restart
- **AND** it syncs when the API becomes available

### Requirement: Activities API is authenticated
Activities API endpoints SHALL require the same Bearer token or Brai API session-cookie authorization used by existing v1 API endpoints.

#### Scenario: Unauthorized request
- **WHEN** a request without valid authorization calls an Activities v1 endpoint
- **THEN** the API returns 401
- **AND** no activity state is mutated

### Requirement: Activity sync is idempotent
The Activities API SHALL accept duplicate sync requests without creating duplicate activities or reapplying already accepted events.

#### Scenario: Duplicate restore event is uploaded
- **WHEN** the same activity restore event id is uploaded more than once
- **THEN** the server acknowledges the event
- **AND** canonical Activities state remains unchanged after the first application

### Requirement: Activities support Markdown descriptions
Activity records SHALL support an optional Markdown description stored as Markdown source text.

#### Scenario: Description is saved
- **WHEN** the user edits an activity description
- **THEN** the Activity stores the exact Markdown source except CRLF/CR normalization to LF
- **AND** an empty description clears the field

#### Scenario: Description is returned by the API
- **WHEN** a client requests Activities state
- **THEN** each activity includes `description_md`

#### Scenario: Description event is uploaded twice
- **WHEN** the same `update_description` event id is uploaded more than once
- **THEN** the server acknowledges the duplicate
- **AND** canonical Activities state remains unchanged after the first application

### Requirement: Deleted Activities are archived
Brai SHALL expose deleted Activities separately from active Activities.

#### Scenario: Activities state is requested
- **WHEN** a client requests Activities state
- **THEN** active records are returned in `activities`
- **AND** deleted records are returned in `archived_activities`
- **AND** active records do not include deleted records
