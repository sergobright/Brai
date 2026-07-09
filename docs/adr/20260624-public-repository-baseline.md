# Public repository baseline

- Status: accepted
- Deciders: Project owner, Codex
- Date: 2026-06-24
- Tags: repository, public-safety, governance

## Context

Brai needed a public-safe development baseline. The previous bootstrap history contained runtime artifacts and private development context that should not be exposed through public source control.

## Decision

Brai public development starts from a clean public repository baseline. Future public work uses one canonical repository instead of separate public/private source branches.

## Alternatives Considered

- Keep existing private history and scrub later: rejected because reachable history would remain risky.
- Maintain separate public and private source branches: rejected because branch divergence would make delivery and review harder.

## Consequences

- Positive: public development has one clean accepted base.
- Negative: older private bootstrap history is intentionally not available in public Git.
- Risk: useful private context must be re-recorded only when it is public-safe.

## Confirmation

Run `npm run public:guard` before publishing or merging public branches.

## Links

- `memory-bank/decisionLog.md`
- `memory-bank/activeContext.md`
- `docs/guidelines/01-sources-of-truth.md`

## Supersedes

None.

## Superseded By

None.
