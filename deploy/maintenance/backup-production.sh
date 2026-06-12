#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"

COMPOSE_FILE="${COMPOSE_FILE:-${PROJECT_DIR}/docker-compose.prod.yml}"
ENV_FILE="${ENV_FILE:-${PROJECT_DIR}/.env.production}"
BACKUP_DIR="${BACKUP_DIR:-${PROJECT_DIR}/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
STAMP="$(date +%Y%m%d_%H%M%S)"

mkdir -p "${BACKUP_DIR}"

if [ ! -f "${ENV_FILE}" ]; then
  echo "Missing env file: ${ENV_FILE}" >&2
  exit 1
fi

ENV_BACKUP="${BACKUP_DIR}/env.production.${STAMP}.bak"
SQL_BACKUP="${BACKUP_DIR}/vidlive_${STAMP}.sql"

cp "${ENV_FILE}" "${ENV_BACKUP}"
chmod 600 "${ENV_BACKUP}"

docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" exec -T postgres sh -lc \
  'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' > "${SQL_BACKUP}"

if [ ! -s "${SQL_BACKUP}" ]; then
  echo "Database backup is empty: ${SQL_BACKUP}" >&2
  exit 1
fi

gzip -f "${SQL_BACKUP}"

if [ "${RETENTION_DAYS}" -gt 0 ] 2>/dev/null; then
  find "${BACKUP_DIR}" -type f \
    \( -name 'vidlive_*.sql.gz' -o -name 'env.production.*.bak' \) \
    -mtime +"${RETENTION_DAYS}" -delete
fi

echo "Environment backup: ${ENV_BACKUP}"
echo "Database backup: ${SQL_BACKUP}.gz"
