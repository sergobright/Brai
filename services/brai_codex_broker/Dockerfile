FROM node:22.16.0-bookworm-slim

ARG CODEX_VERSION=0.144.4
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global --omit=dev "@openai/codex@${CODEX_VERSION}" \
    && npm cache clean --force

LABEL org.opencontainers.image.title="Brai Codex App Server" \
      org.opencontainers.image.version="0.144.4" \
      world.brightos.brai.codex-version="0.144.4"

RUN useradd --uid 65532 --user-group --no-create-home --shell /usr/sbin/nologin codex \
    && mkdir -p /etc/codex
USER 65532:65532
WORKDIR /workspace
ENV CODEX_HOME=/codex-home HOME=/codex-home TMPDIR=/tmp

CMD ["codex", "app-server", "--strict-config", "--listen", "stdio://"]
