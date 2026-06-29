# Technical Context

Stack:

- Node.js 22+
- Next.js 16, React 19, TypeScript, Tailwind CSS
- Capacitor Android
- SQLite through `better-sqlite3`
- shadcn-compatible local UI primitives
- GitHub Actions for CI/CD
- Ansible/Caddy/systemd for self-hosted environments

Common checks:

```bash
npm run public:guard
npm run socraticode:preflight
npm run openspec:validate
npm run app:lint
npm run app:test
npm --prefix services/bright_os_api test
```

Public version baseline:

- Baseline version: `0.0.1.1`
- Android `versionCode`: `1`
- Release ledger table: `build_versions`
- Runtime `build_versions` is the source of truth for typed counters: `apk`, `build`, `release`, `canon`.
- `build_versions.version` is an integer scoped to `version_type_id`.
- Public app version is assembled as `canon.release.build.apk` from latest counters, using `0` for missing `canon` or `release`.
- Accepted working-branch merge into `main`: add one `build` row.
- Production deploy from `main`: no automatic `release` or `canon` row.
- Explicit release command: add one `release` row and link unlinked `build` rows plus the current `apk`.
- Explicit canon command: add one `canon` row and link unlinked `release` rows.
- GitHub PR numbers are review metadata and do not define version numbers.

Do not commit SQLite files, APKs, OTA bundles, keystores, `.env` files, private keys, or generated deploy output such as `deploy/web` and `deploy/mobile-update`.
