# next-capacitor-client Specification

## Purpose
TBD - created by archiving change migrate-to-next-capacitor-local-first. Update Purpose after archive.
## Requirements
### Requirement: Next.js is the primary client platform
Brai SHALL use a Next.js, React, TypeScript, and Tailwind CSS client as the primary product UI for future web and Android app work.

#### Scenario: Web UI is implemented
- **WHEN** a product UI feature is added after the migration
- **THEN** it is implemented in the Next.js client
- **AND** it is available to both the web surface and the Capacitor Android surface unless the feature is explicitly web-only or native-only
- **AND** React components use Tailwind CSS utilities as the default styling mechanism

#### Scenario: Active client source is inspected
- **WHEN** a maintainer looks for the current product UI source
- **THEN** the canonical source is under `apps/brai_app`
- **AND** no retired client source tree is required for normal development, build, or deployment

### Requirement: Android app uses Capacitor over the same web bundle
Brai SHALL package the same built Next.js app into the Android application through Capacitor.

#### Scenario: Android APK is built
- **WHEN** the Android APK is built
- **THEN** it packages the same product UI and feature modules used by the web build
- **AND** Android-specific behavior is isolated behind platform adapters or native plugins

#### Scenario: New native capability is required
- **WHEN** a feature requires Android permissions, Capacitor plugins, Kotlin/native code, manifest changes, signing changes, or SDK changes
- **THEN** the feature requires an APK update
- **AND** the native dependency is documented before release

### Requirement: Responsive app UI is designed mobile-first
The Next.js client SHALL treat narrow Android phone viewports as a primary supported layout.

#### Scenario: A page or component is added
- **WHEN** a page, component, navigation pattern, control, chart, or form is added
- **THEN** it is verified on narrow mobile and desktop viewports
- **AND** text, controls, and dynamic content do not overlap or overflow their intended containers
- **AND** responsive styling is expressed with Tailwind utilities except for documented global/platform exceptions

#### Scenario: Navigation is rendered
- **WHEN** the client renders primary navigation
- **THEN** it shows `Действия` and `Фокус`
- **AND** it does not show `Цель` as a primary navigation item
- **AND** Android-sized viewports use a bottom navigation pattern with icon-only visible items
- **AND** desktop-sized web viewports use the narrow global navigation rail
- **AND** `Действия` is the first primary navigation item

#### Scenario: Mobile left page rail is opened from the header
- **WHEN** the client is shown on an Android-sized viewport
- **AND** the current page has `mobileRail` enabled in the page registry
- **AND** the user opens the burger menu from the page header
- **THEN** the page rail opens as a temporary drawer with a backdrop
- **AND** an otherwise empty rail displays `В разработке`
- **AND** tapping outside the drawer closes it
- **AND** horizontal tab swipes are disabled while the drawer is open

#### Scenario: Mobile Drop menu is opened
- **WHEN** the client is shown on an Android-sized viewport
- **AND** the user taps the bottom-left three-dot menu button
- **THEN** the Drop menu opens over the content with a backdrop
- **AND** it exposes the existing account and application actions
- **AND** tapping outside closes it
- **AND** horizontal tab swipes are disabled while it is open

#### Scenario: Mobile tabs are changed by horizontal swipe
- **WHEN** the client is shown on Android-sized viewports
- **AND** the user swipes horizontally across a non-excluded content area
- **THEN** the active bottom-navigation tab changes to the adjacent tab in the swipe direction
- **AND** the active and adjacent tab screens visually track the finger during the horizontal swipe
- **AND** the transition settles with a short transform animation after release
- **AND** vertically dominant gestures are treated as normal page scrolling
- **AND** content areas can opt out of tab-swipe navigation for their own horizontal gestures or scrolling

#### Scenario: Desktop global rail is compact and static
- **WHEN** the client is shown on a desktop-sized web viewport
- **THEN** the global navigation rail is rendered as a narrow static icon rail
- **AND** the rail has no expand/collapse control
- **AND** the rail keeps the sync status icon and preview environment badge
- **AND** the page header continues to show the current section icon

#### Scenario: Desktop page has no panel
- **WHEN** a desktop product page renders without an open panel
- **THEN** its shared page workspace spans the available shell
- **AND** its main content is centered with a maximum width of 768px
- **AND** compact modules may apply narrower limits inside that main content

