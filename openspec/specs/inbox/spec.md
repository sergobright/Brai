# inbox Specification

## Purpose

This specification defines Inbox storage, sync, and first UI behavior for incoming material before normalization.
## Requirements
### Requirement: Inbox records incoming items
Brai SHALL store incoming material in the server Supabase Postgres `inbox` table as a role-table record that may be raw before entity linkage.

#### Scenario: Inbox schema is initialized
- **WHEN** the server database schema is initialized or migrated
- **THEN** the `inbox` table exists
- **AND** each inbox row can store title, description, source, date, author, preliminary section, urgency, attachment links, explanation, normalization text, AI/workflow state, and whether compatibility clients should treat the row as normalized
- **AND** each inbox row can store `item_roles_id` for the normalized role link
- **AND** each inbox row can store `initial_event_id` for the raw ingest event
- **AND** technical id, creation, and update timestamps are stored
- **AND** `table_descriptions` contains schema metadata for `inbox`

#### Scenario: Inbox row is raw before normalization
- **WHEN** an Inbox row exists without `item_roles_id`
- **THEN** Brai treats the row as a raw role record
- **AND** `is_normalized` is not the source of truth for role linkage

#### Scenario: Inbox row is normalized
- **WHEN** an Inbox row has `item_roles_id`
- **THEN** Brai treats the row as linked to an entity through `item_roles`
- **AND** the Inbox row does not directly link to `items`

### Requirement: Inbox accepts offline-first client events
Brai SHALL accept inbox mutations through an append-only server event log
so clients can create incoming items before a canonical server row exists.

#### Scenario: Offline-created inbox events sync later
- **WHEN** a client syncs a valid inbox `create` event with a client-generated
  `inbox_id`
- **THEN** the server stores the event in `inbox_events`
- **AND** projects the event into the canonical `inbox` table
- **AND** returns the canonical inbox state and server revision

#### Scenario: Missing inbox rows do not create FK conflicts
- **WHEN** a client syncs a valid inbox mutation for an `inbox_id` that is not
  currently present in the canonical `inbox` table
- **THEN** the server accepts the event into `inbox_events`
- **AND** does not require a foreign-key reference from the event to `inbox`

### Requirement: Inbox page supports direct capture
Brai SHALL expose an `Inbox` main navigation item between Actions and Focus and render a page titled `Входящие`.

#### Scenario: User creates and edits an incoming item
- **WHEN** the user opens `Inbox`
- **THEN** the app shows a list of incoming items and a direct create input
- **AND** newly created incoming items appear in the list before AI processing completes
- **AND** selecting an incoming item opens a detail editor with Markdown description editing and preview
- **AND** rows show a type icon instead of an action status checkbox
- **AND** the inbox UI does not expose `New`, `Done`, or completed-status controls

#### Scenario: Inbox AI workflow is running
- **WHEN** an Inbox row has a running normalization workflow
- **THEN** the Inbox UI shows `AI-working` with a spinner

#### Scenario: Inbox AI workflow succeeds
- **WHEN** an Inbox row has been normalized and has a preliminary type
- **THEN** the Inbox UI replaces the `AI-working` badge with that preliminary type

#### Scenario: Inbox AI workflow details are available
- **WHEN** workflow and AI processing state exists for an Inbox row
- **THEN** the Inbox AI tab can show actual workflow steps, AI attempts, last error, Temporal workflow id, and Temporal run id
