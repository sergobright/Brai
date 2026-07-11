# Hermes Agent skill mirror

This directory vendors the official skill trees from [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent).

- `skills/` mirrors Hermes bundled skills.
- `optional-skills/` mirrors Hermes official optional skills.
- `manifest.json` records the upstream repo URL, commit, sync timestamp, and per-tree counts.
- Credential-like example strings are sanitized locally so the mirror can pass Brai public branch guard.

Refresh with:

```bash
npm run skills:sync:hermes -- --source /path/to/hermes-agent
```

Or let the script clone the official repo itself:

```bash
npm run skills:sync:hermes
```
