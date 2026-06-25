# Local Services And Ops

- Install reusable tooling/runtime support under `/srv/opt/`.
- Keep actively developed projects under `/srv/projects/`.
- Keep runtime service registry outside the repository.
- Do not store secrets, tokens, private keys, hashes, or signing material in docs.

## Network

- External inbound ports stay closed by default.
- Only SSH `22/tcp`, HTTPS `443/tcp`, and HTTP `80/tcp` for redirects are expected.
- App services bind to localhost behind Caddy.
- Server host/IP values are configured outside the repository.

## Local Services

- Kroki may be available at `http://127.0.0.1:8000` for diagram rendering.
- Bright OS API services use Node.js 22+ and localhost-only ports behind Caddy.
