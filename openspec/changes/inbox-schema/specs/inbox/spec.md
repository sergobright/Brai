## ADDED Requirements

### Requirement: Inbox records incoming items
Bright OS SHALL store incoming items in a server SQLite `inbox` table and
register `inbox` as a main work entity in `items`.

#### Scenario: Inbox schema is initialized
- **WHEN** the server database schema is initialized or migrated
- **THEN** the `inbox` table exists
- **AND** each inbox row can store title, description, source, date, author,
  preliminary section, urgency, attachment links, explanation, normalization
  text, and whether the item is normalized
- **AND** technical id, creation, and update timestamps are stored
- **AND** `table_descriptions` contains schema metadata for `inbox`
