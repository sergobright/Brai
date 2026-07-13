---
name: brai-spike
description: Run disposable Brai experiments before production implementation. Use when the user asks to test feasibility, compare technical approaches, validate an integration, prototype an uncertain behavior, or answer a question that documentation and code reading cannot settle.
---

# Brai spike

## Frame the experiment

1. Confirm the answer is not already available in current docs, Context7, OpenSpec, or the repository.
2. Express each uncertainty as an observable Given/When/Then statement.
3. Split broad ideas into at most five independent spikes and run the highest existential risk first.
4. If several spikes materially change scope, align their order with the user before writing code.

## Choose the storage boundary

- Use ignored `vault/spikes/<slug>/` for local disposable evidence.
- Use tracked paths only after the official Brai task starter and only when the result must be reviewed or delivered.
- Never mix spike code into production modules or silently promote it into implementation.
- Do not delegate comparison variants unless the user explicitly asks for subagents or parallel agent work.

## Research and build

1. Check current primary documentation for external dependencies through Context7.
2. Name credible alternatives and select the smallest experiment that distinguishes them.
3. Prefer a runnable CLI, minimal HTML page, one endpoint, or one focused test.
4. Avoid new infrastructure, configuration, dependencies, and Docker unless the hypothesis specifically requires them.
5. Test at least one failure or boundary case; a happy-path log line is not evidence.

## Verdict

Record:

- `VALIDATED`: the hypothesis holds with reproducible evidence;
- `PARTIAL`: it works only under named constraints;
- `INVALIDATED`: it does not work and the evidence explains why.

Include the exact command or flow, observed results, surprises, limitations, and recommendation for the real implementation. An invalidated hypothesis is a successful spike. Leave production implementation for a separate authorized task.
