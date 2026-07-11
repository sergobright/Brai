## ADDED Requirements

### Requirement: Text-only Inbox normalization uses bounded local Codex inference
Brai SHALL normalize Inbox records without required image work through the
installed local Codex CLI with a versioned structured-output contract.

#### Scenario: Text-only record is normalized
- **WHEN** a queued Inbox record has no image attachment requiring description
- **THEN** `inbox.normalizer` calls local `codex exec --ephemeral`
- **AND** the configured production default remains `gpt-5.4-mini`
- **AND** the call passes the exact stored `brai.inbox.normalized.v2` strict output schema through `--output-schema`
- **AND** the call runs from isolated temporary context with low reasoning and verbosity
- **AND** a narrow model instruction file replaces unrelated general coding-agent instructions
- **AND** title, description, class fields, and normalization text are locally validated before apply
- **AND** the successful execution records model, attempt, and timings in `ai_logs`
- **AND** no direct model-provider API bypasses Codex CLI

#### Scenario: Local Codex execution fails
- **WHEN** Codex CLI times out, exits unsuccessfully, refuses, or produces unusable output
- **THEN** each real Codex execution is represented in `ai_logs`
- **AND** Brai does not bypass Codex through a direct provider API
- **AND** the raw Inbox record remains intact
- **AND** the workflow reaches an explicit terminal status after its bounded attempts are exhausted

#### Scenario: A legacy v1 execution was already persisted before upgrade
- **WHEN** a queued or running execution is pinned to `inbox.raw-normalization` v1
- **THEN** Brai keeps its workflow definition version and reads the retired v1 schema
- **AND** it uses the isolated local Codex CLI with local v1 schema validation
- **AND** it does not silently relabel that execution as v2 or send it through the v2 strict-schema contract
- **AND** newly created executions use v2

#### Scenario: Strict output cannot be accepted
- **WHEN** the provider refuses the request or the returned object fails local schema or business validation
- **THEN** Brai does not apply partial normalized data
- **AND** the raw Inbox record remains intact
- **AND** the workflow reaches `needs_review` or `failed` with a bounded error code
- **AND** the UI does not continue to report an active AI operation indefinitely

#### Scenario: Text-only latency is measured
- **WHEN** successful no-image Inbox workflows run in preview
- **THEN** Brai measures latency from execution creation through completion
- **AND** at least 30 runs report p50, p90, p95, and p99
- **AND** about one second remains an optimization goal rather than an unmeasured release guarantee
- **AND** the configured Codex timeout is the hard upper bound for each attempt
