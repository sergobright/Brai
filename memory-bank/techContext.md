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
npm run openspec:validate
npm run app:lint
npm run app:test
npm --prefix services/bright_os_api test
```

Public version baseline:

- App/web/OTA version: `0.0.10.1`
- Baseline version: `0.0.1.1`
- Android `versionCode`: `1`
- Release ledger table: `build_versions`
- Initial ledger rows: `build` = `0.0.1.1`, `apk` = `0.0.1.1`
- Next accepted task merge into `dev`: increment `Z`
- Next promotion from `dev` to `main`: increment `Y`
- Next shipped APK release: increment `S`
- Example: `0.0.10.1` on `dev` promotes to `0.1.10.1` on `main`

Do not commit SQLite files, APKs, OTA bundles, keystores, `.env` files, private keys, or generated deploy output.