#### Scenario: Desktop item details are opened
- **WHEN** an existing Action, Inbox item, or Factory log is explicitly selected
- **THEN** main and detail panel divide the available workspace 50/50
- **AND** the detail panel stretches vertically below the fixed header
- **AND** no resize control changes the split
- **AND** closing the detail removes the split when no persistent panel is active

#### Scenario: Markdown preview hides source markers
- **WHEN** an activity description preview is shown in the list
- **THEN** Markdown formatting markers such as heading hashes are not shown as source text
- **AND** heading markers are handled even when the user omits a space after `#`

### Requirement: Product behavior remains parity-compatible with first-stage workflows
The Next.js/Capacitor client SHALL preserve the current timer module workflows.

#### Scenario: Timer parity is verified
- **WHEN** the migration is ready for cutover
- **THEN** Timer, History, Goal, Settings, Russian copy, light/dark theme, offline pending state, and live reconciliation are available in the Next.js/Capacitor client
- **AND** accepted timer sync behavior is preserved

### Requirement: Capacitor Android loads the latest verified local web bundle
Brai Capacitor Android SHALL load the latest verified local OTA bundle when one exists, while retaining the bundled APK fallback.

#### Scenario: Verified OTA bundle exists
- **WHEN** the Android app starts
- **AND** a verified local OTA bundle exists
- **THEN** Capacitor loads that local bundle as the web layer

#### Scenario: Verified OTA bundle does not exist
- **WHEN** the Android app starts
- **AND** no verified local OTA bundle exists
- **THEN** Capacitor loads the web layer bundled inside the APK

### Requirement: Web layer reports startup readiness to Android
The Brai web layer SHALL provide a readiness signal for Android OTA activation.

#### Scenario: Web app boots successfully
- **WHEN** the web app has initialized the app shell and required client state
- **AND** it is running inside the Android native shell
- **THEN** it sends a readiness signal with the active bundle version to Android

#### Scenario: Web app runs in browser
- **WHEN** the web app runs as the browser web deployment
- **THEN** the readiness signal does not break browser startup
- **AND** the browser path does not require Android native APIs

### Requirement: Mobile OTA bundles remain static-export compatible
Brai mobile OTA bundles SHALL be compatible with local WebView loading from a static export.

#### Scenario: Mobile page is added
- **WHEN** a new ordinary client page is added for Android OTA delivery
- **THEN** it works from the mobile static bundle
- **AND** does not depend on server-side rendering, Next.js runtime server functions, or public app service ports

#### Scenario: API calls are made from Android
- **WHEN** the Android web layer calls Brai APIs
- **THEN** it uses the existing Android-compatible API configuration
- **AND** does not embed private Bearer tokens in the OTA bundle

#### Scenario: Markdown descriptions render in the client
- **WHEN** the client renders an Activity description preview
- **THEN** it renders supported Markdown through client-side React code
- **AND** it does not depend on server-side rendering or runtime server functions
- **AND** raw HTML in Markdown is not enabled

### Requirement: Activities UI supports fast capture and completion
The Next.js/Capacitor client SHALL provide a fast `Действия` list UI optimized for desktop and Android-sized viewports.

#### Scenario: Desktop activity is added
- **WHEN** the user types an activity into the desktop top input and presses Enter
- **THEN** the new activity appears immediately below the input

#### Scenario: Mobile activity is added
- **WHEN** the user taps the mobile floating plus button
- **THEN** a dimmed overlay opens with a focused input near the bottom of the viewport
- **AND** the user can add the activity with Enter or the send button
- **AND** the bottom navigation is not shown while the overlay is open
- **AND** the floating plus button remains fixed to the viewport when the `Действия` list scrolls

#### Scenario: Desktop activity details are edited
- **WHEN** the user clicks an existing activity title on desktop
- **THEN** a right-side editing panel opens and the main Actions area adapts around it
- **AND** the panel shows an editable title and a description field with placeholder `Введите описание`
- **AND** the panel can be closed with a visible close control or Escape
- **AND** entered text is saved locally before the panel closes

#### Scenario: Mobile activity details are edited
- **WHEN** the user taps an existing activity outside its checkbox and delete control on an Android-sized viewport
- **THEN** a full-screen editor opens
- **AND** the title field is focused with the cursor at the end
- **AND** the description field fills the space below the title and above the keyboard
- **AND** bottom navigation is hidden while the editor is open

