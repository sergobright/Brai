## 1. Preview database integrity

- [x] 1.1 Reseed every copied owned serial/identity sequence inside the copy transaction.
- [x] 1.2 Fail preview smoke checks when a sequence can collide with existing rows.
- [x] 1.3 Keep refresh and post-seed migrations atomic under table locks and use the existing deploy cutover.
- [x] 1.4 Cover copied, empty, preserved, already-ahead, serial, identity, descending, cycling, cached, and exhausted sequence cases.

## 2. Durable workflow dispatch

- [x] 2.1 Make ordinary technical log writes non-blocking after committed domain work.
- [x] 2.2 Move apply technical logging outside the domain transaction.
- [x] 2.3 Reconcile queued executions every 500 ms without overlapping runs.
- [x] 2.4 Keep immediate start, startup recovery, and periodic recovery idempotent by stable workflow ID.
- [x] 2.5 Test lost callbacks, logging failures, duplicate reconciliation, and terminal status behavior.
- [x] 2.6 Reattach exact running workflow/run observers after restart and retry terminal persistence without treating transport loss as workflow failure.
- [x] 2.7 Bound new Temporal runs and block late apply from reviving a terminal execution.

## 3. Local Codex CLI text normalizer

- [x] 3.1 Keep Inbox text and image AI execution on the installed local Codex CLI.
- [x] 3.2 Pass the stored versioned normalizer schema through `codex exec --output-schema`.
- [x] 3.3 Store the provider-compatible strict schema as `brai.inbox.normalized.v2` without runtime rewriting.
- [x] 3.4 Isolate text invocation from repository/user context, replace general coding instructions, and use low reasoning and verbosity.
- [x] 3.5 Keep text model and timeout separately measurable while preserving the default `gpt-5.4-mini`.
- [x] 3.6 Record effective model, invocation timing, attempts, and bounded errors for every real AI call.
- [x] 3.7 Test invocation arguments, schema/instruction file lifecycle, valid output, candidate classes, timeout, refusal, schema failure, and audit logs.
- [x] 3.8 Preserve queued/running v1 schema pinning while applying strict `brai.inbox.normalized.v2` only to new v2 executions.

## 4. Verification

- [x] 4.1 Run API, Temporal, task, Postgres, and OpenSpec checks.
- [x] 4.2 Deploy the repaired branch preview and verify all identity sequences.
- [x] 4.3 Recreate the reported text-only Inbox scenario and verify it reaches a terminal state.
- [x] 4.4 Benchmark at least 30 preview no-image runs and report p50/p90/p95/p99 plus sampled output quality.
