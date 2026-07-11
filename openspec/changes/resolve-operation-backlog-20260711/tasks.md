- [x] 1. Close operations already verified as resolved or obsolete.
- [ ] 2. Rotate exposed runtime secrets and verify old values are rejected.
- [x] 3. Repair guard, runtime permissions, database pools, diagnostics, and tool runtimes.
- [x] 4. Improve acceptance, handoff, delegation, SocratiCode, dependency, and app-server workflows.
- [x] 5. Remove preview status HTTP/HTML functionality while keeping the slot registry.
- [x] 6. Remove CID email attachments and add Android overlay visual QA.
- [ ] 7. Run repository, runtime, browser/email, Android, and delivery verification.
- [ ] 8. Close every remediated operation and verify the open list is empty.

## Prepared Execution Queue

### Wave 0: containment and delivery prerequisites

- [ ] 9. Rotate every secret exposed by shell trace, restart each consumer,
  verify login/sync/OTP/Brai Cmd/Syncthing/AI integrations, and prove old values
  are rejected (`rotate-runtime-secrets-after-shell-trace`).
- [ ] 10. Run the approved guard install, verify byte equality, then add the
  smallest deploy-owned sync/check that prevents drift on future guard changes
  (`brai-guard-sync-security-approval`, `admin-feedback-guard-sync`).
- [ ] 11. Declare `supabase-db` membership and alias on `brai-supabase` in the
  durable runtime configuration; recreate/restart both stacks and verify DNS,
  Temporal health, and a delivery signal (`temporal-supabase-network`).
- [ ] 12. Mark `temporal-supabase-docker-network` Done as a duplicate only
  after task 11 covers its cause and acceptance criteria.

### Wave 1: delivery correctness

- [ ] 13. Make no-preview handoff accept an exact already-merged PR/head SHA
  without fetching a deleted branch; add regression tests for merged/deleted,
  open/existing, and mismatched-SHA cases (`no-preview-post-merge-fetch-race`).
- [ ] 14. Send operation-helper payload through structured stdin and test
  Russian text, spaces, quotes, dollar signs, semicolons, ampersands, pipes,
  and newlines through the real SSH boundary (`create-operation-remote-quoting`).
- [ ] 15. Add an exact Ansible-managed sudoers entry for the Codex smoke as the
  service user; run `visudo`, prove the exact command succeeds, and prove a
  neighboring arbitrary command is denied (`codex-smoke-sudoers-contract`).

### Wave 2: runtime and data safety

- [ ] 16. Make API SIGTERM shutdown bounded and idempotent; add a subprocess
  regression test with active reconciliation, then verify two production
  restarts complete below the systemd timeout (`brai-api-graceful-shutdown`).
- [ ] 17. Stage APK JSON and HTML, validate permissions/rendering before atomic
  rename, and execute a failure-injection rollback test as the deploy owner
  (`apk-rollback-release-permissions`).

### Wave 3: publication guard

- [ ] 18. Add an email-template publication check requiring unauthenticated
  HTTPS 200 and `image/*` for every external image URL; cover wrong MIME,
  authentication, missing asset, and the live production URL
  (`email-image-public-url-check`).

### Closure gate

- [ ] 19. Rerun task, Temporal, API, OpenSpec, public-guard, and affected live
  checks; complete only operations with recorded passing evidence and list the
  remaining New rows.
