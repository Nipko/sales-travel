#!/usr/bin/env bash
set -euo pipefail

DB_NAME="sales_travel"
PGUSER="postgres"
export PGPASSWORD="postgres"
MIGRATIONS_DIR="/mnt/c/Users/USER/Desktop/Projects/sales-travel/db/migrations"
APP_USER_PASSWORD="pass"

echo "=== Starting WSL Migration Runner ==="

# 1. Ensure app_user role exists
echo "Ensuring role 'app_user' exists..."
psql -h localhost -U "$PGUSER" -d "$DB_NAME" -c "
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '$APP_USER_PASSWORD';
  ELSE
    ALTER ROLE app_user WITH PASSWORD '$APP_USER_PASSWORD';
  END IF;
END \$\$;
"

# 2. Ensure schema_migrations table exists
echo "Ensuring table 'schema_migrations' exists..."
psql -h localhost -U "$PGUSER" -d "$DB_NAME" -c "
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    TEXT        PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
"

# 3. Get applied migrations
echo "Fetching applied migrations..."
APPLIED_MIGRATIONS=$(psql -h localhost -U "$PGUSER" -d "$DB_NAME" -t -A -c "SELECT version FROM schema_migrations;")

# Convert to bash array or check function
is_applied() {
  local version="$1"
  for app in $APPLIED_MIGRATIONS; do
    if [ "$app" = "$version" ]; then
      return 0
    fi
  done
  return 1
}

# 4. List and apply migrations
echo "Scanning for migrations in $MIGRATIONS_DIR..."
applied_count=0

# Sort files alphabetically
for filepath in $(ls "$MIGRATIONS_DIR"/*.sql | sort); do
  filename=$(basename "$filepath")
  version="${filename%.sql}"

  if is_applied "$version"; then
    echo "= $version (skipped, already applied)"
  else
    echo "▶ applying $version"
    
    # We use a single psql transaction to run the migration and insert the record
    psql -h localhost -U "$PGUSER" -d "$DB_NAME" -v ON_ERROR_STOP=1 <<EOF
BEGIN;
\i $filepath
INSERT INTO schema_migrations (version) VALUES ('$version');
COMMIT;
EOF

    echo "✓ $version"
    applied_count=$((applied_count + 1))
  fi
done

echo "Done. Applied $applied_count new migration(s)."
