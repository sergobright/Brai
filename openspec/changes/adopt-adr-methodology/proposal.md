# Adopt Architecture Decision Records

## Summary

Add Architecture Decision Records as the durable rationale layer for Brai architecture choices and publish them through Log4brains.

## Capabilities

- Store ADRs under `docs/adr/` with status, context, decision, alternatives, consequences, confirmation checks, and links.
- Keep OpenSpec as the accepted behavior and requirements source while ADRs explain why architecture choices were made.
- Render and publish the ADR knowledge base with Log4brains at the protected `adr.brai.one` technical subdomain.
- Backfill important existing public decisions from current Memory Bank, OpenSpec, and operational docs.

## Rationale

Brai already records requirements and some decisions, but rationale is split across Memory Bank, OpenSpec proposals, design notes, and operational docs. A first-class ADR folder gives future maintainers one durable place to inspect architectural trade-offs without weakening OpenSpec as the requirements source.

## Delivery Guard

This is a docs/infra change because it adds repository documentation, local documentation tooling, a static ADR publish script, and a protected Caddy static route. It does not change runtime product behavior and should use the no-preview path.
