## MODIFIED Requirements

### Requirement: Inbox records incoming items
Brai SHALL preserve the original user-provided Inbox text independently from
normalized title and description fields.

#### Scenario: User creates a text Inbox record
- **WHEN** the user submits a non-empty line in the Inbox interface
- **THEN** the exact captured text is stored in `explanation_text`
- **AND** `source` identifies `brai-app`
- **AND** `source_key` identifies the stable client device
- **AND** later normalization does not overwrite `explanation_text`

#### Scenario: An older client sends only a title
- **WHEN** a UI sync create event has no explicit raw text or provenance
- **THEN** the server uses its title as `explanation_text`
- **AND** derives UI provenance from the event device
- **AND** external Inbox API provenance semantics remain unchanged

#### Scenario: Raw semantic input is empty
- **WHEN** text, description, and image input are all empty
- **THEN** the workflow becomes `needs_review` with `raw_input_empty`
- **AND** no normalizer AI execution is created

#### Scenario: Text contains an obvious typo
- **WHEN** normalization receives a non-empty user intent with named entities
- **THEN** the normalized title and description preserve that intent and those entities
- **AND** the model may correct obvious spelling errors
- **AND** it does not describe the record as empty
