# Agent Tools And OpenSpec

- Use OpenSpec for planned requirement changes before implementation.
- Accepted requirements live in `openspec/specs/`.
- Proposed changes live in `openspec/changes/<change-id>/`.
- Architecture Decision Records live in `docs/adr/` and record decision rationale, alternatives, consequences, and confirmation checks.
- Create or update an ADR when a change affects architecture, data, security, deployment, dependencies, public contracts, or multiple modules.
- Link OpenSpec design/proposal files to related ADRs instead of duplicating long rationale.
- Use `npm run adr:list`, `npm run adr:preview`, and `npm run adr:build` for Log4brains ADR workflows.
- Run `npm run openspec:validate` after changing specs or rules.
- Use current library documentation tooling when a task depends on third-party API behavior.
- Do not copy secrets, credentials, private messages, or server-only values into docs or specs.
- Use SocratiCode as the default path for semantic codebase exploration.
- Keep `.socraticode.json` committed with a stable `projectId` so the main checkout and `codex/*` worktrees share one SocratiCode index.
- Before behavior/responsibility/architecture search, call SocratiCode `codebase_status` for the active project path; if the index is ready, use `codebase_search` before reading files.
- Use `rg`/shell search for exact strings, file discovery, and other non-semantic inspection.
- Keep `.socraticodecontextartifacts.json` aligned with agent-facing docs, ADRs, OpenSpec, and Memory Bank so rules, requirements, and rationale are searchable as context artifacts.
- Run `npm run socraticode:ensure` once in a repo/worktree when the shared index is missing, incomplete, or stale; after that the SocratiCode watcher keeps the shared index current on file changes.
- Run `npm run socraticode:preflight` when SocratiCode behavior, agent rules, OpenSpec routing, or repository context indexing changes; it must verify the MCP config, shared index, and active watcher state.
