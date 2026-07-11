# Brai Admin Rules

`admin/` is the Brai technical admin panel inside the main Brai repository.

## Workflow

- Follow the parent Brai `AGENTS.md` branch, delivery, and security rules.
- Do not use or recreate a separate admin Git repository.
- Admin deploys through the parent Brai environment flow, not a standalone admin helper.

## Admin-Specific Rules

- Keep the admin UI read-only unless the project owner explicitly requests mutation.
- Production admin reads Postgres through `BRAI_DATABASE_URL`; do not add SQLite, local DB files, or fallback databases.
- Read tables, columns, indexes, and foreign keys from Postgres introspection; do not hardcode schema lists.
- Render SQL `NULL` and missing cell values as empty visible cells, not as the text `NULL`.
- For visible UI changes, reuse/sync parent primitives from `/srv/projects/brai/apps/brai_app/src/shared/ui` before adding admin-local UI code.
- Public route is `/admin` inside each Brai environment domain. Production uses the Brai account gate; dev and preview also use unified Caddy Basic Auth. Admin app services bind only to localhost.
