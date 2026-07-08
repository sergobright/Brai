# System Patterns

- Next.js client source lives in `apps/brai_app/`.
- Brai API source lives in `services/brai_api/`.
- Accepted requirements live in `openspec/specs/`.
- Development rules live in `docs/guidelines/`.
- Deployment source automation lives in `deploy/`; generated deploy output does not.

Deployment branch classes:

- `main` deploys production.
- `codex/*` deploys preview slots `A` through `E`.
Security boundaries:

- Browser web uses same-origin `/api`.
- Brai Admin is served as `/admin` inside each environment; prod uses the primary-user account gate, dev/preview also use Caddy Basic Auth.
- Android uses the configured environment API endpoint.
- Release signing uses environment variables only.
- GitHub Actions receives deploy credentials through repository secrets and variables.
