# ADR: Contextual rail, role archive, and revision-bound Preview notes

- Status: Accepted
- Date: 2026-07-13
- Decision makers: Product owner

## Context

The compact desktop navigation rail is permanent application chrome, but Draws already has a second static list and Archive must grow with entity roles. Page-specific panel state should not alter global navigation. History needs the event ledger, and Preview testing guidance must be prepared once during delivery rather than generated on each admin page view.

## Decision

Add a separate contextual rail between the compact navigation rail and workspace. Store page open state per account locally and one shared 192–512px width in local cache plus authenticated server preferences. Mobile reuses the temporary left drawer.

Build Archive from `item_role_types`, `items`, and `item_roles`, with fixed enrichment for known role tables and generic rendering for future roles. Restore Activities and Inbox through their event streams; Focus remains read-only. Entity History queries all user-scoped events linked by item, role, or subject.

Extend Preview release notes with user-testing guidance and have successful handoff attach it atomically to the exact branch/commit in the slot registry. Admin remains read-only.

Use one bundled completion MP3 through browser `Audio` and native widget `MediaPlayer`, invoked only from manual `New -> Done` handlers. Queue badges remain derived only from real pending transport plus ready-to-insert counts.

## Consequences

- The permanent navigation rail remains fixed and visually stable.
- New role types appear in Archive without a client release, though unknown roles use a generic card.
- User rail width follows the account across web devices; open state stays page-local to the current device.
- Preview slots expose deterministic testing instructions without an admin-side AI call.
- Android widget sound requires a new APK; web-layer sound can continue through OTA.
