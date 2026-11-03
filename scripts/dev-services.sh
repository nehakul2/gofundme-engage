#!/usr/bin/env bash
# Starts local Postgres and Redis without Docker (for sandboxes where Docker is unavailable).
# Needs Postgres 16 binaries; run as root it uses the "postgres" user. Idempotent.
set -e
PGBIN=${PGBIN:-/usr/lib/postgresql/16/bin}
DATA=${PGDATA_DIR:-/tmp/pgdata}
if ! (pg_isready -h localhost -q 2>/dev/null); then
  if [ ! -d "$DATA" ]; then
    mkdir -p "$DATA"; chown postgres "$DATA"
    su postgres -c "$PGBIN/initdb -D $DATA -A trust >/dev/null"
  fi
  rm -f "$DATA/postmaster.pid"
  su postgres -c "$PGBIN/pg_ctl -D $DATA -l /tmp/pg.log -o '-p 5432 -k /tmp' start" >/dev/null
fi
redis-cli ping >/dev/null 2>&1 || redis-server --port 6379 --daemonize yes >/dev/null
for db in gofundme gofundme_test; do
  psql -h localhost -U postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$db'" | grep -q 1 || psql -h localhost -U postgres -qc "CREATE DATABASE $db"
done
echo "postgres and redis are up"
