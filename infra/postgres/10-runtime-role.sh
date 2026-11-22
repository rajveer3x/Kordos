#!/bin/sh
set -eu

psql --set=ON_ERROR_STOP=1 --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" <<'SQL'
\getenv app_password POSTGRES_APP_PASSWORD
CREATE ROLE kordos_app LOGIN PASSWORD :'app_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
SQL
