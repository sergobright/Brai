# Technical Context

Stack:

- Node.js 22+
- Next.js 16, React 19, TypeScript, Tailwind CSS
- Static HTML/CSS for the public site
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
npm run site:publish
npm --prefix services/bright_os_api test
```

Public version baseline:

- Baseline version: `0.0.1.1`
- Android `versionCode`: `1`
- Release ledger table: `build_versions`
- Runtime `build_versions` is the source of truth for current app/web/OTA versions.
- Initial ledger rows: `build` = `0.0.1.1`, `apk` = `0.0.1.1`
- Accepted working-branch merge into `main`: increment `Z`, with `release_version = 0`
- Production deploy from `main`: increment `Y`, keep latest included `Z`, and reference included accepted build rows
- Next shipped APK release: increment `S`
- GitHub PR numbers are review metadata and do not define version numbers.
- Example: accepted build `0.0.10.1` promotes to production release `0.1.10.1`.

Do not commit SQLite files, APKs, OTA bundles, keystores, `.env` files, private keys, or generated deploy output such as `deploy/site`, `deploy/web`, and `deploy/mobile-update`.
