#!/bin/sh
set -e

if [ -n "$DATABASE_URL" ]; then
  echo "Running database migrations..."
  npx --no-install prisma migrate deploy --schema prisma/schema.prisma
fi

exec "$@"
