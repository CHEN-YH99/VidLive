#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"

COMPOSE_FILE="${COMPOSE_FILE:-${PROJECT_DIR}/docker-compose.prod.yml}"
ENV_FILE="${ENV_FILE:-${PROJECT_DIR}/.env.production}"
LOCAL_URL="${LOCAL_URL:-http://127.0.0.1:8000}"
PUBLIC_URL="${PUBLIC_URL:-https://vidlive.cc.cd}"
DISK_WARN_PERCENT="${DISK_WARN_PERCENT:-85}"

cd "${PROJECT_DIR}"

echo "== Docker services =="
docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" ps

echo "== Local health =="
curl -fsS "${LOCAL_URL}/api/health"
echo

echo "== Public health =="
curl -fsS "${PUBLIC_URL}/api/health"
echo

if command -v systemctl >/dev/null 2>&1; then
  echo "== cloudflared =="
  systemctl is-active --quiet cloudflared
  echo "cloudflared active"
fi

disk_percent="$(df -P / | tail -n 1 | tr -s ' ' | cut -d ' ' -f 5 | tr -d '%')"
echo "Root disk usage: ${disk_percent}%"

if [ "${disk_percent}" -ge "${DISK_WARN_PERCENT}" ]; then
  echo "Disk usage is above ${DISK_WARN_PERCENT}%." >&2
  exit 1
fi

echo "Health check passed."
