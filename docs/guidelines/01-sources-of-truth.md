# Sources Of Truth

## Order

1. `AGENTS.md` - short agent route.
2. `docs/DEVELOPMENT_GUIDELINES.md` - rule index.
3. `docs/guidelines/` - working development rules.
4. `openspec/specs/` - accepted requirements.
5. `openspec/changes/` - proposed requirements before acceptance.
6. `memory-bank/` - public current context and decisions.
7. Repository state - always verify with the actual files.

## Where To Write Durable Information

- Agent routing: `AGENTS.md`.
- Development rules: relevant file in `docs/guidelines/`.
- Stable requirements: `openspec/specs/`.
- Planned requirements: `openspec/changes/<change-id>/`.
- Public project context and decisions: `memory-bank/`.
- Server SQLite schema metadata: `table_descriptions`, updated with every schema metadata change.
- Runtime or service registry: outside the repository.

## Runtime Facts

- Do not record rules, claim implementation, or accept verification for a runtime table, service, deployment, or environment until the actual target environment has been inspected.
- For SQLite facts, verify the real database path, table presence, schema, indexes, and relevant rows with read-only SQL before writing docs or reporting completion.
- Preview and production databases can differ; name the environment and path checked.
- For live SQLite databases in WAL mode, use a normal read-only connection and include WAL state. Do not use `immutable=1` for freshness-sensitive verification.
- If runtime access is unavailable, report the blocker. Do not infer production or preview state from repository code, migrations, screenshots, or user wording alone.

## Public Safety

Do not store secrets, password hashes, tokens, private keys, signing files, runtime databases, generated release artifacts, local home paths, personal notes, or server-only credentials in the repository.

If Memory Bank or docs conflict with code, verify the code and update the public context.
