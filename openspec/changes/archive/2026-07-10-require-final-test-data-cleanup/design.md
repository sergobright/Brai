# Design

API test schemas use `brai_test_<branch-hash>_<run-hash>_*`. The normal test-run exit removes only the exact branch/run prefix, so concurrent runs do not delete each other's schemas. Branch release removes the wider branch prefix.

The branch release order is:

1. delete the branch preview schema;
2. delete branch-scoped API test schemas and legacy unscoped schemas older than 24 hours;
3. release the preview slot.

The slot remains allocated if either database cleanup fails. Temporal therefore receives the existing release failure and keeps the lifecycle non-terminal in `waiting_for_fix`.
