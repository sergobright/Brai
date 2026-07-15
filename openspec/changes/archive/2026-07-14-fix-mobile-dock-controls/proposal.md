# Fix mobile Dock controls

## Why

The mobile account dropdown is clipped behind the main Dock, and opening it hides the three-dot and arrow controls. The second Dock level also lays out its four actions against the full viewport instead of the same centered lane as the main row, while `SunMedium` is vertically offset from that row.

## What Changes

- Reserve the main Dock and Android safe area below the account dropdown, with shared scrolling only when the viewport is too short.
- Keep both edge controls visible and route close/switch actions through the shared mobile-sheet motion.
- Give both Dock rows the same centered four-button geometry and symmetric edge lanes.
- Align the separate `SunMedium` control with the upper row and directly above the arrow.

## Capabilities

### Modified capabilities

- `next-capacitor-client`: mobile dropdown visibility, Dock edge controls, layer switching, and second-row geometry.

## Impact

- Shared Next.js navigation shell and mobile navigation tests.
- OpenSpec and client UI guideline.
- No API, database, dependency, or native bridge changes.
