#!/usr/bin/env bash
set -euo pipefail
umask 077
# Test only against the managed local Docker daemon and a fresh disposable database.
image_ref="${1:-corewaste-api:development}"
verification_database="cw_image_$(date -u +%Y%m%d%H%M%S)_$RANDOM""_test"
verification_container="corewaste-image-check-$(date -u +%s)-$RANDOM"
created=false
docker_local() { env -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_TLS -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH docker --host=unix:///var/run/docker.sock "$@"; }
cleanup() {
 docker_local rm -f "$verification_container" >/dev/null 2>&1 || true
 if [ "$created" = true ]; then docker_local exec corewaste-postgres dropdb -U corewaste --if-exists --force "$verification_database" >/dev/null; fi
}
trap cleanup EXIT
expected_count="$(rg --files database | rg '/[0-9]+_[^/]+\.sql$' | wc -l | tr -d ' ')"
docker_local exec corewaste-postgres createdb -U corewaste "$verification_database"
created=true
for pass in 1 2; do
 docker_local run --rm --network container:corewaste-postgres -e "DATABASE_URL=postgres://corewaste:corewaste_local_only@127.0.0.1:5432/$verification_database" "$image_ref" node apps/api/dist/migrate.js
done
actual_count="$(docker_local exec corewaste-postgres psql -U corewaste -d "$verification_database" -Atc 'SELECT count(*) FROM schema_migrations')"
[ "$actual_count" = "$expected_count" ] || { echo 'Compiled migration count does not match source' >&2; exit 1; }
docker_local run -d --name "$verification_container" --network container:corewaste-postgres -e "DATABASE_URL=postgres://corewaste:corewaste_local_only@127.0.0.1:5432/$verification_database" -e FIREBASE_PROJECT_ID=demo-corewaste -e NODE_ENV=test -e PORT=3001 "$image_ref" >/dev/null
ready=false
for attempt in 1 2 3 4 5 6 7 8 9 10; do
 if docker_local exec "$verification_container" node -e 'fetch("http://127.0.0.1:3001/api/health").then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))'; then ready=true; break; fi
 sleep 1
done
[ "$ready" = true ] || { echo 'Compiled API did not become healthy' >&2; exit 1; }
docker_local exec "$verification_container" node -e 'const paths=["/api/stock/materials","/api/customers/00000000-0000-4000-8000-000000000000/fee-policies","/api/orders","/api/provider-refunds","/api/billing/contract-recognition","/api/equipment/yards"];Promise.all(paths.map(p=>fetch("http://127.0.0.1:3001"+p))).then(rs=>{if(rs.some(r=>r.status!==401))process.exit(1);console.log("Stock, fee, order, refund, contract and equipment endpoints reject unauthenticated access: 401");})'
docker_local exec "$verification_container" node -e 'if(process.getuid()===0)process.exit(1);try{require.resolve("tsx");process.exit(1);}catch{};console.log("Non-root API; development runner absent")'
printf 'Verified %s compiled migrations; second run idempotent; API health: 200\n' "$actual_count"
