#!/usr/bin/env bash
set -euo pipefail
umask 077
# A local, disposable test-database drill. Production backup/restore uses managed Cloud SQL.
source_database="$(printenv RESTORE_DRILL_SOURCE || true)"
if [ -z "$source_database" ]; then source_database=corewaste_test; fi
[[ "$source_database" =~ ^[a-z][a-z0-9_]*_test$ ]] || { echo 'The drill accepts only a dedicated *_test source database' >&2; exit 1; }
target_database="cw_restore_$(date -u +%Y%m%d%H%M%S)_$RANDOM""_test"
docker_local() { env -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_TLS -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH docker --host=unix:///var/run/docker.sock "$@"; }
backup_dir=".local/restore-drills"
mkdir -p "$backup_dir"
chmod 700 "$backup_dir"
archive="$backup_dir/$target_database.dump"
docker_local exec corewaste-postgres pg_dump -U corewaste --format=custom --no-owner --no-privileges --dbname="$source_database" > "$archive"
created=false
cleanup() {
 if [ "$created" = true ]; then docker_local exec corewaste-postgres dropdb -U corewaste --if-exists --force "$target_database" >/dev/null; fi
}
trap cleanup EXIT
docker_local exec corewaste-postgres createdb -U corewaste "$target_database"
created=true
docker_local exec -i corewaste-postgres pg_restore -U corewaste --exit-on-error --no-owner --no-privileges --dbname="$target_database" < "$archive"
# Fingerprint every public base table in a deterministic row order. No row data is printed.
fingerprint_sql="SELECT 'SELECT ' || quote_literal(tablename) || ' AS name, count(*) AS rows, md5(COALESCE(string_agg(value, ' || quote_literal('') || ' ORDER BY value), ' || quote_literal('') || ')) AS fingerprint FROM (SELECT row_to_json(t)::text AS value FROM public.' || quote_ident(tablename) || ' t) data;' FROM pg_tables WHERE schemaname='public' ORDER BY tablename"
commands="$(docker_local exec corewaste-postgres psql -U corewaste -d "$target_database" -Atc "$fingerprint_sql")"
docker_local exec corewaste-postgres psql -U corewaste -d "$source_database" -Atc "$commands" > "$backup_dir/source.fingerprints"
docker_local exec corewaste-postgres psql -U corewaste -d "$target_database" -Atc "$commands" > "$backup_dir/restored.fingerprints"
if ! cmp -s "$backup_dir/source.fingerprints" "$backup_dir/restored.fingerprints"; then
 echo 'Restore finished but source changed or table fingerprints differ; investigate before claiming recovery readiness.' >&2
 exit 1
fi
echo 'Restore drill passed: every public table matches the source row count and content fingerprint.'
echo "Private local test archive retained at $archive"
