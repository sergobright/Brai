# Technical Context

Stack:

- Node.js 22+
- Next.js 16, React 19, TypeScript, Tailwind CSS
- Capacitor Android
- Supabase Postgres through `pg`
- shadcn-compatible local UI primitives
- GitHub Actions for CI/CD
- Ansible/Caddy/systemd for self-hosted environments
- Brai Admin runs as per-environment localhost-only Next.js services behind Caddy.

Common checks:

```bash
npm run socraticode:ensure
npm run public:guard
npm run socraticode:preflight
npm run openspec:validate
npm run app:lint
npm run app:test
npm --prefix services/brai_api test
```

Version baseline after the APK reset:

- OTA/web version format: `X.Y.Z`
- APK version format: `vN`
- Current APK baseline: `v2`
- Android `versionName`: `2`
- Android `versionCode`: `2`
- Release ledger table: `build_versions`
- Runtime `build_versions` contains accepted `build` rows and the separate `apk` counter.
- Accepted working-branch promotion into `main`: write the `build` row first, then record deployment metadata.
- GitHub PR numbers are review metadata and do not define version numbers.

Do not commit runtime database files, APKs, OTA bundles, keystores, `.env` files, private keys, or generated deploy output such as `deploy/web` and `deploy/mobile-update`.
