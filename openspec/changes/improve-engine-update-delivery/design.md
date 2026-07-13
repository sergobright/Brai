# Design: Engine update delivery

## Context

The Android OTA manager currently downloads a compatible archive while checking its manifest. The release catalogue is also the only APK entry point and is protected, so an unauthenticated Engine cannot download the correct channel artifact. Navigation can change the Engine icon but has no reusable supplementary indicator or aggregate mobile overflow signal.

## Goals / Non-Goals

**Goals**

- Make automatic checks network-light and side-effect free beyond state discovery.
- Make every download an explicit user action and preserve installed-channel affinity.
- Expose only the current production APK in the public catalogue while keeping the operational catalogue protected.
- Bound abusive APK download starts without adding shared infrastructure.
- Present one consistent, accessible update signal on desktop and mobile.

**Non-goals**

- Multi-process or durable rate limiting.
- Automatic APK installation or requesting unknown-sources permission.
- Hot-swapping a downloaded web bundle in the current app session.
- Redesigning unrelated dock items.

## Decisions

### Discovery and download are separate commands

`checkForUpdates()` only fetches and validates the manifest and publishes availability state. `downloadUpdate()` performs the existing verified archive pipeline. `downloadApk()` queues the installed release key through Android `DownloadManager` and reflects its lifecycle in bridge state. Startup and timer callers continue using only `checkForUpdates()`.

### Public downloads are keyed, not filename-discovered

`GET /releases/download/:releaseKey` resolves only `production`, `dev`, and `a`–`e` from release metadata. This prevents the UI from guessing filenames and guarantees Preview B receives B. The public `/releases/` catalogue renders only Production; `/dev-releases/` retains the password session and all channels. Only the current Production filename remains public under the legacy filename route.

### Download starts are limited in the API process

A single `RateLimiterMemory` allows ten APK stream starts per derived IP per 3600 seconds. The API trusts `X-Forwarded-For` only when the socket peer is loopback (the local Caddy boundary); otherwise it uses the socket address. Rejection occurs before opening the file and returns `429` plus `Retry-After`.

### Navigation indicators are composable

Navigation items accept an arbitrary supplementary React node and position. The default anchor is bottom-right. Engine supplies a yellow status dot; the mobile overflow button aggregates hidden-item indicators at bottom-center with absolute positioning, preserving button geometry.

## Risks / Tradeoffs

- The in-memory limiter resets on restart and is per API process; this is accepted while deployment remains single-process.
- Public keyed endpoints intentionally expose non-production APKs because unauthenticated installed apps need them; the protected catalogue still avoids public discovery.
- Android DownloadManager completion can occur after the app process exits; persisted download id/state is reconciled when state is read again.
- The currently installed APK lacks the new bridge and uses the browser fallback once during migration.

## Migration

1. Publish API/web changes and the native Preview APK together.
2. Existing APKs fall back to the compatible public Production download path in the browser.
3. After acceptance, publish stable Production, Dev, and Preview APKs with the new bridge.
4. Keep the legacy Production filename route until old clients no longer depend on it.

## Open Questions

None. The owner accepted the single-stage native rollout and single-process limiter.
