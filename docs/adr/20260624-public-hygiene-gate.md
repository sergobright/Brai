# Public hygiene gate

- Status: accepted
- Deciders: Project owner, Codex
- Date: 2026-06-24
- Tags: security, public-safety, ci

## Context

Public branches must not expose runtime data, generated release artifacts, signing material, local paths, private context, or high-confidence secret patterns.

## Decision

Every public branch class must run the public guard before merge or deployment.

## Alternatives Considered

- Rely on manual review: rejected because secret and artifact leaks are easy to miss.
- Keep guard optional: rejected because public safety must be enforced consistently.

## Consequences

- Positive: risky files and patterns are blocked before publication.
- Negative: false positives must be fixed or explicitly handled.
- Risk: new artifact classes require guard updates when discovered.

## Confirmation

Run `npm run public:guard` before handoff, merge, or publication.

## Links

- `memory-bank/decisionLog.md`
- `docs/guidelines/01-sources-of-truth.md`

## Supersedes

None.

## Superseded By

None.
