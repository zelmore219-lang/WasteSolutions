# Deployment and operations requirements

The current starter choice is [free-tier hosting](FREE_HOSTING_SETUP.md): Firebase Spark sign-in, Render Free for web/API, and Supabase Free for PostgreSQL/private storage. The Google Cloud Run/Cloud SQL/GCS instructions below remain a paid alternative for later; they are not required for the chosen trial route. Free quotas/availability and actual deployed acceptance must be reviewed before customer launch.


No cloud resources have been created or deployed. No production release has been made.

## Development / testing / production isolation

Use separate GCP and Firebase projects (or equivalently isolated resources), PostgreSQL databases, Storage buckets, provider accounts/modes, service accounts and domains per environment. Never point tests at company data. Configure only the intended web origin; a wildcard CORS policy is unnecessary.

API variables: `DATABASE_URL`, `FIREBASE_PROJECT_ID`, `WEB_ORIGIN`, `PORT`. Firebase Admin uses ADC or a workload identity. The web's `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, and `VITE_FIREBASE_PROJECT_ID` are public client configuration, not authorization secrets. Mobile uses the corresponding `EXPO_PUBLIC_FIREBASE_*` variables plus an HTTPS `EXPO_PUBLIC_API_URL`. The Windows shell uses `COREWASTE_WEB_URL` pointing at the company's deployed web app.

Before production, validate Cloud SQL connector/TLS and least-privilege database users; the current local setup intentionally uses an unrestricted development database owner. Enable Cloud SQL automated backups, PITR and retention, and perform a restoration rehearsal into an isolated database. Confirm restored invoice/journal totals, order history, identity bindings and attachment consistency. Do not restore over live data during a drill. Add monitored health/error rates, latency, audit retention, log redaction, alert ownership and incident procedures.

## Cloud Run and web

The root Dockerfile compiles and runs the API as a non-root user. In this proxy environment build with `docker build --secret id=proxy_ca,src="$CODEX_PROXY_CERT" -t corewaste-api .`; the build CA is mounted, not copied into the image. The runtime needs its cloud identity, database connection and Firebase project. The image now prunes development/native dependencies; complete the remaining image/dependency vulnerability work before deployment. Container build and deployment are separate acceptance checks.

Deploy the web build to a TLS host with SPA fallback and `/api` routed to the API. Vite's development proxy is not a production reverse proxy. Configure Firebase authorized domains and web CSP for the actual auth endpoints. Run migrations as an authorized deployment job; then smoke-test identity, ownership, dispatch, invoicing and the customer portal before shifting traffic. Rollback must preserve financial records; never reverse migrations by deleting business history.

## Native builds

Windows: GitHub Actions runs Electron Builder on Windows. Configure code signing via protected CI secrets before any public distribution. Unsigned artifacts are development-only. Desktop startup needs a deployed HTTPS URL. Validate login/MFA, updates, TLS, navigation restrictions, printing and installation/uninstallation on supported Windows versions.

Android: initialize the Expo/EAS project and set its project ID, configure Firebase client/API variables in the build environment, provision the signing keystore, then trigger the internal `test` profile (`.apk`). Validate queue persistence, revocation, reassignment conflicts, interrupted synchronization, navigation and device encryption.

iOS: an Apple Developer account, certificates/provisioning profiles and registered devices are required for the internal profile. Native build uses macOS/EAS; it cannot be validated as an installed iPhone app from this Linux environment. Perform device tests before TestFlight or App Store submissions. The supplied workflow queues an internal build only; it does not submit a release.

## External integration acceptance and remaining implementation

The implemented payment flow uses hosted collection, verified signatures and stable idempotency/event keys. Real provider acceptance, provider refunds and full reconciliation remain. Never store card numbers or trust a browser redirect as payment confirmation. QuickBooks OAuth and journal export are implemented; Intuit acceptance and native document/bank reconciliation remain. Notification outboxes/provider adapters and private storage are implemented; real delivery, cloud bucket policy and retention acceptance remain. Routing must use actual road-network data and truck constraints; a navigation link is not route optimization. Scales require documented vendor framing/units/stability/calibration rules and tests with actual hardware.

## Packaged production commands

The API image includes compiled entry points that run without tsx or a local .env file. Supply environment variables and identities through the deployment platform:

- API: node apps/api/dist/main.js
- One-off authorized database migration job: node apps/api/dist/migrate.js
- Authorized scheduled operations/delivery job: node apps/api/dist/run-jobs.js

Migrations use a database advisory lock and apply numbered SQL files transactionally. Run the migration job with a separate schema-owner identity, then run the API with its restricted application identity. Do not automatically run schema changes during every API startup.

The scheduled job requires JOB_ACTOR_ID for an existing active owner/manager service principal and uses the configured providers. Deploying/scheduling it enables real billing/provider activity, so acceptance must use isolated provider accounts and databases first. No deployed schedule was created in this workspace.

The image prunes development dependencies and excludes local caches, private development storage, tests and attachments. Current image runtime health, unauthenticated rejection, empty-database migration and migration repeatability have been checked locally. Cloud Run deployment, cloud identity, Cloud SQL connectivity, bucket policy and production backup/restore remain separate unrun acceptance steps.

The current image dependency subset reports eight moderate findings; the full workspace includes the separate high Expo/Metro image-size finding recorded in VALIDATION.md.

## Recent application additions

Customer rate cards and quoted-order snapshots require migration 033. Road planning requires migrations 031 and secure routing configuration documented in ROAD_PLANNING.md. Vendor bills/settlements require migration 032; PAYABLES.md describes posting dates and historical reports. No live provider acceptance or publication was performed for these additions. Electron is now 45.2.3; revalidate Windows installation/printing/MFA and signing with that version before distribution.

Migrations 034–036 add agreed ordinary-service fees, material stock and physical container confirmation. Deploy the current driver and web clients with the updated API; old queued rental completions without typed equipment confirmation require retained office review. See SERVICE_FEES.md, MATERIAL_STOCK.md and CONTAINER_CONFIRMATION.md. The Metro patch and remaining audit findings are documented in DEPENDENCY_REVIEW.md.
