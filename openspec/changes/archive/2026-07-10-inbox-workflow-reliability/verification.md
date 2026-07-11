# Preview Verification

Verified on 2026-07-10 in Preview A at commit
`e54b29a79cb5b2c501da0f6e209442733261e6c5`.

## Database and Temporal

- Postgres smoke reported 7 owned sequences and 0 unsafe allocations.
- The reported text-only scenario reached workflow v2 `completed` on its first
  attempt with `gpt-5.4-mini` and no image step.
- The exact Temporal workflow/run reported `COMPLETED`, task queue
  `brai-inbox-normalization-3031`, and 23 history events.
- After verification, Inbox workflow counts contained 31 `completed`, 0
  `queued`, 0 `running`, and 0 relevant workflow failure logs.

## Sequential no-image benchmark

Thirty varied Russian text records were created sequentially through the real
Preview A domain ingest and Temporal worker. All 30 normalized successfully on
attempt 1 through the local Codex CLI with model `gpt-5.4-mini`; none had an
attachment or image step.

| Measurement | min | p50 | p90 | p95 | p99 | max |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Full workflow | 3622 ms | 4501 ms | 6187 ms | 6243 ms | 7330 ms | 7330 ms |
| Codex invocation | 3256 ms | 3921 ms | 5599 ms | 5720 ms | 6922 ms | 6922 ms |

Sampled titles, descriptions, and class keys were coherent for tasks, wishes,
and ideas. The approximately one-second target is not achieved by the required
local `codex exec` path; the measured distribution above is the release fact.
