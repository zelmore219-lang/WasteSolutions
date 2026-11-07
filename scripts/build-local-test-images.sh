#!/usr/bin/env bash
set -euo pipefail
# Reproducible build only; never publish images or modify running business containers.
docker_local() { env -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_TLS -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH docker --host=unix:///var/run/docker.sock "$@"; }
proxy_secret=()
if [ -n "${CODEX_PROXY_CERT:-}" ]; then proxy_secret=(--secret "id=proxy_ca,src=$CODEX_PROXY_CERT"); fi
docker_local build "${proxy_secret[@]}" -t corewaste-api:development .
docker_local build "${proxy_secret[@]}" -f distribution/local-test/Dockerfile.auth -t corewaste/local-auth:0.2.0 .
docker_local build -f distribution/local-test/Dockerfile.api -t corewaste/local-api:0.2.0 .
docker_local build "${proxy_secret[@]}" -f distribution/local-test/Dockerfile.web -t corewaste/local-web:0.2.0 .
docker_local pull postgres:17@sha256:ff87138949ad9a46f32ff23bd6852b52ce024a13dffe9b4087be98292cdd3b4f
docker_local tag postgres:17@sha256:ff87138949ad9a46f32ff23bd6852b52ce024a13dffe9b4087be98292cdd3b4f corewaste/local-postgres:0.2.0
