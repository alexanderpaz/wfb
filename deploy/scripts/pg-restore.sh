#!/bin/sh
# Restores a dump produced by pg-backup.sh. Stop the app service first.
#   docker exec -i postgres-<uuid> sh -s /backups/wfb-20260101T030000Z.dump < deploy/scripts/pg-restore.sh
set -eu

file="${1:?usage: pg-restore.sh /backups/<file>.dump}"
[ -f "$file" ] || { echo "not found: $file" >&2; exit 1; }

pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner --single-transaction "$file"
echo "restored: $file"
