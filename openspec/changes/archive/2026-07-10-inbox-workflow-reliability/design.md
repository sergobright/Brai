# Design

## Preview data copy

After explicit-ID copy and before commit, the preview seeder discovers every
owned serial/identity sequence for copied tables and moves it forward without
ever lowering an existing watermark. Empty copied tables keep their existing
safe allocation state. Readiness independently checks
that a default insert cannot collide with existing values. `TRUNCATE`, copy, and
reseed and post-seed migrations share one transaction whose table locks prevent
concurrent writes from observing or modifying partial state. The API moves to the
new source through the existing deploy cutover; no new service-control privilege
is introduced by the database refresh.

## Durable dispatch

Inbox ingest commits the raw row, initial event, and queued execution as one
domain transaction. Immediate Temporal start remains the fast path. A single
non-overlapping reconciler polls queued executions every 500 ms and starts them
by the existing stable workflow ID, so a lost in-process callback self-heals.
The same pass reattaches one durable observer to each persisted `running`
workflow/run pair. Resolved or terminal Temporal executions are reconciled
atomically against the Inbox domain result; transport errors only remove the
observer so the next pass can retry. Startup recovery uses the same operation.
New runs have a two-minute Temporal execution timeout, above the bounded Codex
attempt budget, so worker or activity loss cannot leave an unbounded operation.

Ordinary `logs` rows are an operational mirror: failures are reported to the
service logger but cannot change the result of a committed ingest or a successful
domain apply. `ai_logs` remains the required audit record for every real AI call.

## Text-only normalizer

The normalizer must execute through the installed local Codex CLI. It uses the
stable non-interactive `codex exec --ephemeral` surface with the configured
lightweight model (`gpt-5.4-mini` by default). The versioned workflow output schema
is written to the invocation's private temporary directory and passed through
`--output-schema`, while local validation remains the final trust boundary.

The invocation starts in that temporary directory and ignores user configuration,
so it does not load repository `AGENTS.md`, plugins, MCP servers, or unrelated
project context. A private `model_instructions_file` replaces the general coding
agent instructions with the narrow JSON-normalizer contract. It runs read-only
with approvals disabled, low reasoning, low verbosity, and no web or tool
requirement. Image description remains a separate Codex CLI invocation only when
an image is present.

Workflow v2 stores `brai.inbox.normalized.v2`, whose six properties are all
required by the provider-facing strict schema. `class_title` and
`class_description` use empty strings when the selected class already exists.
The exact stored schema is passed to Codex; no hidden runtime rewrite changes its
versioned meaning.

Definition upgrades preserve the version pinned at execution creation. Existing
queued or running v1 executions are not relabelled as v2. They read the retired
v1 schema and use the legacy locally-validated Codex CLI lane, while only newly
created v2 executions receive the provider-facing six-field strict schema. Both
lanes remain isolated local Codex CLI calls; neither has a direct-provider
fallback.

CLI timeout, non-zero exit, empty output, schema failure, and refusal produce a
bounded workflow failure; they never switch to a direct provider API. The raw
Inbox row remains intact and the workflow reaches `failed` or `needs_review`
instead of remaining active. Effective model, attempt, total invocation latency,
and a bounded error code are recorded in `ai_logs`.

About one second remains the optimization goal for successful no-image runs, not
an unverified release guarantee. Preview publishes p50/p90/p95/p99 over at least
30 successful calls and the configured timeout remains the hard upper bound. If
model inference dominates after the CLI path is stripped down, the measured
result is reported without replacing the required Codex runtime.
