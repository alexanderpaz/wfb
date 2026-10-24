#!/bin/sh
# Runs inside the postgres container, e.g. from a host cron (Coolify uses the one-line
# command in deploy/COOLIFY.md because it cannot mount repo files):
#   docker exec -i postgres-<uuid> sh -s < deploy/scripts/pg-backup.sh
# Writes a custom-format dump to /backups and keeps the last BACKUP_KEEP_DAYS days.
set -eu

dir="${BACKUP_DIR:-/backups}"
keep="${BACKUP_KEEP_DAYS:-14}"
file="$dir/${POSTGRES_DB}-$(date -u +%Y%m%dT%H%M%SZ).dump"

mkdir -p "$dir"
pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner --file="$file.partial"
mv "$file.partial" "$file"
find "$dir" -name '*.dump' -type f -mtime +"$keep" -delete
echo "backup written: $file ($(du -h "$file" | cut -f1))"
