# Design

## Backlog closure

The runtime operations table remains the ledger. Completion uses the existing
deploy-owned helper, extended only to accept the two historical
`activity:operation:*` identifiers while retaining operation type and Codex
author checks.

The duplicate `operation:agent-task:temporal-supabase-docker-network` is closed
as obsolete only after its title, cause, and remediation are confirmed to be
covered by `operation:agent-task:temporal-supabase-network`. Guard operations
are not duplicates: `brai-guard-sync-security-approval` is the immediate
installed-copy repair, while `admin-feedback-guard-sync` owns prevention of the
next drift.

## Delivery tooling

Existing task, acceptance, Temporal, and sandbox helpers are extended in place.
No parallel orchestration layer is added. Delegation is a scoped receipt in
ignored task state; dependency updates use lockfile-only npm behavior.

No-preview handoff first looks up the PR by exact head SHA. An already merged
PR is success even when GitHub has deleted the head ref; only an unmerged flow
needs the branch checkout and auto-merge path. The operation helper transports
its payload as structured stdin data instead of interpolated SSH command
arguments.

## Runtime

Temporal and Supavisor pools are bounded below PostgreSQL's existing connection
limit. Vault and ADR publication use the existing deploy ownership contract.
The preview slot JSON registry stays authoritative, but its generated HTML and
public Caddy routes are deleted.

The installed guard is synchronized through the existing guarded install path,
then deployment automation verifies or repairs the installed copy so a merged
guard change cannot leave the next task blocked. Temporal and Supabase network
membership is declared in their durable compose/systemd ownership boundary and
is checked after container recreation, not repaired by a one-off `docker
network connect`.

APK release metadata is rendered and permission-checked in temporary files,
then atomically renamed by the deploy-owned user. A failed chmod/render must
leave the previous `releases.json` and page intact. The Codex smoke permission
is one exact Ansible-managed command, without wildcard environment execution.

API shutdown acceptance covers SIGTERM, active reconciliation, HTTP listener
closure, and Postgres pool closure under the systemd stop timeout. Secret
rotation is a host-only runbook: replace every exposed value, restart all
consumers, prove the new values work, and prove the old values fail without
recording either value in source or logs.

## Product

OTP email uses the existing public HTTPS brand asset and returns no MIME
attachments. Android overlay QA adds instrumentation coverage without changing
the production overlay implementation.

Email-template verification extracts each remote image URL from the rendered
HTML and requires unauthenticated HTTPS `200` plus `Content-Type: image/*` on
the exact production hostname and path. A template unit test alone is not a
substitute for this publication check.

## Verification Baseline

The preparation audit used production runtime data through
`/etc/brai/brai-api.env` without exposing the DSN or credentials. At
`origin/main` commit `defcf4d36d15ac94ea9e8fe63b0dfb1b73a13898`:

- task tests passed (12/12), Temporal tests passed (3/3), and API tests passed
  (140/140);
- the installed guard differed from `scripts/brai-task.mjs`;
- `supabase-db` and `brai-temporal` were currently attached to
  `brai-supabase`, but the durable ownership boundary had no verified
  recreation/self-healing check;
- `brai-deploy` had no sudoers permission for the exact Codex smoke command;
- APK metadata files were owned by `nobody:nogroup`, and the updater wrote
  JSON before render/chmod could fail;
- the full remote operation-helper probe failed on space-bearing shell
  metacharacters;
- `https://brai.one/brai-logo.png` returned `200 image/png`, while the former
  app-host path returned HTML, and no automated public-URL gate existed;
- the production env file timestamp predated the recorded shell-trace
  exposure, so secret rotation was not verified;
- the API had a SIGTERM handler and was running, but no signal-level restart
  evidence proved the reported shutdown failure resolved.
