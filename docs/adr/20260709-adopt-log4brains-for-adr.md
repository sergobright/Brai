# Adopt Log4brains for ADRs

- Status: accepted
- Deciders: Project owner, Codex
- Date: 2026-07-09
- Tags: adr, log4brains, documentation

## Context

Brai needs a first-class ADR methodology and browsable architecture decision knowledge base. The project already uses docs-as-code and OpenSpec, so ADR tooling should stay repository-local and reproducible.

## Decision

Brai stores ADRs under `docs/adr/`, uses Log4brains as a pinned local devDependency for listing, previewing, and building ADRs, and publishes the generated static site at protected `adr.brightos.world`.

## Alternatives Considered

- Plain Markdown only: rejected for this rollout because the project owner explicitly chose Log4brains and full ADR visibility.
- Global `npm install -g log4brains`: rejected because project tooling should be pinned and reproducible.
- Public ADR site: rejected because `adr.brightos.world` is a technical subdomain and should use unified Caddy basic authentication.

## Consequences

- Positive: ADRs are easy to browse and search as a generated static site.
- Negative: Log4brains brings a large and partly deprecated dependency tree.
- Risk: if Log4brains maintenance becomes a blocker, ADR Markdown remains usable and can be rendered by another tool.

## Confirmation

Run `npm run adr:list` and `npm run adr:build` after ADR changes.

## Links

- `.log4brains.yml`
- `docs/adr/index.md`
- `openspec/changes/adopt-adr-methodology/proposal.md`

## Supersedes

None.

## Superseded By

None.
