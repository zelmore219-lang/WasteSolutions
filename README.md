# CoreWaste

CoreWaste's single-company waste operations system. React/TypeScript office and customer views, NestJS API, PostgreSQL, Firebase identity, Electron Windows shell, and React Native driver client share one business data model.

**Development milestone, not a finished or production-ready system.** See [feature and acceptance status](docs/FEATURES.md), [architecture](docs/ARCHITECTURE.md), and [deployment requirements](docs/DEPLOYMENT.md). No sample customer records or simulated payment success are installed.

## Free-tier hosting setup

The active starter route is **Firebase Spark authentication + Render Free web/API + Supabase Free database/private files**. See [step-by-step setup](docs/FREE_HOSTING_SETUP.md). The root `render.yaml` and `Dockerfile.free` prepare that route. Live deployment still requires the owner’s private service configuration and acceptance checks.

## Demo login, icon and provider settings

Version0.3.0 adds the logo-based app icon and [Settings → Providers](docs/PROVIDER_SETTINGS.md). The isolated emulator accepts **demo / password1** with dispatcher permissions; production access is unchanged. Provider secrets require the backend encryption key; apply migration048. This does not make the hosted Windows client an offline demo.

## Windows installer download

[Download the Windows installer](https://github.com/zelmore219-lang/WasteSolutions/releases/download/demo-v0.3.0/CoreWaste-Setup-0.3.0-x64.exe). The public release download was verified end to end. See [download and installation steps](DOWNLOAD-WINDOWS.md). The current client requires hosted services for business features; cloud activation remains pending.

## Firebase-hosted Windows client

The current direction is Firebase sign-in/Hosting with the API on Cloud Run and PostgreSQL. The preconfigured Windows client requires no Docker on the user’s computer. See [Firebase release preparation](docs/FIREBASE_RELEASE.md). Cloud activation is pending; the verified installer is available as a public GitHub prerelease; the owner plans to enable billing later.

## Windows local test kit

The 0.2.0 full test kit includes local services and test sign-ins; Docker Desktop with Linux containers is required. See [Windows download and startup instructions](docs/WINDOWS_TEST.md). A public download and actual Windows-machine acceptance remain pending.

## Local development

Requires Node 22+, npm, and a working local Docker daemon.

```sh
cd /workspace/WasteSolutions
# Preserve any existing .env. Example contains only disposable local DB settings.
test -f .env || cp .env.example .env
XDG_CACHE_HOME=/workspace/.cache ELECTRON_GET_USE_PROXY=1 GLOBAL_AGENT_HTTP_PROXY="$HTTP_PROXY" npm ci --cache /workspace/.npm-cache
bash scripts/local-db.sh
node --env-file=.env --import tsx scripts/migrate.ts
npm run dev:api
# In another terminal:
npm run dev:web
```

On a normal workstation the cache location can be omitted. Electron's proxy variables are only needed in a managed proxy environment. Do not disable TLS or checksum verification. If the Electron runtime is not needed locally, `ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci` installs source dependencies; actual desktop execution then requires a verified runtime installation.

The API runs on port 3000 and Vite on 5173; Vite proxies `/api`. `GET /api/health` verifies the database. Business routes require a valid Firebase token and a provisioned active account. Configure the Firebase fields in `.env` and use Application Default Credentials with permission to verify token revocation. No auth bypass or default user/password exists. Email sign-in and authenticator-app MFA challenges are supported. To enable employee username login, set `VITE_EMPLOYEE_LOGIN_DOMAIN` to a company-owned domain and provision each employee identity with the matching `USERNAME@DOMAIN` Firebase email alias. The operator helper verifies the mapping. Do not invent a domain or use another company’s domain. SMS/TOTP challenges, authenticator enrollment and verified-email account setup are implemented; production provider configuration and device acceptance remain. See docs/FIREBASE_SETUP.md for the current environment connection.

Bootstrap an existing Firebase identity using an authorized operator's ADC:

```sh
node --env-file=.env --import tsx scripts/provision.ts account FIREBASE_UID username 'Display Name' dispatcher
node --env-file=.env --import tsx scripts/provision.ts account DRIVER_FIREBASE_UID driver.name 'Driver Name' driver
node --env-file=.env --import tsx scripts/provision.ts account CUSTOMER_FIREBASE_UID customer.name 'Customer Name' customer CUSTOMER_UUID
node --env-file=.env --import tsx scripts/provision.ts truck CW-101
```

These commands write real development records. Never run provisioning against production without the appropriate authorization. Customers and locations are created in the office UI; a driver and available truck are necessary for dispatch. The public website is at /, the office application at /office and the customer portal at /portal. Verified customer registration requests require office approval. Company, employee, fleet and security administration are available to authorized roles.

## Validation

Create a separate disposable test database (once), migrate it, then run tests:

```sh
docker exec corewaste-postgres createdb -U corewaste corewaste_test
DATABASE_URL=postgres://corewaste:corewaste_local_only@127.0.0.1:5432/corewaste_test npm run db:migrate
TEST_DATABASE_URL=postgres://corewaste:corewaste_local_only@127.0.0.1:5432/corewaste_test npm test
npm run typecheck
npm run build
```

Tests write uniquely named fixtures in `*_test`; they never reset a business database. They cover the PostgreSQL service workflow, request conversion, recurring generation, ordered routes, access controls, journal immutability, concurrent retries, HTTP unauthenticated rejection, and offline command replay. Separate Firebase emulator integration and Chromium workflows cover authentication, MFA, customer registration, payments, reports and driver tasks. Installed-device acceptance, live external providers and production cloud deployment remain unrun.

## Windows and mobile

```sh
COREWASTE_WEB_URL=https://YOUR_COREWASTE_WEB_HOST npm start -w @corewaste/desktop
npm run package:windows -w @corewaste/desktop
# Configure EXPO_PUBLIC_API_URL and EXPO_PUBLIC_FIREBASE_* in the driver app's environment:
npm start -w @corewaste/driver
```

The desktop URL must use HTTPS (loopback HTTP is allowed only with `NODE_ENV=development`). Never disable Electron web security. The Windows CI job creates explicitly unsigned development artifacts, not a release. Mobile EAS internal builds are manually triggered and require an Expo project, platform credentials, HTTPS API and Firebase configuration. No native package is claimed as tested on a device.

Run bash scripts/restore-drill.sh with no concurrent test writers to verify a local test-database backup/restore. It restores into a disposable database, checks every public table content fingerprint and removes only the newly created target. Production Cloud SQL and private-media recovery require their own drills.

QuickBooks general ledger export is documented in docs/QUICKBOOKS.md. Native driver tools include encrypted queued messages, task completion, inspections and disposal tickets. Real device acceptance remains required.

All eight requested end-to-end acceptance scenarios must pass before production release. See the checklist for what is implemented and what still needs development.

Current development additions include explicit customer fuel/handling policies, site/bin material stock with tracked scale movements, and mandatory manual equipment confirmation for rental completion. See [feature status](docs/FEATURES.md), [validation evidence](docs/VALIDATION.md) and [dependency review](docs/DEPENDENCY_REVIEW.md). For the already-built local API image, `bash scripts/verify-local-api-image.sh` checks compiled migrations, non-root startup, database health and unauthenticated access using only a new disposable test database.

Windows test downloads and their current limitations are documented in [Windows testing](docs/WINDOWS_TEST.md). The desktop client now opens a connection screen when no server URL is configured; use **Connection → Change server** to update it without setting environment variables. A running server and provisioned account are still required for business workflows.

The current complete local run passes 165 backend tests, 27 Chromium workflows and two auth-emulator identity tests; the compiled non-root API starts from all 47 migrations. Recent connected workflows are documented in [contract billing](docs/CONTRACT_BILLING.md), [equipment stock](docs/EQUIPMENT_STOCK.md), [historical imports](docs/HISTORICAL_IMPORTS.md), [contribution reports](docs/CONTRIBUTION_REPORTS.md), [arrival timing](docs/SERVICE_TIMING.md) and [Stripe refunds](docs/STRIPE_REFUNDS.md). See [release acceptance](docs/RELEASE_ACCEPTANCE.md) for the external setup and real-world checks that remain. These local results do not mean the system is 100% ready for production.
