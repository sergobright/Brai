# Brai

Brai is a local-first personal operating system for focused work. It brings daily actions, focus sessions, goals, history, and self-hosted sync into one web and Android app that keeps working when the network is unreliable.

The project is built around a simple rule: the device should remain useful first, and the server should sync state when it can. Local data is stored in the client outbox, then reconciled through the Brai API backed by Supabase Postgres.

## What Is Inside

- Local-first work tracking with durable client-side queues.
- A public Brai site served separately from the protected app.
- Focus, goal, history, archive, and activity views in one app shell.
- A Next.js web app that also ships inside a Capacitor Android wrapper.
- Android web-layer OTA updates for shipping UI fixes without rebuilding the APK.
- A self-hosted Brai API for sync, auth, health checks, and deployment metadata.
- Public-safe project rules, accepted specs, and deployment automation.

## Repository Layout

- `apps/brai_app/` - Next.js 16, React 19, Tailwind CSS, source-owned UI, and Capacitor Android.
- `apps/brai_site/` - static public site source for `brightos.world`.
- `services/brai_api/` - Node.js Brai API with Supabase Postgres storage and offline-first sync endpoints.
- `deploy/` - deployment scripts, Ansible playbooks, Caddy/systemd templates, and environment mapping.
- `docs/` - development guidelines, checklists, and operations notes.
- `openspec/specs/` - accepted product and workflow requirements.
- `memory-bank/` - public project context for future development sessions.

Runtime databases, server-only env files, APKs, OTA bundles, signing material, local backups, and generated release output stay outside Git.

## Requirements

- Node.js 22 or newer.
- npm for JavaScript dependencies.
- Android Studio, JDK, and Gradle for APK builds.
- Release signing variables only when building a production APK.

Brai commands use the workspace Node runtime under `/srv/opt/node-v22.16.0` when it is available.

## Development

Install dependencies:

```bash
npm ci
npm --prefix apps/brai_app ci
npm --prefix services/brai_api ci
```

Run the main checks:

```bash
npm run app:lint
npm run app:test
npm --prefix services/brai_api test
npm run openspec:validate
npm run public:guard
```

Work on the app:

```bash
npm run app:dev
npm run app:build
npm run app:e2e
npm run site:publish
```

Build Android artifacts:

```bash
npm run app:cap:sync
npm run android:build:release
```

Release APK signing is configured through environment variables outside the repository:

- `BRAI_ANDROID_KEYSTORE_PATH`
- `BRAI_ANDROID_STORE_PASSWORD`
- `BRAI_ANDROID_KEY_ALIAS`
- `BRAI_ANDROID_KEY_PASSWORD`

## Deployment Flow

- `brightos.world` serves the public site without Caddy basic auth.
- `main` is production and deploys the protected app to `app.brightos.world`.
- `codex/*` branches deploy to preview slots `A` through `E`.
- `npm run app:dev` is only the local Next.js development server.

GitHub Actions run public hygiene checks, app lint/tests, Brai API tests, and the matching deployment job for the branch class. Deployment credentials live in GitHub Secrets/Variables and on the server, never in source.

## Public Safety

Before publishing or merging public-facing work, run:

```bash
npm run public:guard
```

The guard scans the current tree and reachable Git history for forbidden runtime paths, signing material, credential-like files, local workspace paths, and personal markers. If it fails, fix the source tree before pushing or publishing.
