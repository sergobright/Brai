# UI, Shadcn, And Visual Rules

- Build product UI from local shadcn-compatible primitives, official shadcn sources, Radix primitives, or approved free/open registry source.
- Do not invent custom colors, fonts, radii, shadows, gradients, motifs, or decorative systems unless explicitly requested.
- Use semantic tokens and Tailwind/shadcn utilities for product surfaces.
- Use local `ScrollArea` for product scrolling surfaces.
- Product UI should stay compact, neutral, and usable on Android-sized and desktop viewports.
- Mobile bottom sheets and detail sheets must reuse the shared app chrome sheet/floating-close primitives; do not create per-section drag handles, backdrop shells, top-right close buttons, or pseudo-floating close buttons.
- Reproduced registry components must use the actual accepted source as the baseline; unavailable source is a blocker.
- Preserve existing Brai content and data wiring when replacing UI unless a content change is explicitly requested.