#### Scenario: Mobile editor closes safely
- **WHEN** the user taps the check button, presses Back, swipes downward, switches app visibility, or the page hides
- **THEN** the current title and description are saved locally before the editor closes or the app leaves the foreground

#### Scenario: Description preview is shown in the list
- **WHEN** an activity description contains visible characters
- **THEN** the list shows one small single-line preview under the title
- **AND** whitespace and newlines are collapsed for the preview
- **AND** overflow fades at the end of the line

#### Scenario: Empty description does not reserve list space
- **WHEN** an activity description has no visible characters after whitespace normalization
- **THEN** the list does not reserve a description preview row for that activity

#### Scenario: Completed activities are grouped
- **WHEN** activities have status `Done`
- **THEN** they appear under a collapsible `Выполнено N` group
- **AND** completed activity titles use a visually completed treatment
- **AND** the group is not shown when there are no completed activities

#### Scenario: Desktop activity is deleted
- **WHEN** the pointer hovers or focuses an activity row on a desktop-sized viewport
- **THEN** a muted trash button appears in the row's reserved right area
- **AND** clicking it removes the activity with a smooth row-collapse animation

#### Scenario: Mobile activity delete menu is revealed
- **WHEN** the user swipes an activity row left on an Android-sized viewport
- **THEN** the row follows the finger during the drag
- **AND** after release the row returns to its normal position while the trash button remains visible on the right
- **AND** tapping outside the trash button hides it smoothly without completing, editing, or deleting the activity

#### Scenario: Mobile activity is deleted
- **WHEN** the mobile trash button is visible
- **AND** the user taps it
- **THEN** the activity is deleted with a smooth row-collapse animation
- **AND** rows below it shift upward smoothly

#### Scenario: Mobile Activities list is compact
- **WHEN** the `Действия` section contains only one new activity
- **THEN** the activity row uses only the height needed by the row content
- **AND** the page does not add empty scrollable space below the list
- **AND** completing the activity shows a checkmark in the checkbox

#### Scenario: Desktop activity is reordered
- **WHEN** the pointer hovers or focuses a `New` activity row on desktop
- **THEN** a muted drag handle appears to the left of the checkbox
- **AND** dragging the handle moves the row vertically with smooth neighbor movement
- **AND** dropping the row saves the new `New` activity order

#### Scenario: Desktop activity rows keep aligned controls and compact handles
- **WHEN** the user views `New` and `Done` activities on a desktop-sized viewport
- **THEN** visible row checkboxes align vertically across active and completed groups
- **AND** `New` rows show a muted standard drag handle to the left of the checkbox with minimal left spacing and reduced right spacing
- **AND** completed rows reserve the same drag-handle slot with an invisible non-interactive placeholder
- **AND** activity descriptions use standard muted, lighter-weight typography than the row title

#### Scenario: Mobile activity is reordered
- **WHEN** the user long-presses a `New` activity row on an Android-sized viewport
- **THEN** the row enters drag mode and can be moved vertically
- **AND** dropping the row saves the new `New` activity order
- **AND** a short tap still opens the detail editor
- **AND** a left swipe still reveals the delete button

#### Scenario: Completed activities remain grouped
- **WHEN** activities have status `Done`
- **THEN** they appear under a collapsible `Выполнено N` group
- **AND** completed activity titles use a visually completed treatment
- **AND** completed activities are not manually reordered

#### Scenario: Activity titles are bounded in list rows
- **WHEN** an activity title is longer than two visual lines in the list
- **THEN** the list row shows no more than two title lines
- **AND** title overflow is visually faded rather than spilling into later row content or the delete-control area
- **AND** the full title remains available in the detail editor

#### Scenario: Active desktop row highlight covers the full row
- **WHEN** an activity row is active on a desktop-sized viewport
- **THEN** the active visual background covers the content area and the reserved delete-control area as one continuous row
- **AND** the delete control remains independently clickable when visible

#### Scenario: Completed activity group header is compact and standard
- **WHEN** the completed activity group is visible
- **THEN** the `Выполнено` header is smaller than the main list row titles
- **AND** the completed count uses the primary color token
- **AND** the expand/collapse control uses a standard centered disclosure icon aligned to the header text

#### Scenario: Desktop title clicks choose inline caret placement or detail focus
- **WHEN** an activity row is active on a desktop-sized web viewport
- **AND** the user clicks directly on visible title text in the list row
- **THEN** inline list title editing starts immediately
- **AND** the text cursor is placed at the clicked text position
- **WHEN** the user clicks elsewhere inside the row outside visible title text
- **THEN** the existing detail-panel behavior is preserved
- **AND** the right detail title receives focus with the cursor at the end

