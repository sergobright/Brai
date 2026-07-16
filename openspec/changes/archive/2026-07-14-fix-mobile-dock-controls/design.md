# Design: mobile Dock controls and geometry

## Context

The account sheet reserves only the OS safe area, so its final item can sit behind the 52px main Dock. BraiApp also hides both edge controls whenever the left sheet is active. The second row uses five equal viewport columns for four actions, which shifts the action group left, and positions `SunMedium` independently from the row center.

## Decisions

### The account sheet reserves product chrome

Keep the sheet content-driven, but reserve the main Dock plus the OS safe area at its bottom. Use the existing local `ScrollArea` only when available height cannot show the entire account menu.

### Active sheets own their edge-control actions

Reuse the existing edge button component while an overflow sheet is active so the controls do not move or disappear. Repeated triggers and side switches close through the existing 200ms sheet motion before updating the active layer.

### Both Dock rows share one center lane

Use symmetric 68px edge lanes and a centered four-button group with the same 44px controls and 8px gaps as the main Dock. The right lane owns the separate context trigger; the left lane remains empty.

## Tradeoffs

- A side-to-side switch completes the current sheet exit before the next sheet enters, preserving one transform owner rather than adding a second animation system.
- Small or landscape viewports scroll the account menu instead of shrinking controls.
