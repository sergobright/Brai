# Refine unified page shell motion

## Why

The first unified shell used a 1024px main column instead of the accepted Codex-like width, briefly rendered persisted closed rails as open, constrained Draws fullscreen, and combined CSS keyframes with gesture transforms on mobile overlays. The overlapping animation systems cause visible gaps, jumps, and asymmetric dismissal.

## What Changes

- Set the shared panel-free desktop content width to 768px and provide an explicit full-bleed shell override.
- Restore persisted rail geometry before paint so closed rails do not flash during navigation.
- Make mobile header actions visually compact without shrinking their touch target.
- Make one shared gesture primitive own enter, drag, settle, and exit motion for mobile overlays.
- Rebuild the mobile Dock layers so the second level is contiguous, the context trigger is separate, and upper sheets move behind lower layers.

## Capabilities

### Modified capabilities

- `next-capacitor-client`: shared page geometry, Draws fullscreen, persisted rails, mobile header controls, Dock layers, and dismissible overlay motion.

## Impact

- Next.js client shell, navigation, shared mobile-sheet hook, Draws state ownership, and UI tests.
- OpenSpec, client guideline, and the unified-shell ADR.
- No API, database, dependency, or native bridge changes.
