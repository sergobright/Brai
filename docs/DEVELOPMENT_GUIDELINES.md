# Bright OS Development Guidelines

This document is the index for project rules. `AGENTS.md` routes here; detailed rules live in `docs/guidelines/`, checklists live in `docs/checklists/`, accepted requirements live in `openspec/specs/`, and current public context lives in `memory-bank/`.

## Source Order

1. `AGENTS.md`
2. `docs/DEVELOPMENT_GUIDELINES.md`
3. `docs/guidelines/`
4. `openspec/specs/`
5. `openspec/changes/`
6. `memory-bank/`
7. Real repository state

## Read Before Work

| Task | Guideline |
| --- | --- |
| Source-of-truth or docs changes | [01-sources-of-truth.md](guidelines/01-sources-of-truth.md) |
| UI, shadcn, icons, visual QA | [02-ui-shadcn-radix-visual-rules.md](guidelines/02-ui-shadcn-radix-visual-rules.md), [12-ui-icons-visual-qa.md](guidelines/12-ui-icons-visual-qa.md) |
| Next.js/Capacitor client | [03-next-capacitor-client.md](guidelines/03-next-capacitor-client.md) |
| API, SQLite, sync, migrations | [04-api-data-sync-migrations.md](guidelines/04-api-data-sync-migrations.md) |
| Android, web, OTA, releases | [05-android-web-ota-releases.md](guidelines/05-android-web-ota-releases.md) |
| Tests, security, QA | [06-testing-security-qa.md](guidelines/06-testing-security-qa.md) |
| Git, versions, repository sync | [07-git-versioning-repository-sync.md](guidelines/07-git-versioning-repository-sync.md) |
| Refactoring | [08-refactoring-ponytail.md](guidelines/08-refactoring-ponytail.md) |
| Local services and ops | [09-local-services-ops.md](guidelines/09-local-services-ops.md) |
| Agent tools and OpenSpec | [10-agent-tools-openspec.md](guidelines/10-agent-tools-openspec.md) |
| UI registry/component policy | [11-ui-registry-component-policy.md](guidelines/11-ui-registry-component-policy.md) |

## Required Checks

- Public hygiene: `npm run public:guard`
- OpenSpec: `npm run openspec:validate`
- Client: `npm run app:lint`, `npm run app:test`
- API: `npm --prefix services/bright_os_api test`

Before commit or push, use [CHECKLIST_REPOSITORY_SYNC.md](checklists/CHECKLIST_REPOSITORY_SYNC.md).
