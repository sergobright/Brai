# Harden Supabase-Only Runtime Delivery

## Summary

Supabase-only runtime is already accepted. This change closes the remaining
delivery and runtime hardening gaps: accepted preview release gates, fail-closed
delivery classification signaling, preview schema checks, safe database override
handling, deterministic preview seed data, CORS boundaries, Android backup
policy, and stale operations documentation.

## Rationale

The API runtime now depends on Postgres, but surrounding delivery automation can
still accidentally pass with an unreleased accepted preview, classify deploy
test files as preview work, smoke-test only `public`, accept an unsafe branch DB
override, leak permissive CORS headers to untrusted browser origins, or allow
Android backup of local private app state.

## Delivery Guard

This is runtime/product hardening because it changes API behavior, Android
native manifest behavior, Supabase preview handling, and delivery gates. It must
finish through preview delivery.
