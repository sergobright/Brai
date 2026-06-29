# Design

Use the existing release page, preview slot registry, and OTA manifest fields.

- `deploy/scripts/apk-version-code.sh` serializes Android `versionCode` allocation under the environment root.
- APK publishing writes to the configured shared release target and updates preview slot metadata when a branch-specific slot APK is built.
- Non-production web-layer publishing resolves the required APK `versionCode` from the release index and writes exact `min/max` compatibility.
- The app shell treats `lastCheckStatus === "incompatible"` as a hard blocker only when the native or bundled environment is not production.

No new service or database table is introduced.