#### Scenario: Activity title drafts mirror between list and detail editors
- **WHEN** an activity title is edited inline in the desktop list
- **THEN** the right detail panel title updates immediately while the same activity is open
- **WHEN** an activity title is edited in the right detail panel
- **THEN** the list row title updates immediately
- **AND** both edit directions continue to persist through the existing local-first activity save and sync flow

#### Scenario: Motion title transition source is required before use
- **WHEN** dynamic title transition behavior is implemented with Motion Primitives `text-effect`
- **THEN** the implementation uses the real source from `npx motion-primitives@latest add text-effect` or project owner's explicit URL
- **AND** no custom substitute is implemented from memory, screenshots, registry metadata, or a visually similar hand-built component
- **AND** unavailable, gated, rate-limited, or security-checkpointed source access is reported as a blocker

#### Scenario: Goal duration labels are compact
- **WHEN** Goal or Focus Goal panels render duration totals
- **THEN** they use compact labels such as `1ч 30м` or `12ч`
- **AND** hours have no leading zero
- **AND** minutes are omitted when the minute value is `0`

### Requirement: Activity detail descriptions support Markdown preview
The Next.js/Capacitor client SHALL let the project owner switch an Activity detail description between editable Markdown source and rendered Markdown preview.

#### Scenario: Desktop description preview is toggled
- **WHEN** an existing Activity is opened in the desktop detail panel
- **THEN** the top-right area shows an icon-only read/edit toggle
- **AND** the toggle is in edit-source mode when no global preview preference has been saved
- **AND** changing the toggle saves the global preview preference for later Activity detail editor openings
- **AND** while edit-source mode is active, the description is editable as plain Markdown source
- **AND** while read-preview mode is active, the current description is shown as formatted Markdown
- **AND** enabling preview flushes the current local description save before hiding the editor field

#### Scenario: Mobile description preview is toggled
- **WHEN** an existing Activity is opened in the mobile full-screen detail editor
- **THEN** the editor shows the same icon-only read/edit toggle
- **AND** the toggle uses the same saved global preview preference as desktop
- **AND** switching to read-preview mode hides the editable description field and keeps bottom navigation hidden
- **AND** switching to edit-source mode restores the editable description field with the same text

#### Scenario: Markdown preview keeps the safe renderer boundary
- **WHEN** Activity Markdown is rendered in full preview mode
- **THEN** it uses client-side React rendering from the source-owned Markdown renderer
- **AND** raw HTML is not enabled
- **AND** no new Markdown parsing dependency is required

### Requirement: Settings opens the Activities Archive
The Next.js/Capacitor client SHALL expose archived Activities from Settings.

#### Scenario: Archive entry is shown
- **WHEN** the client renders Settings
- **THEN** it shows an `Архив` block
- **AND** the block has a control that opens the Archive page

#### Scenario: Archived activity is restored
- **WHEN** the user opens `Архив`
- **AND** restores an archived activity
- **THEN** the row collapses from Archive
- **AND** the activity appears at the top of `Действия`
- **AND** the restore control uses the row's reserved right-side action area

### Requirement: Shared section headers own contextual actions
Brai section headers SHALL provide the standard location and spacing for section-specific contextual actions.

#### Scenario: Header contextual actions render
- **WHEN** a section exposes contextual actions
- **THEN** those action icons render in the section header to the left of the sync status
- **AND** the sync status remains the rightmost header icon
- **AND** each action has an accessible label
- **AND** an active contextual action exposes an accessible active state

#### Scenario: Header spacing is applied
- **WHEN** any current or future primary section renders inside the app shell
- **THEN** the desktop top inset above the header is `14px`
- **AND** the mobile safe-area/top inset behavior remains unchanged
- **AND** the gap below the header is `8px` on desktop and mobile
- **AND** the spacing is implemented as shared shell/header behavior rather than per-section offsets

### Requirement: Focus owns Goal and History panels
The Focus section SHALL own Goal and History as mutually exclusive contextual panels.

#### Scenario: Focus header exposes Goal and History icons
- **WHEN** the client renders the `Фокус` header
- **THEN** it shows a `Crown` icon for `Цель`
- **AND** it shows the existing History icon for `История`
- **AND** those icons render before the sync status

