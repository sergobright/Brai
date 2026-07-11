# Design

## Raw Inbox boundary

The client create event stores the captured line in both provisional `title`
and immutable `explanation_text`, with `source = brai-app` and the stable client
device id as `source_key`. Server projection supplies the same values for older
clients that only sent `title`. Normalization reads `explanation_text` first and
uses provisional `title` only as a compatibility fallback.

Workflow v3 keeps v1/v2 executions pinned. It uses the existing local Codex CLI
boundary and a stricter prompt that preserves intent and named entities while
correcting obvious typos. Empty semantic input becomes `needs_review` with
`raw_input_empty` before any AI execution.

## Step state read model

The workflow details API derives `step_states` from the pinned definition,
execution row, normalized Inbox result, and exact workflow/run `ai_logs`.
The client renders these states directly and never infers completion from the
overall status. A missing image execution is `skipped/not_required`, not
completed.

## Authentication boundary

`GET /auth/session` only reads an existing Better Auth or signed legacy session.
It never creates one. Preview/Dev explicitly enables `POST
/auth/test-email-login`; the route accepts only the primary account email and
creates the normal primary session cookie. The route is absent in production.
The shared client selects email-only for non-production web, password for every
native shell, and OTP for production web.

The deployment env migration removes `BRAI_TEST_AUTO_LOGIN`, enables
`BRAI_TEST_EMAIL_LOGIN`, and rotates the Preview/Dev signed-session secret once
when converting an existing auto-login env so already minted cookies are
invalidated.
