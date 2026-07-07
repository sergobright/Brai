# Brai Admin

Read-only technical admin panel for Brai development data.

## Commands

```bash
npm install
npm run self-check
npm run lint
npm run build
npm run start
npm run live-deploy
```

The app reads Supabase/Postgres from:

```text
BRAI_DATABASE_URL
```

For local checks, point the app at a Postgres database:

```bash
BRAI_DATABASE_URL=postgres://user:pass@127.0.0.1:5432/brai_dev npm run dev
```

The UI discovers Postgres tables, columns, indexes, and foreign keys at runtime.

## Live deploy

Admin source lives in the main Brai repository under `/admin/`. Source changes
follow the parent repository branch, PR, and delivery rules.

`npm run live-deploy` is a host-local operational helper. It builds Next.js,
restarts `brai-admin.service`, and checks the local admin HTTP endpoint.
