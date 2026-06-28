#!/usr/bin/env bash
set -euo pipefail

exec /srv/opt/node-v22.16.0/bin/node /srv/opt/bright-os-codex-plugins/plugins/bright-os-guard/hooks/bright-os-guard.mjs start "$@"
