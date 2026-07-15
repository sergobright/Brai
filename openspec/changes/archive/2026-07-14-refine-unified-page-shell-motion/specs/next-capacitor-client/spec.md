## MODIFIED Requirements

### Requirement: Product sections use one page shell
Brai SHALL render authenticated product sections through one shared responsive page-shell contract.

#### Scenario: A page has no open panel
- **WHEN** a product section renders without a persistent or transient panel
- **THEN** its main content is centered in the available workspace
- **AND** its desktop maximum width is 768px
- **AND** its opaque fixed header remains visible above independently scrolling content

#### Scenario: A page has an open panel
- **WHEN** a persistent panel or explicitly selected item detail is open on desktop
- **THEN** main and panel use equal halves of the workspace
- **AND** the panel does not overlay the main area
- **AND** no page-specific resize control changes the split

#### Scenario: A fullscreen page override is active
- **WHEN** Draws enters fullscreen mode
- **THEN** the page workspace removes its centered maximum width and insets
- **AND** Draws fills all available width and height while product chrome is hidden

### Requirement: Page rails follow the page registry
Brai SHALL resolve each page rail from the registry and its persisted account preference without transient fallback geometry.

#### Scenario: A persisted closed rail page is opened
- **WHEN** the user navigates to a page whose desktop rail preference is closed
- **THEN** no frame renders that rail as open
- **AND** the main workspace does not shift after the page appears

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
Brai SHALL render the mobile Dock, its second level, and the context grid as contiguous clipped layers.

#### Scenario: The second Dock level is opened
- **WHEN** the user activates the right Dock arrow
- **THEN** the level slides from behind the main Dock without a gap or internal divider
- **AND** it contains the four existing action icons
- **AND** a separate `SunMedium` control is aligned directly above the right arrow

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
