# local-first-client-data Specification

## Purpose
TBD - created by archiving change migrate-to-next-capacitor-local-first. Update Purpose after archive.
## Requirements
### Requirement: Client data uses a versioned local database
Brai clients SHALL use a versioned local database for durable offline state, pending events, cached canonical server snapshots, and future local-first modules.

#### Scenario: New client launches for the first time
- **WHEN** the Next.js/Capacitor client opens without existing local data
- **THEN** it creates the local database with the current schema version
- **AND** initializes stable client metadata required for sync

#### Scenario: Local schema changes
- **WHEN** a release adds a new local table, index, field, or migration
- **THEN** the client applies a versioned migration
- **AND** existing pending events and cached state remain available after the migration

#### Scenario: Migration fails
- **WHEN** local database migration fails
- **THEN** the client preserves existing local data
- **AND** shows a blocked or retryable state instead of clearing storage

### Requirement: Dexie is the initial local database adapter
Brai SHALL use IndexedDB through Dexie as the initial local database adapter for the Next.js/Capacitor client.

#### Scenario: Web and Android store local sync state
- **WHEN** the web app or Capacitor Android app records local sync state
- **THEN** it stores structured data in the Dexie database
- **AND** uses Capacitor Preferences only for small simple settings where a database is not needed

### Requirement: Mutations are durable before visible state changes
Brai clients SHALL persist local mutation events before showing a mutation as locally applied.

#### Scenario: Activity is restored offline
- **WHEN** the user restores an archived activity without API connectivity
- **THEN** the client writes a durable local activity restore event in a transaction
- **AND** then displays the locally projected active Activities list and Archive list

### Requirement: Pending events survive client lifecycle changes
Brai clients SHALL preserve pending local events across page reloads, app restarts, and Android app kill/reopen when local storage remains intact.

#### Scenario: App restarts before reconnect
- **WHEN** pending events exist and the app is closed before reconnect
- **THEN** the next app launch reloads the pending events
- **AND** resumes projected state and retry behavior from local data

#### Scenario: Activity editor is abandoned before debounce flush
- **WHEN** the user edits an activity title or description and then presses Back, closes the editor, backgrounds the app, or the page hides
- **THEN** the client flushes the pending local save before leaving the editor when possible
- **AND** any leftover local draft is restored and converted into a pending Activity event on the next launch

### Requirement: Goal creation from membership is one durable local intent
Brai clients SHALL create a new Goal and its membership for the current work Item atomically before projecting either mutation.

#### Scenario: User creates a Goal from Add to Goal
- **WHEN** the user opens `Добавить в цель`, chooses `Создать цель`, and submits a valid title
- **THEN** the client writes the Goal Activity create event and dependent `part_of` Relation create event in one Dexie transaction
- **AND** both events share the required causal ordering and survive reload, restart, or offline use
- **AND** the new Goal and membership appear optimistically only after that transaction commits

#### Scenario: Existing Goal is selected
- **WHEN** the user adds the current Item to one eligible Goal
- **THEN** the client appends one membership without removing existing memberships
- **AND** the picker excludes deleted, completed, and already-linked Goals

### Requirement: Deprecated client import paths are absent after cutover
Brai SHALL not keep deprecated previous-client import logic in the active Next.js/Capacitor boot path after cutover.

#### Scenario: Current client boots
- **WHEN** the Next.js/Capacitor client starts
- **THEN** it initializes from its own versioned local database
- **AND** does not read retired client sync envelopes
