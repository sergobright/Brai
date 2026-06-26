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

## Public Safety

Do not store secrets, password hashes, tokens, private keys, signing files, runtime databases, generated release artifacts, local home paths, personal notes, or server-only credentials in the repository.

If Memory Bank or docs conflict with code, verify the code and update the public context.
