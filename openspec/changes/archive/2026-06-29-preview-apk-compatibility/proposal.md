# Preview APK Compatibility

## Why

Preview APKs can outlive the branch that created them. Without exact APK/OTA compatibility, a later preview can appear to work while the installed Android shell is stale or from a rejected branch.

## What Changes

- Allocate Android `versionCode` through a lock-protected server-side counter.
- Publish exact Dev/Preview OTA APK requirements through `minApkVersionCode` and `maxApkVersionCode`.
- Build branch-specific APKs only for native preview branches and rebuild Dev/A-E APKs after accepted native changes.
- Block Dev/Preview app use when the installed APK is incompatible.

## Impact

- Web-only preview work keeps using OTA without APK rebuilds.
- Native-boundary work has a slower but explicit APK flow.
- Production keeps non-blocking fallback behavior.
