# Require Final Test Data Cleanup

## Summary

Make branch acceptance and deletion fail closed until preview data and branch-scoped API test schemas are removed.

## Capabilities

- Tag new API test schemas with stable branch and test-run scopes.
- Remove one test run's schemas when the API test runner exits, including failed runs.
- Remove all schemas for a closed branch before its preview slot is released.
- Collect only legacy unscoped test schemas older than a conservative safety window.
- Treat cleanup failure as a delivery blocker instead of best-effort hygiene.

## Rationale

Interrupted test processes can skip JavaScript `finally` blocks and leave isolated Postgres schemas behind. Preview cleanup also contains a recovery path that currently continues after deletion errors. Both behaviors allow test data to outlive the branch that created it.

## Delivery Guard

This changes only deployment and test lifecycle behavior. It must pass API, task, Temporal, OpenSpec, and public checks and finish through the `technical-no-preview` delivery flow.
