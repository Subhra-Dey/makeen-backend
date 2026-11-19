#!/bin/sh
set -e

echo "==> Running database migrations..."
npx prisma migrate deploy || { echo "Migration failed"; exit 1; }

echo "==> Seeding database if empty..."
ALLOW_PROD_SEED=true npm run db:seed || true

echo "==> Starting MAKEEN API server..."
exec node dist/main.js
