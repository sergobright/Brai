#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

npm run build

if [ "$(id -u)" = "0" ]; then
  /usr/bin/systemctl restart brai-admin.service
else
  /usr/bin/sudo -n /usr/bin/systemctl restart brai-admin.service
fi

/usr/bin/systemctl is-active --quiet brai-admin.service
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS http://127.0.0.1:3040/ >/dev/null 2>&1; then
    exit 0
  fi
  sleep 1
done

curl -fsS http://127.0.0.1:3040/ >/dev/null
