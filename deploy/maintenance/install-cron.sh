#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
LOG_DIR="${PROJECT_DIR}/logs/maintenance"

BACKUP_SCHEDULE="${BACKUP_SCHEDULE:-10 3 * * *}"
HEALTH_SCHEDULE="${HEALTH_SCHEDULE:-*/10 * * * *}"

if ! command -v crontab >/dev/null 2>&1; then
  echo "crontab is not installed. Install cronie first." >&2
  exit 1
fi

mkdir -p "${LOG_DIR}"

BACKUP_JOB="${BACKUP_SCHEDULE} cd ${PROJECT_DIR} && /usr/bin/env bash deploy/maintenance/backup-production.sh >> logs/maintenance/backup.log 2>&1"
HEALTH_JOB="${HEALTH_SCHEDULE} cd ${PROJECT_DIR} && /usr/bin/env bash deploy/maintenance/health-check.sh >> logs/maintenance/health.log 2>&1"

TMP_FILE="$(mktemp)"
trap 'rm -f "${TMP_FILE}"' EXIT

{
  crontab -l 2>/dev/null | grep -v 'deploy/maintenance/backup-production.sh' | grep -v 'deploy/maintenance/health-check.sh' || true
  echo "${BACKUP_JOB}"
  echo "${HEALTH_JOB}"
} > "${TMP_FILE}"

crontab "${TMP_FILE}"

echo "Installed cron jobs:"
crontab -l | grep 'deploy/maintenance/'
