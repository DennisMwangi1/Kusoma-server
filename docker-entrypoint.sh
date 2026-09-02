#!/bin/sh
set -e

echo "kusoma-server: migrate"
node dist/db/migrate.js

echo "kusoma-server: seed"
node dist/db/seed.js

echo "kusoma-server: start"
exec node dist/index.js
