# Design: refined unified page shell motion

## Context

The shared shell currently caps panel-free content at 1024px, while the accepted reference is a 768px outer column. Draws fullscreen still passes through that cap. Rail preferences use a post-render timeout, and mobile sheets apply both a CSS keyframe and the transform owned by `useMobileSheetDrag`.

## Decisions

### Page geometry stays in the shared shell

Panel-free content uses a 768px maximum. A `fullBleed` override disables centering and the maximum only for explicit fullscreen modes. Draws fullscreen state is controlled by the app shell so chrome visibility and geometry change in the same render.

### Persisted rail state has no optimistic open fallback

The current page key reads its cached open state and width synchronously. Asynchronous server preference reconciliation may update the shared width later, but navigation never substitutes `open: true` while the new key is unresolved.

### One transform owns mobile motion

`useMobileSheetDrag` owns initial entry, interactive drag, settling, and exit using transform and opacity only. Overlay roots receive the gesture listeners so a directional swipe that starts on the backdrop can dismiss the active layer. Existing per-component keyframes are removed.

### Dock levels are a clipped stack

The main Dock is the foreground layer. The second level is clipped behind it and touches it without an internal border. Its four existing actions remain in place, while `SunMedium` is a separate control aligned above the right arrow. The context grid is clipped behind the second level, which remains visible while the grid opens or closes.

## Tradeoffs

- Motion uses one fixed 200ms easing contract rather than per-sheet tuning.
- A full-bleed mode is an explicit shared-shell option; pages cannot create local fullscreen width exceptions.

## Migration

1. Update shared geometry and Draws state ownership.
2. Replace delayed rail fallbacks with synchronous cached values.
3. Move mobile overlays to the single motion owner and rebuild Dock stacking.
4. Update tests and canonical documentation.