#### Scenario: Focus context panels are mutually exclusive
- **WHEN** the user opens `Цель` from the Focus header
- **THEN** the Goal panel is active
- **AND** the History panel is closed
- **AND** the Goal icon is marked active
- **WHEN** the user opens `История`
- **THEN** the History panel is active
- **AND** the Goal panel is closed
- **AND** the History icon is marked active
- **WHEN** the user activates the currently active panel icon again
- **THEN** both Focus context panels are closed

#### Scenario: Desktop Focus panel preference persists
- **WHEN** the client is shown on a desktop-sized viewport
- **AND** the user changes the active Focus context panel
- **THEN** the client persists `goal`, `history`, or `none` as a lightweight local UI preference
- **AND** reloading Focus restores the same desktop panel state

#### Scenario: Desktop Focus starts without a context panel
- **WHEN** the client is shown on a desktop-sized viewport
- **AND** the user opens `Фокус` without a saved panel preference
- **THEN** the main Focus workspace shows the timer centered vertically and horizontally
- **AND** no History or Goal panel is open by default

#### Scenario: Focus timer is centered with no panel
- **WHEN** the Focus desktop panel preference is `none`
- **THEN** the timer block occupies the main Focus position centered vertically and horizontally
- **AND** the clock digits are centered inside the timer block
- **AND** the running/waiting text label is not shown

#### Scenario: Desktop Focus opens History as a context panel
- **WHEN** the client is shown on a desktop-sized viewport
- **AND** the user opens the History header icon from `Фокус`
- **THEN** the workspace splits into a timer half and a History half
- **AND** the History half shows the existing timer history groups

#### Scenario: Mobile Focus opens History as a bottom sheet
- **WHEN** the client is shown on an Android-sized viewport
- **AND** the user opens the History header icon from `Фокус`
- **THEN** the timer remains the main content
- **AND** History opens as a bottom sheet with a grabber
- **AND** the sheet closes by downward swipe
- **AND** the sheet does not require a visible close button
- **AND** tab swipe navigation is disabled while the sheet is open

#### Scenario: Mobile Focus opens Goal as a bottom sheet
- **WHEN** the client is shown on an Android-sized viewport
- **AND** the user opens the Goal header icon from `Фокус`
- **THEN** Goal opens as a bottom sheet with a grabber
- **AND** the sheet closes by downward swipe
- **AND** the sheet does not require a visible close button
- **AND** tab swipe navigation is disabled while the sheet is open

### Requirement: Focus has a canonical route
The Next.js/Capacitor client SHALL expose `Фокус` at `/focus`.

#### Scenario: Focus is opened
- **WHEN** the user opens `Фокус`
- **THEN** the browser address is `/focus`

#### Scenario: Non-Focus primary section is opened
- **WHEN** the user leaves `Фокус` for another primary section
- **THEN** the browser address returns to `/`

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

### Requirement: Settings manage account AI providers
The shared Web/Android settings UI SHALL list masked account provider credentials and
allow authenticated users to add, replace, and delete them and configure text and vision
profiles without persisting plaintext credentials in browser storage.

#### Scenario: Account providers are configured
- **WHEN** an authenticated user opens model settings
- **THEN** the UI shows connected providers with masked hints and verification metadata
- **AND** it offers provider/model selectors for text and vision
- **AND** it explains disabled external-mode or delete actions

#### Scenario: A provider returns a long model list
- **WHEN** Web or Android opens a provider model selector with more items than fit on screen
- **THEN** the shared selector keeps the list inside a bounded scrolling viewport
- **AND** mouse-wheel, touch, and keyboard scrolling remain available

### Requirement: Account credentials synchronize through native Android code
Brai Android SHALL synchronize account provider credentials through the native boundary
without returning synchronized plaintext keys to React or the WebView.

#### Scenario: Authenticated Android app synchronizes
- **WHEN** a user-bound account token is activated or the app returns online/foreground
- **THEN** native code imports eligible local keys and refreshes account key copies
- **AND** Brai CMD keeps speech and post-processing model choices device-local

#### Scenario: An account key is deleted after local import
- **WHEN** an account provider key is explicitly deleted after the device already offered
  the same anonymous local key to that account
- **THEN** native code removes the account copy from its canonical set
- **AND** later syncs or app restarts do not silently re-import that unchanged local key
- **AND** the original anonymous key remains available after logout

