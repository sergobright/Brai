## ADDED Requirements

### Requirement: Activity rows expose Focus controls
The Next.js/Capacitor client SHALL let the project owner start, switch, and stop
activity-linked Focus from Activity rows on desktop and mobile.

#### Scenario: Desktop inactive row shows Focus control
- **WHEN** the pointer hovers or keyboard focus enters an inactive Activity row
  on a desktop-sized viewport
- **THEN** a `Timer` Focus control appears before the delete control
- **AND** activating it starts or switches Focus to that Activity
- **AND** row height and title layout remain stable

#### Scenario: Desktop active row shows running timer
- **WHEN** an Activity owns the active Focus interval on a desktop-sized
  viewport
- **THEN** its row always shows the active timer without requiring hover
- **AND** the timer uses `H:MM` or `HH:MM`, no seconds, and tabular numerals
- **AND** hovering the timer changes the control content to `Стоп`
- **AND** activating `Стоп` queues action focus stop

#### Scenario: Mobile inactive row shows Focus control after swipe
- **WHEN** the user swipes an inactive Activity row left on an Android-sized
  viewport
- **THEN** the row controls include the `Timer` Focus control before delete
- **AND** activating it starts or switches Focus to that Activity

#### Scenario: Mobile active row stop is two-step
- **WHEN** an Activity owns the active Focus interval on an Android-sized
  viewport
- **THEN** its row always shows the active timer without requiring swipe
- **AND** the first tap changes the control to accent `Стоп`
- **AND** `Стоп` hides after a short timeout if the user does not press it
- **AND** tapping `Стоп` queues action focus stop

#### Scenario: Active action switches rows
- **WHEN** the active Focus interval switches from one Activity to another
- **THEN** the previous Activity row returns to its inactive Focus-control state
- **AND** the new Activity row immediately shows the running timer

### Requirement: Focus dock shows active elapsed time
The Next.js/Capacitor client SHALL show active Focus elapsed time in the main
dock without changing dock button dimensions.

#### Scenario: Focus dock is idle
- **WHEN** the main Focus timer is idle
- **THEN** the dock button shows the normal `Timer` icon

#### Scenario: Focus dock is active
- **WHEN** the main Focus timer is active
- **THEN** the dock button shows elapsed `H:MM` without seconds
- **AND** the button dimensions do not change between idle and active states
- **AND** a quiet rotating tick or dash treatment stays clipped inside the round
  button
- **AND** existing FloatingDock hover scaling remains intact

### Requirement: Focus history renders interval structure
The Next.js/Capacitor client SHALL render Focus history from session interval
data while preserving compact parent rows.

#### Scenario: Session has no action intervals
- **WHEN** a Focus history parent row represents only ordinary Focus intervals
- **THEN** the parent title is `В фокусе`
- **AND** the right icon is `Timer`

#### Scenario: Session has one action interval
- **WHEN** a Focus history parent row represents exactly one action interval
- **THEN** the parent title is the current Activity title
- **AND** the right icon is `SquareTerminal`

#### Scenario: Session has multiple action intervals
- **WHEN** a Focus history parent row represents two or more action intervals
- **THEN** the parent title is the longest activity interval title plus a `+N`
  indicator
- **AND** the right icon is `SquareTerminal`
- **AND** the row is collapsed by default

#### Scenario: Multi-interval session expands
- **WHEN** the user taps or clicks a collapsed multi-interval Focus history row
- **THEN** the row expands to show interval rows with title, start, duration,
  and finish
- **AND** `activity_id = NULL` interval rows show title `В фокусе`

### Requirement: Focus history edits interval rows
The Next.js/Capacitor client SHALL edit completed Focus intervals rather than
editing a multi-interval session as one time range.

#### Scenario: Single-interval session opens editor
- **WHEN** the user opens a completed Focus history row with exactly one
  interval
- **THEN** the inline editor may open under the parent row
- **AND** saving queues an edit for that interval

#### Scenario: Multi-interval session hides parent editor
- **WHEN** a Focus history row has multiple intervals
- **THEN** tapping the parent row expands or collapses intervals
- **AND** no parent time editor is shown

#### Scenario: Multi-interval row opens nested editor
- **WHEN** the user activates the pencil on a completed interval row
- **THEN** the inline editor opens visually under that interval row
- **AND** saving queues `edit_focus_interval` for that interval

#### Scenario: Active interval cannot be edited
- **WHEN** an interval is active
- **THEN** Focus history does not offer interval editing for that interval

#### Scenario: Interval edit bounds are enforced
- **WHEN** the user edits an interval start, end, or duration
- **THEN** the client prevents overlap with neighboring intervals in the same
  Focus session
- **AND** prevents crossing neighboring Focus session boundaries
- **AND** uses 1 minute as the manual input minimum duration
- **AND** uses 5 minute plus/minus step controls

#### Scenario: Multi-interval session delete is confirmed
- **WHEN** the user requests deletion of a multi-interval Focus session
- **THEN** the client shows inline confirmation
- **AND** confirmation queues `delete_session`
- **AND** the entire Focus session disappears from projected history

## MODIFIED Requirements

### Requirement: Focus history rows open an inline time editor
The Next.js/Capacitor client SHALL let the project owner edit completed
single-interval Focus history rows by tapping or clicking the row itself, while
multi-interval Focus sessions expose interval-level editors only.

#### Scenario: Focus history row opens
- **WHEN** the user taps or clicks a completed single-interval Focus history row
- **THEN** the row opens exactly one editor row below it
- **AND** the editor animates open to one row of height
- **AND** later rows move down rather than overlaying the editor
- **AND** the edit target is the row's interval

#### Scenario: Another row is opened
- **WHEN** one Focus history interval editor is open
- **AND** the user taps another editable Focus history row or interval
- **THEN** the current editor closes while the new editor opens
- **AND** a valid changed draft is saved before switching rows

#### Scenario: Start, duration, and finish are edited
- **WHEN** the Focus history interval editor is open
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
- **WHEN** the Focus history interval editor is open
- **THEN** the editor shows a discard close control, delete control, and save
  close control as a separate right-side action group
- **AND** tapping the discard close control closes the editor without queuing an
  edit or delete event

#### Scenario: Overlap attempt is blocked immediately
- **WHEN** a Focus history interval edit would overlap another Focus interval or
  neighboring Focus session
- **THEN** the client does not queue the edit
- **AND** the parent or interval row displays `Нельзя наложить на соседний
  фокус` with an alarm icon and 80% opaque accent background for 3 seconds
- **AND** the warning overlays the relevant row without changing row width, row
  height, or layout of later rows

#### Scenario: Focus history row is deleted
- **WHEN** the user taps the delete icon in an open single-interval Focus
  history editor
- **THEN** the client queues a `delete_session` event
- **AND** the row disappears from projected history without waiting for the
  server response

#### Scenario: Cross-day display chunks keep canonical identity
- **WHEN** a Focus session crosses a Europe/Moscow day boundary
- **THEN** history may display per-day chunks
- **AND** editing or deleting any chunk targets the canonical Focus session
  interval instead of creating separate physical sessions

