#!/bin/sh
set -eu

if [ ! -w "${DATA_DIR:-/app/data}" ]; then
  echo "ERROR: ${DATA_DIR:-/app/data} is not writable by uid $(id -u) gid $(id -g)." >&2
  echo "Fix the ownership of the data volume or PUID/PGID (see deploy/COOLIFY.md)." >&2
  exit 1
fi

if [ -n "${DATABASE_URL:-}" ]; then
  attempt=1
  until ./node_modules/.bin/prisma migrate deploy --schema prisma/schema.prisma; do
    if [ "$attempt" -ge "${MIGRATE_RETRIES:-5}" ]; then
      echo "ERROR: database migrations failed after $attempt attempts." >&2
      exit 1
    fi
    echo "Migrations failed (attempt $attempt), retrying in 5s..." >&2
    attempt=$((attempt + 1))
    sleep 5
  done
fi

exec "$@"
