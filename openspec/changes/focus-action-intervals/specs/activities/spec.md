## ADDED Requirements

### Requirement: Activities can be linked to Focus intervals
Bright OS SHALL allow Focus intervals to reference Activities without requiring
timer event replay to fail when Activity sync state arrives later.

#### Scenario: Activity interval is returned in history
- **WHEN** a Focus interval references an existing Activity
- **THEN** history can display the current Activity title for that interval
- **AND** the interval remains part of its parent Focus session totals

#### Scenario: Activity is missing during timer replay
- **WHEN** an accepted timer event references an `activity_id` that is not
  currently present in canonical Activities storage
- **THEN** timer replay keeps the Focus interval linked to that `activity_id`
- **AND** does not reject the timer event only because the Activity is missing

### Requirement: Deleted Activities remain available for Focus history titles
Bright OS SHALL provide enough Activity lookup data for Focus history to display
current titles of active, archived, and deleted Activities when those records
are available.

#### Scenario: Deleted activity appears in Focus history
- **WHEN** a Focus interval references an Activity that has been deleted or
  archived
- **THEN** session history can still resolve and display that Activity's current
  title
- **AND** the Activity does not reappear in the active Activities list

#### Scenario: Activity title changes after focus
- **WHEN** an Activity title is changed after a Focus interval has been recorded
- **THEN** Focus history displays the current Activity title
- **AND** it does not display a snapshot title from the time of focus

### Requirement: Deleting an active Activity preserves the main Focus timer
Bright OS SHALL close an active interval for a deleted Activity without stopping
the parent Focus session when the session was not started by that Activity stop
flow.

#### Scenario: Active activity is deleted during Focus
- **WHEN** the user deletes an Activity that owns the current active Focus
  interval
- **THEN** the Activity is removed from the active Activities list
- **AND** the linked active interval is closed
- **AND** the parent Focus session continues with an ordinary `activity_id =
  NULL` interval

