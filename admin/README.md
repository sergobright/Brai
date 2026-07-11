# Brai Admin

Read-only technical admin panel for Brai development data.

The live admin route is `/admin` inside each Brai environment:

- production: `https://app.brai.one/admin`;
- dev: `https://dev.brai.one/admin`;
- previews: `https://<slot>.test.brai.one/admin`.

Production admin uses the Brai account primary-user gate. Dev and preview
admin routes also sit behind unified Caddy Basic Auth.

## Commands

```bash
npm install
npm run self-check
npm run lint
npm run build
npm run start
```

The app reads Supabase/Postgres and the local Brai API from:

```text
BRAI_DATABASE_URL
BRAI_ADMIN_API_BASE
```

For local checks, point the app at a Postgres database:

```bash
BRAI_DATABASE_URL=postgres://user:pass@127.0.0.1:5432/brai_dev BRAI_ADMIN_API_BASE=http://127.0.0.1:3020 npm run dev
```

The UI discovers Postgres tables, columns, indexes, and foreign keys at runtime.

## Deploy

Admin source lives in the main Brai repository under `/admin/`. Source changes
follow the parent repository branch, PR, and delivery rules.
Deploy runs through the parent Brai environment flow and restarts the matching
`brai-admin*` service after the matching API service is healthy.
