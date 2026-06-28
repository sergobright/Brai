## ADDED Requirements

### Requirement: Focus history rows open an inline time editor
The Next.js/Capacitor client SHALL let the project owner edit completed Focus
history rows by tapping or clicking the row itself instead of a pencil icon.

#### Scenario: Focus history row opens
- **WHEN** the user taps or clicks a completed Focus history row
- **THEN** the row opens exactly one editor row below it
- **AND** the editor animates open to one row of height
- **AND** later rows move down rather than overlaying the editor
- **AND** no pencil edit control is rendered

#### Scenario: Another row is opened
- **WHEN** one Focus history row editor is open
- **AND** the user taps another Focus history row
- **THEN** the current editor closes while the new row opens
- **AND** a valid changed draft is saved before switching rows

#### Scenario: Start, duration, and finish are edited
- **WHEN** the Focus history row editor is open
- **THEN** it shows start time, duration, and finish time in that order
- **AND** each value is visually grouped under its own short label
- **AND** each value can be changed by 5 minute plus/minus controls
- **AND** clicking a value turns it into an input with check and cancel controls
- **AND** valid `H:MM` and `HH:MM` inputs normalize to `HH:MM`
- **AND** changing start shifts finish by the same delta
- **AND** changing finish keeps start and recalculates duration
- **AND** changing duration shifts finish
- **AND** unchanged duration keeps the normal duration accent color
- **AND** changed direct and derived values use a separate changed-value color

#### Scenario: Focus history editor is closed without saving
- **WHEN** the Focus history row editor is open
- **THEN** the editor shows a discard close control, delete control, and save
  close control as a separate right-side action group
- **AND** tapping the discard close control closes the editor without queuing an
  edit or delete event

#### Scenario: Overlap attempt is blocked immediately
- **WHEN** a Focus history edit would overlap another Focus session
- **THEN** the client does not queue the edit
- **AND** the parent row displays `Нельзя наложить на соседний фокус` with an
  alarm icon and 80% opaque accent background for 3 seconds
- **AND** the warning overlays the parent row without changing the row width,
  row height, or layout of later rows

#### Scenario: Focus history row is deleted
- **WHEN** the user taps the delete icon in the open Focus history editor
- **THEN** the client queues a `delete_session` event
- **AND** the row disappears from projected history without waiting for the
  server response

#### Scenario: Cross-day display chunks keep canonical identity
- **WHEN** a Focus session crosses a Europe/Moscow day boundary
- **THEN** history may display per-day chunks
- **AND** editing or deleting any chunk targets the single canonical Focus
  session instead of creating separate physical sessions