#### Scenario: Native account access is activated
- **WHEN** an authenticated Android WebView provisions account access
- **THEN** the browser receives only a short-lived one-time link token
- **AND** Kotlin activates it with the existing device credential
- **AND** only native code receives and stores the user-bound account token
- **AND** React and the WebView never receive that account token

#### Scenario: Account changes while native synchronization is pending
- **WHEN** Android begins switching from one authenticated account to another
- **THEN** it removes the previous user-bound token from normal request use before changing the account boundary
- **AND** no local provider candidate can be imported into the previous account on behalf of the next account

#### Scenario: Canonical credential refresh fails
- **WHEN** Android cannot complete an account credential sync after an account key mutation
- **THEN** native code clears cached account credential copies
- **AND** Brai CMD fails explicitly until automatic synchronization succeeds
- **AND** it never falls back to an anonymous local key while the account boundary is active

#### Scenario: Android calls a provider directly
- **WHEN** Brai CMD uses an anonymous or account-synchronized provider key
- **THEN** the key is sent in an authorization header
- **AND** the key is absent from the provider request URL

#### Scenario: Browser calls a native-only account endpoint
- **WHEN** a request to account activation, credential sync, or self-revoke has browser-origin headers
- **THEN** Brai rejects it without returning account credentials or a user-bound token

#### Scenario: Logout self-revoke is temporarily offline
- **WHEN** Android cannot reach the self-revoke endpoint during logout or account switch
- **THEN** it isolates the encrypted token for revoke-only retries
- **AND** the token is never used for normal account requests
- **AND** online or foreground lifecycle retries revocation until the server accepts it

### Requirement: Engine exposes explicit human-readable update actions

The client SHALL describe discovery, web download, and APK download without user-facing OTA terminology.

#### Scenario: An update state is rendered
- **WHEN** Engine is idle, checking, available, downloading, ready, or requires an APK
- **THEN** its action text and icon match the current operation
- **AND** the latest successful check time appears beside the action
- **AND** user-visible Engine text contains no `OTA`

#### Scenario: Native APK bridge is unavailable
- **WHEN** an APK is required and `downloadApk()` is unavailable
- **THEN** the client opens the installed channel's direct public download URL externally

### Requirement: Navigation supports supplementary status indicators

Navigation controls SHALL accept an arbitrary supplementary React node positioned without changing control geometry.

#### Scenario: A navigation item has an indicator
- **WHEN** an item supplies supplementary content without a position override
- **THEN** it is absolutely positioned at the bottom-right
- **AND** the control retains its original layout dimensions

#### Scenario: Engine has any update
- **WHEN** a web or APK update is available
- **THEN** desktop and mobile Engine icons change from processor to download
- **AND** a small yellow indicator appears at bottom-right
- **AND** the download icon animates during downloads unless reduced motion is preferred

#### Scenario: A hidden mobile item has an indicator
- **WHEN** Engine in the mobile overflow menu has an update
- **THEN** the three-dot button displays an aggregate yellow indicator at bottom-center
- **AND** the three-dot icon does not move

### Requirement: Product sections use one page shell
Brai SHALL render authenticated product sections through one shared responsive page-shell contract.

#### Scenario: A page has no open panel
- **WHEN** a product section renders without a persistent or transient panel
- **THEN** its main content is centered in the available workspace
- **AND** its desktop maximum width is 768px
- **AND** its opaque fixed header remains visible above independently scrolling content
- **AND** exactly one shared `ScrollArea` renders the standard scrollbar instead of a raw browser overflow scrollbar or a nested duplicate scroll viewport

#### Scenario: A page has an open panel
- **WHEN** a persistent panel or explicitly selected item detail is open on desktop
- **THEN** main and panel use equal halves of the workspace
- **AND** the panel does not overlay the main area
- **AND** no page-specific resize control changes the split

#### Scenario: A page panel opens on mobile
- **WHEN** a panel is opened on an Android-sized viewport
- **THEN** the shared bottom sheet starts below the fixed page header
- **AND** the header remains visible

#### Scenario: A fullscreen page override is active
- **WHEN** Draws enters fullscreen mode
- **THEN** the page workspace removes its centered maximum width and insets
- **AND** Draws fills all available width and height while product chrome is hidden

### Requirement: Page panels distinguish persistent and transient state
Brai SHALL restore persistent page panels and SHALL NOT restore transient item details.

