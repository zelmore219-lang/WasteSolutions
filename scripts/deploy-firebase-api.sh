#!/usr/bin/env bash
# Authorized operator only: creates/updates the named Cloud Run job/service and runs migrations.
# Cloud SQL, IAM, private bucket, secrets and billing must already be provisioned/reviewed.
set -euo pipefail
project=wastesoloutions
region=us-central1
: "${COREWASTE_IMAGE:?Set an Artifact Registry image pinned with @sha256: digest}"
: "${COREWASTE_SQL_INSTANCE:?Set wastesoloutions:us-central1:INSTANCE}"
: "${COREWASTE_API_ACCOUNT:?Set the least-privilege runtime service-account email}"
: "${COREWASTE_MIGRATION_ACCOUNT:?Set a separate migration service-account email}"
: "${COREWASTE_DATABASE_SECRET:?Set the application database URL Secret Manager name}"
: "${COREWASTE_PROVIDER_KEY_SECRET:?Set the provider encryption key Secret Manager name}"
: "${COREWASTE_MIGRATION_SECRET:?Set the schema-owner database URL Secret Manager name}"
[[ "$COREWASTE_IMAGE" =~ ^us-central1-docker\.pkg\.dev/wastesoloutions/[a-z0-9_-]+/[a-z0-9_-]+@sha256:[a-f0-9]{64}$ ]] || { echo 'Use a reviewed image digest in this project/region.' >&2; exit 1; }
[[ "$COREWASTE_SQL_INSTANCE" =~ ^wastesoloutions:us-central1:[a-z][a-z0-9-]+$ ]] || exit 1
for account in "$COREWASTE_API_ACCOUNT" "$COREWASTE_MIGRATION_ACCOUNT"; do
 [[ "$account" =~ ^[a-z][a-z0-9-]+@wastesoloutions\.iam\.gserviceaccount\.com$ ]] || exit 1
done
[[ "$COREWASTE_API_ACCOUNT" != "$COREWASTE_MIGRATION_ACCOUNT" ]] || { echo 'Use distinct runtime and schema-owner identities.' >&2; exit 1; }
for secret in "$COREWASTE_DATABASE_SECRET" "$COREWASTE_MIGRATION_SECRET" "$COREWASTE_PROVIDER_KEY_SECRET"; do
 [[ "$secret" =~ ^[a-zA-Z][a-zA-Z0-9_-]+$ ]] || exit 1
done
command -v gcloud >/dev/null || { echo 'Install Google Cloud CLI and sign in securely first.' >&2; exit 1; }
test -n "$(gcloud auth list --filter=status:ACTIVE --format='value(account)')" || { echo 'No active Google Cloud login.' >&2; exit 1; }
gcloud run jobs deploy corewaste-migrate --project="$project" --region="$region" \
 --image="$COREWASTE_IMAGE" --service-account="$COREWASTE_MIGRATION_ACCOUNT" \
 --set-cloudsql-instances="$COREWASTE_SQL_INSTANCE" \
 --set-secrets="DATABASE_URL=$COREWASTE_MIGRATION_SECRET:latest" \
 --set-env-vars=NODE_ENV=production,FIREBASE_PROJECT_ID=wastesoloutions \
 --command=node --args=apps/api/dist/migrate.js --tasks=1 --max-retries=0 --task-timeout=600s
gcloud run jobs execute corewaste-migrate --project="$project" --region="$region" --wait
gcloud run deploy corewaste-api --project="$project" --region="$region" \
 --image="$COREWASTE_IMAGE" --service-account="$COREWASTE_API_ACCOUNT" \
 --add-cloudsql-instances="$COREWASTE_SQL_INSTANCE" \
 --set-secrets="DATABASE_URL=$COREWASTE_DATABASE_SECRET:latest,PROVIDER_SETTINGS_KEY=$COREWASTE_PROVIDER_KEY_SECRET:latest" \
 --set-env-vars=NODE_ENV=production,FIREBASE_PROJECT_ID=wastesoloutions,WEB_ORIGIN=https://wastesoloutions.web.app,STORAGE_DRIVER=gcs,GCS_BUCKET=wastesoloutions.firebasestorage.app,NOTIFICATIONS_WORKER_ENABLED=false,PAYMENTS_MODE=test \
 --allow-unauthenticated --ingress=all --port=8080 --memory=1Gi --cpu=1 --concurrency=20 --max-instances=3 --timeout=60s
# Cloud Run's public transport is required for Hosting. Business routes still require Firebase tokens.
# Do not deploy Hosting until this service is healthy and employee access is accepted.
