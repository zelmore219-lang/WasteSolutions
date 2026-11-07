#!/usr/bin/env bash
set -euo pipefail
# For local development only. Do not expose this database outside loopback.
docker_cmd=(env -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_TLS -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH docker --host=unix:///var/run/docker.sock)
if "${docker_cmd[@]}" container inspect corewaste-postgres >/dev/null 2>&1; then
  "${docker_cmd[@]}" start corewaste-postgres >/dev/null
else
  "${docker_cmd[@]}" run -d --name corewaste-postgres \
    -e POSTGRES_USER=corewaste -e POSTGRES_PASSWORD=corewaste_local_only -e POSTGRES_DB=corewaste \
    -p 127.0.0.1:5432:5432 -v corewaste-local-data:/var/lib/postgresql/data \
    postgres:17@sha256:ff87138949ad9a46f32ff23bd6852b52ce024a13dffe9b4087be98292cdd3b4f >/dev/null
fi
for attempt in {1..30}; do
 if "${docker_cmd[@]}" exec corewaste-postgres pg_isready -U corewaste >/dev/null; then exit 0; fi
 sleep 1
done
echo 'PostgreSQL did not become ready; inspect docker logs corewaste-postgres' >&2
exit 1