#### Scenario: Focus panel is selected
- **WHEN** the user selects Goal or History in Focus
- **THEN** the selection is stored locally per account
- **AND** selecting the active icon closes it
- **AND** the stored selection can be restored after restart

#### Scenario: Item details are opened
- **WHEN** the user explicitly selects an Action, Inbox item, or Factory log
- **THEN** its details temporarily occupy the panel area
- **AND** closing details restores the previous persistent panel or the centered main area
- **AND** no item detail opens automatically after page load or restart

### Requirement: Page rails follow the page registry
Brai SHALL define desktop and mobile rail availability centrally for every product section.

#### Scenario: A standard rail page has no rail content
- **WHEN** Actions, Inbox, Factory, Draws, Archive, or Settings has no registered rail content
- **THEN** the rail displays `В разработке`

#### Scenario: A rail-free page is shown
- **WHEN** Focus, Engine, or Profile is shown
- **THEN** no desktop rail or mobile rail trigger is rendered

#### Scenario: Brai CMD is shown in browser web
- **WHEN** Brai CMD runs without the Android native settings surface
- **THEN** it remains informational
- **AND** it has no page rail

#### Scenario: Brai CMD is shown in Android
- **WHEN** Brai CMD runs with the Android native settings surface
- **THEN** its mobile rail offers Основное, Разрешения, Контекстные кнопки, Внешний вид, Распознавание, Постобработка, and Аудио
- **AND** choosing a group changes the main settings content and closes the drawer

#### Scenario: A persisted closed rail page is opened
- **WHEN** the user navigates to a page whose desktop rail preference is closed
- **THEN** no frame renders that rail as open
- **AND** the main workspace does not shift after the page appears

### Requirement: Global context items are consistent
Brai SHALL render the same twelve future-context placeholders in desktop and mobile chrome.

#### Scenario: Desktop context menu is rendered
- **WHEN** the desktop app shell is visible
- **THEN** its narrow global menu shows twelve inactive Lucide controls
- **AND** every control reacts to pointer/focus state, exposes `В разработке`, and performs no navigation

#### Scenario: Mobile context menu is opened
- **WHEN** the user opens the second Dock level and activates its context trigger
- **THEN** a separate sheet opens above that level
- **AND** it shows the same items in a 3×4 grid
- **AND** closing it returns to the still-open second Dock level

### Requirement: Mobile overlays use one dismissible motion contract
Brai SHALL animate dismissible mobile overlays through one shared transform-and-opacity motion contract.

#### Scenario: A mobile overlay opens or closes
- **WHEN** a page sheet, drawer, Dock level, or context grid changes visibility
- **THEN** one transform owner performs a symmetric 200ms transition
- **AND** no competing keyframe changes the same transform
- **AND** reduced-motion preference removes the transition

#### Scenario: A dismissal swipe starts outside the surface
- **WHEN** the user starts a directional closing swipe on the active overlay backdrop
- **THEN** the active surface tracks the gesture and closes after the shared threshold
- **AND** unrelated horizontal page navigation does not run

### Requirement: Mobile Dock levels form one visual stack
Brai SHALL render the mobile Dock, its overflow sheets, second level, and context grid as contiguous clipped layers with persistent edge controls.

#### Scenario: The account dropdown is opened
- **WHEN** the user activates the left three-dot control
- **THEN** the dropdown reserves the main Dock and Android safe area below its content
- **AND** every account action including `Выход` is visible without scrolling on a standard portrait Android viewport
- **AND** a shorter viewport can scroll the menu without placing content behind the Dock
- **AND** the three-dot and arrow controls remain visible in their original positions

#### Scenario: The account dropdown is toggled or replaced
- **WHEN** the user activates the three-dot control again
- **THEN** the dropdown closes through the shared mobile-sheet motion
- **WHEN** the user activates the right arrow while the dropdown is open
- **THEN** the dropdown closes through the same motion and the second Dock level opens

#### Scenario: The second Dock level is opened
- **WHEN** the user activates the right Dock arrow
- **THEN** the level slides from behind the main Dock without a gap or internal divider
- **AND** its four action controls use the same centers, 44px control size, and 8px gaps as the four main Dock controls
- **AND** equal 68px edge lanes are reserved on both sides
- **AND** a separate `SunMedium` control is vertically centered in the second row and horizontally centered directly above the right arrow
- **AND** `SunMedium` is a descendant of the second level's transform owner and exits in the same motion

