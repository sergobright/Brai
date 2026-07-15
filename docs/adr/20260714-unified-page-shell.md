# ADR: Unified product page shell

- Status: Accepted
- Date: 2026-07-14
- Decision makers: Product owner

## Context

Product sections independently implemented headers, maximum widths, split panels, resizers, and mobile sheets. This created empty panel space, automatic Factory selection, and page-specific behavior that future sections could copy incorrectly.

## Decision

Use one shared page workspace for authenticated product sections. It owns an opaque fixed header, a centered 768px main column without a panel, an explicit full-bleed override, and an equal 50/50 desktop split when a persistent or transient panel exists. Mobile panels reuse the shared sheet below the header.

Keep persistent panels separate from transient item details. Define desktop/mobile page-rail policy in one registry. Render global Dock, dropdown, and twelve future-context placeholders from shared navigation data. Browser Brai CMD remains informational; Android Brai CMD uses a mobile settings rail. Remove the standalone Evil Eye section while keeping its Focus background.

One shared gesture primitive owns enter, drag, settle, and exit transforms for dismissible mobile overlays. Mobile Dock levels form a clipped stack: the main Dock stays visible, the second level is contiguous behind it, and the context grid moves behind the still-visible second level.

## Consequences

- Sections supply content and panel state instead of owning workspace geometry.
- Resizable Actions, Inbox, and Factory splits are removed.
- New pages use the registry and shared shell by default; deviations wrap the shared component rather than fork it.
- Draws fullscreen remains an explicit overlay exception.
- Persisted closed rails are resolved without an optimistic open frame.
- No API, database, native bridge, or dependency migration is required.
