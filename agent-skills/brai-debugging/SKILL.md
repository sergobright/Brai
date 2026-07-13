---
name: brai-debugging
description: Systematic debugging for Brai client, API, Temporal, Android, database, preview, and deployment failures. Use when diagnosing a Brai bug, failed test, runtime error, regression, performance issue, broken integration, or incident; use before proposing or implementing a fix.
---

# Brai debugging

## Establish the boundary

1. Read the applicable `AGENTS.md`, `docs/DEVELOPMENT_GUIDELINES.md`, and routed guideline.
2. Determine whether the user requested diagnosis only or also authorized a fix.
3. Name the failing boundary: client, Android, API, Postgres, Temporal, Caddy, preview, or external provider.
4. Never expose secrets, bypass Caddy, or replace required published-preview QA with localhost checks.

## Build a tight loop

1. Reproduce the exact symptom with the narrowest deterministic command or browser flow.
2. Confirm the loop can fail for the reported reason; a nearby generic failure is insufficient.
3. For semantic code discovery, check SocratiCode and search there first. Use `rg` for exact strings and files.
4. When third-party behavior matters, fetch current documentation through Context7 before forming the fix.

Prefer, in order: one targeted test, a narrow API repro, a published Preview browser flow, a replayed payload, or a minimal throwaway harness.

## Locate the cause

1. Read the complete error and relevant recent diff.
2. Trace the bad value or state upstream across every component boundary.
3. Compare with one working sibling path in the same repository.
4. Form ranked falsifiable hypotheses. Test one variable at a time.
5. Use Node's built-in Inspector when logs cannot reveal closure state or an async hang. Bind it to `127.0.0.1` only.

Do not edit production code until the evidence identifies a root cause. After three failed fix attempts, stop and reconsider the architecture with the user.

## Fix and verify

When a fix is authorized:

1. Add the smallest regression check that is red for the real symptom.
2. Apply one root-cause fix without unrelated refactoring.
3. Run the targeted check, then the relevant project checks from guideline 06.
4. For UI/runtime changes, complete the required published Preview verification and handoff.
5. Report the root cause, changed behavior, and exact verification evidence.
