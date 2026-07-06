# inbox Specification

## Purpose

This specification defines Inbox storage, sync, and first UI behavior for incoming material before normalization.
## Requirements
### Requirement: Inbox records incoming items
Brai SHALL store incoming items in a server Supabase Postgres `inbox` table and
register `inbox` as a main work entity in `items`.

#### Scenario: Inbox schema is initialized
- **WHEN** the server database schema is initialized or migrated
- **THEN** the `inbox` table exists
- **AND** each inbox row can store title, description, source, date, author,
  preliminary section, urgency, attachment links, explanation, normalization
  text, and whether the item is normalized
- **AND** technical id, creation, and update timestamps are stored
- **AND** `table_descriptions` contains schema metadata for `inbox`

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
Brai SHALL expose an `Inbox` main navigation item between Actions and
Focus and render a page titled `Входящие`.

#### Scenario: User creates and edits an incoming item
- **WHEN** the user opens `Inbox`
- **THEN** the app shows a list of incoming items and a direct create input
- **AND** newly created incoming items appear in the list
- **AND** selecting an incoming item opens a detail editor with Markdown
  description editing and preview
- **AND** rows show a type icon instead of an action status checkbox
- **AND** the inbox UI does not expose `New`, `Done`, or completed-status
  controls