#### Scenario: The context grid is opened
- **WHEN** the user activates the separate `SunMedium` control
- **THEN** the 3x4 grid opens above the still-visible second level
- **AND** its closing motion is clipped behind that level and the main Dock
- **AND** Back, backdrop tap, backdrop swipe, or a repeated trigger closes only the context grid

### Requirement: Mobile page headers use compact action controls
Brai SHALL keep the fixed mobile page header compact while preserving accessible touch targets.

#### Scenario: Mobile panel actions are rendered
- **WHEN** a mobile page header shows panel, environment, or status controls
- **THEN** each visible control occupies a consistent 32px box with a 20px icon
- **AND** interactive controls retain at least a 44px touch target

### Requirement: Evil Eye is not a product section
Brai SHALL retain Evil Eye only as a Focus background option.

#### Scenario: Static product routes are built
- **WHEN** the Next.js client is exported
- **THEN** no `/evil-eye` page or section identifier exists
- **AND** the Focus Evil Eye background remains available

### Requirement: Transient authentication outages preserve local account scope

The Brai client SHALL distinguish an unavailable auth backend from an authoritative anonymous session.

#### Scenario: Session revalidation receives a transient backend failure

- **WHEN** session revalidation or a protected request receives a network failure or `5xx`
- **THEN** the client preserves the current user id, IndexedDB snapshots, pending outbox, and current screen
- **AND** it exposes a recoverable offline or sync-failed state
- **AND** it does not navigate to `/auth`

#### Scenario: Session absence is authoritative

- **WHEN** session revalidation succeeds with an authoritative anonymous result or a protected request returns a genuine `401`
- **THEN** the client clears the authenticated account scope and navigates to the login flow

### Requirement: Engine exposes complete version history through the shared page shell

The Next.js/Capacitor client SHALL expose public version history from Engine
without placing history below the current-version card or creating a
page-specific panel implementation.

#### Scenario: Desktop user opens Engine history
- **WHEN** the user activates the History icon in the Engine top bar on a desktop viewport
- **THEN** the accepted `PageWorkspace` opens version history in its persistent right panel
- **AND** the current Engine card remains in the main column
- **AND** the History control exposes its active state accessibly

#### Scenario: Mobile user opens Engine history
- **WHEN** the user activates the same History icon on a mobile viewport
- **THEN** the same history content opens in the shared `MobileContextSheet`
- **AND** Android Back, backdrop close, and downward drag use the shared sheet behavior
- **AND** Engine does not create another drawer, modal, or sheet primitive

#### Scenario: Version history is browsed
- **WHEN** history contains more than one page or more than one version type
- **THEN** the user can filter by All or a specific type and progressively load older versions
- **AND** each version exposes summary, reason, ordered details, work identity, PR links, complete expandable PR metadata, and refs
- **AND** loading, retryable error, empty, and no-PR states are explicit

#### Scenario: Pull request body is displayed
- **WHEN** the user expands full PR metadata
- **THEN** the complete body is escaped or rendered as sanitized Markdown
- **AND** raw HTML and executable content are not enabled

### Requirement: Engine version cards expose platform-aware state

Version history SHALL distinguish the Product work ledger from platform
release ledgers and SHALL render release time separately from installation
state.

#### Scenario: A version card is rendered
- **WHEN** Engine renders a version in the history list or detail header
- **THEN** the first row contains a state icon, accent-colored version number, and title
- **AND** the second row contains the type badge on the left and release date and time in the user's configured display timezone on the right
- **AND** a separate `Версия N` badge and a hard-coded timezone suffix are not rendered

#### Scenario: Web determines version state
- **WHEN** version history is viewed from browser web
- **THEN** only Product versions are compared with the installed Product baseline
- **AND** installed Product versions use the done icon and newer Product versions use the timer icon
- **AND** Android APK, macOS, and iOS versions use the information icon because they do not apply to browser web

#### Scenario: Android determines version state
- **WHEN** version history is viewed from the Android application
- **THEN** Product versions are compared with the installed Product baseline
- **AND** Android APK versions are compared with the installed native APK version
- **AND** macOS and iOS versions use the information icon

#### Scenario: Installed baseline is unknown
- **WHEN** an applicable version cannot be compared with a proven installed baseline
- **THEN** the information icon explains that state
- **AND** the client does not present the version as installed or available by guessing from the newest API row
