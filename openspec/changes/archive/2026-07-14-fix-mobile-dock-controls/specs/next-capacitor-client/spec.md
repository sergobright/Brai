## MODIFIED Requirements

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

#### Scenario: The context grid is opened
- **WHEN** the user activates the separate `SunMedium` control
- **THEN** the 3x4 grid opens above the still-visible second level
- **AND** its closing motion is clipped behind that level and the main Dock
- **AND** Back, backdrop tap, backdrop swipe, or a repeated trigger closes only the context grid
