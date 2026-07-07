# Shared UI Foundation

This folder is the Brai Admin source-owned shadcn-compatible UI layer.

- It mirrors the parent Brai UI foundation from `/srv/projects/brai/apps/brai_app/src/shared/ui`.
- Use these primitives for admin product surfaces before adding new component code.
- Parent primitives must be copied from the actual parent source before use. Do not replace them with simplified or visually similar local substitutes.
- Admin-only primitive differences must be listed here with the reason. They may adapt imports, dependencies, or strictly additive behavior, but must not change visual language or interaction principles without explicit approval.
- Do not create page-local visual systems for buttons, badges, cards, tables, scrolling surfaces, typography, colors, radii, or shadows.
- Redesign work must preserve existing admin UX patterns, including disclosure/collapsible sections, tab behavior, pagination placement, labels, ordering, and data visibility, unless the project owner explicitly asks to change those principles.
- Keep product colors on semantic Tailwind tokens such as `bg-background`, `bg-card`, `text-foreground`, `text-muted-foreground`, `border-border`, `border-input`, `ring-ring`, `bg-primary`, `text-primary-foreground`, `bg-muted`, and `bg-accent`.
- If a parent Brai primitive is needed here, copy its source-owned implementation into this folder and update this note.

## Imported From Parent Brai UI

- `animated-theme-toggler.tsx` is copied from the parent Brai shared UI component with only admin-local storage text adjusted.
- `collapsible.tsx` is copied from the parent Brai shared UI component.
- `card.tsx` is copied from the parent Brai shared UI component.
- `button.tsx`, `badge.tsx`, `scroll-area.tsx`, and `table.tsx` preserve the parent visual classes and scrolling behavior for the admin surface.
- `scroll-area.tsx` keeps the parent Brai Radix ScrollArea behavior and adds only an admin-local `scrollbars` selector so table overflow can use the same autohiding scrollbar chrome instead of native browser bars.
