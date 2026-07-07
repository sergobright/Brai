# Brai Admin Rules

`admin/` is the Brai technical admin panel inside the main Brai repository.

## Workflow

- Follow the parent Brai `AGENTS.md` branch, delivery, and security rules.
- Do not use or recreate a separate admin Git repository.
- `npm run live-deploy` is only a host-local helper: build current admin source, restart `brai-admin.service`, and check `127.0.0.1:3040`.

## Admin-Specific Rules

- Keep the admin UI read-only unless the project owner explicitly requests mutation.
- Production admin reads Postgres through `BRAI_DATABASE_URL`; do not add SQLite, local DB files, or fallback databases.
- Read tables, columns, indexes, and foreign keys from Postgres introspection; do not hardcode schema lists.
- Render SQL `NULL` and missing cell values as empty visible cells, not as the text `NULL`.
- For visible UI changes, reuse/sync parent primitives from `/srv/projects/brai/apps/brai_app/src/shared/ui` before adding admin-local UI code.
- Public route stays `admin.brightos.world` behind unified Caddy Basic Auth; the app binds only to localhost.
