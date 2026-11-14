# Validation evidence

## Public 0.3.0 installer delivery — November 13, 2026

[Run43547207851](https://github.com/zelmore219-lang/WasteSolutions/actions/runs/43547207851) completed Success, including installer creation and publication of the GitHub prerelease `demo-v0.3.0`. The public EXE was downloaded completely without GitHub sign-in, not merely checked for an artifact listing. Its published SHA256 matched **e7c86d40b29ca08f02f58fa8a34e7d0865243c91fd8c8dd23f93600ba27d1ed1**; size158,047,362 bytes; PE header and full NSIS CRC passed. Evidence: `.local/verified-download/result.json`. [Direct installation instructions](../DOWNLOAD-WINDOWS.md). Earlier workspace/Actions download limitations below are superseded for this release.

A further real Chromium check signed an isolated owner in with SMS MFA, saved a fake Resend key through Settings, confirmed the password field cleared, verified encrypted database storage and redacted audit history, and verified delivery remained disabled. It exposed a label association issue after saving; separating the remove-secret checkbox into its own label fixed it, and the complete owner flow passed (`/tmp/corewaste-owner-provider-ui.log`). No real provider requests, production accounts or paid cloud resources were created.


## Version 0.3.0 — demo credentials, branding and provider settings

Current checks: **174 backend tests**, **27 browser workflows**, **13 desktop tests**, **2 identity integration tests**, API/web/driver type checks and API/web builds passed. The browser owner/MFA workflow now saves Firebase provider configuration. A separate real Chromium check signed in with demo/password1, opened all seven provider sections, verified that dispatcher cannot edit owner-only settings, and reported zero page errors. The first browser run overlapped the backend suite and its global ledger-count assertion failed; the isolated rerun passed all27.

Provider tests cover owner authorization, authenticated field-bound encryption, write-only/redacted responses, audit privacy, idempotency, stale versions, preserving/clearing secrets, missing encryption-key rejection, demo activation restrictions and public Firebase isolation. Icon tests verify that replacing Windows resources preserves embedded integrity data. The actual built Windows EXE was checked for all six logo icon sizes matching the ICO asset.

Windows installer0.3.0 compiled and its NSIS CRC passed:158,047,332 bytes, SHA256 `da024a64eeee62cb5f6891469996be7ba63d2bfe9877749410679486b333bf44`. The portable ZIP is110,071,250 bytes, SHA256 `a3f9cbfc347ec7998c2f6a5dd192791bf1482e4d61fdda1867ea6abe91d98eb4`. These hashes identify local builds; remote build bytes may differ. Actual Windows installation/execution remains unverified.

Logs: `/tmp/corewaste-completion-final-backend.log`, `/tmp/corewaste-completion-final-browser.log`, `/tmp/corewaste-completion-desktop.log`, `/tmp/corewaste-completion-identity.log`, `/tmp/corewaste-030-final-types.log`, `/tmp/corewaste-030-final-build.log`, `/tmp/corewaste-030-installer-build.log`. Live Firebase access, cloud billing/deployment and real provider acceptance remain pending. The demo credential does not provision a production account.


## Verified GitHub installer delivery — November 7, 2026

GitHub run [42422788236](https://github.com/zelmore219-lang/WasteSolutions/actions/runs/42422788236) completed **Success** in3m6s and lists **one151 MB installer artifact**, `CoreWaste-Windows-Installer-0.2.0-x64-UNSIGNED` (artifact13594425678). Its reported ZIP SHA256 is `5f59fc10163d8c43cc1631d8078474b9a9b4cb08e417d03f84c786bf135bd0c8`. The run executes npm ci, all desktop tests, the portable runtime build, the standard per-user installer compiler/integrity checks and artifact upload. The run and named artifact were verified on GitHub’s public build page. Downloading an artifact requires GitHub sign-in. No Windows machine execution is claimed.

Source commit509a57d was pushed to the separate `codex/windows-installer-download` branch through the normal permitted Git HTTPS connection. GitHub’s REST/upload APIs remain blocked, but publishing an Actions artifact through the repository workflow works. No environment configuration or production cloud resources were changed. [Installation instructions](../DOWNLOAD-WINDOWS.md) explicitly state that the current client cannot explore business features until the hosted services are activated. Earlier delivery-blocker entries below describe previous attempts and are superseded by this verified Actions result.


## Installable Windows client — November 7, 2026

A standard NSIS per-user installer was compiled successfully using the cached Electron Builder Linux compiler, without executing Windows code or using Wine. Artifact: `CoreWaste-Setup-0.2.0-x64.exe`, **157,895,602 bytes**, 73 runtime files, SHA256 `2b6831ba6e3a4c9298159ad87a590f330016311e088824396d9304b2b0c6ffe1`. PE/NSIS headers and the full NSIS CRC (all bytes after the stub’s first512 bytes through the final checksum) passed independent validation. The uninstaller uses an explicit file whitelist and installation marker, no recursive folder removal, and preserves AppData. Native Windows behavior remains unverified. Twelve desktop tests pass (`/tmp/corewaste-installable-desktop-tests.log`); build log `/tmp/corewaste-installable-final-build.log`. No app/business logic changed.

Cloud activation remains pending until billing and project access are configured. A fresh GitHub delivery probe returned proxy CONNECT403; no hosted download, release or remote workflow run is claimed.


## Firebase-hosted client preparation — November 7, 2026

Firebase production web build and API/web/driver TypeScript checks passed. Twelve desktop tests pass, including rejection of Firebase welcome HTML, HTTP failures, unhealthy database responses and network failure; the health request forbids redirects and checks the CoreWaste API identity. Existing setup IPC isolation, local test controls and sandbox tests remain passing. Two emulator-mode guard tests also pass.

A Chromium check of the Firebase production build rendered office sign-in with zero page errors and zero emulator requests. Rebuilding with hostile inherited `VITE_USE_AUTH_EMULATOR=true`, `VITE_LOCAL_TEST_KIT=true` and a demo project still produced the production sign-in without emulator requests. No real-project credentials were submitted and live sign-in/MFA was not tested. Current packaged ASAR source bytes match the reviewed desktop source. Logs: `/tmp/corewaste-firebase-desktop.log`, `/tmp/corewaste-firebase-types.log`, `/tmp/corewaste-firebase-identity-guards.log`, `/tmp/corewaste-firebase-final-web-build.log`, `/tmp/corewaste-firebase-final-windows-build.log`.

The final Windows portable build succeeded. `CoreWaste-Firebase-Windows-0.2.0-x64.zip` is **109,908,461 bytes**, SHA256 `8c616e5b8ffbef6478a5f42abb844aafe684825bc6a796c705bc425aa43c8869`. Archive CRCs passed and the strict package contains only the EXE and startup instructions. GitHub publishing was rechecked and also returned proxy CONNECT403.

The owner confirmed Firebase billing is not enabled and will be enabled later. The enforced environment policy blocks Firebase management access (fresh curl request: proxy CONNECT403); no ready Google Cloud identity is available. Hosting/API/database/storage activation, real employee access, Windows machine acceptance and accessible download delivery remain pending. No cloud resources, paid services, environment settings or live project configuration were changed. [Release preparation](FIREBASE_RELEASE.md) documents the remaining activation requirements.


## Windows local test kit — November 7, 2026

The final API/web/driver type checks and builds passed. Backend regression: **167 passed, zero failed/skipped** (`/tmp/corewaste-download-backend.log`); identity regression: **2 passed** (`/tmp/corewaste-download-identity.log`). Browser regression: **27 passed** (`/tmp/corewaste-download-browser-rerun.log`). The first run passed26 and timed out when the test helper reloaded during asynchronous sign-out; keeping the current office page until sign-out completes corrected the helper, and the full rerun passed. Controls renderer start/open/stop, escaped sign-ins and MFA-code display passed in Chromium with zero page errors (mocked desktop bridge).

Version 0.2.0 bundled services passed owner SMS MFA, customer/location creation, dispatch and driver completion, invoicing and recorded cash payment in Chromium. Clean Stop/Start preserved financial data, identity UID and owner MFA, with no browser page errors. Evidence: `/tmp/corewaste-testkit-business-check.log` and private `.local/windows-test-kit-acceptance.json`. Ten desktop tests and two additional local-client identity-mode guard tests passed. The isolated kit enables demo identity only at the explicit loopback address; normal production emulator protection remains intact.

The Windows x64 portable executable builds successfully on Linux. The full archive contains application runtime, hashed service images and launchers, excluding generated private state. The final archive is `CoreWaste-Windows-Local-Test-0.2.0-x64.zip`, 540,940,756 bytes, 80 files; SHA256 `844a05966ebda461adb3392a9ede180e79a7f906069c4df3a5472b2f94f2e9cf`. ZIP CRCs and packaged-source equality passed. Actual Windows execution, signing and hosted delivery have not been verified. No live provider operation was performed. See [Windows instructions](WINDOWS_TEST.md).

## Latest completed validation — November 7, 2026

This section supersedes the older chronological runs below. **Development build; not production acceptance.**

| Check | Completed result |
|---|---|
| Backend / PostgreSQL / durable queues / security | **165 passed, 0 failed, 0 skipped**; `/tmp/corewaste-final-165-backend.log` |
| Chromium browser workflows | **27 passed** with the real local Firebase auth emulator and PostgreSQL; `/tmp/corewaste-final-27-browser.log` |
| Firebase emulator identity / HTTP access | **2 passed**, including roles, ownership, MFA and revocation; `/tmp/corewaste-final-identity.log` |
| Windows connection-client security/settings | **3 passed**; `/tmp/corewaste-full-current-desktop.log`; no Windows machine execution |
| TypeScript and builds | API/web/driver type checks and API/web builds pass; `/tmp/corewaste-final-types.log`, `/tmp/corewaste-final-build.log` |
| Native JavaScript exports | Android/iOS Hermes bundles and source maps exported; `/tmp/corewaste-current-android.log`, `/tmp/corewaste-current-ios.log`; source maps confirm current arrival-window UI |
| Production API artifact | `corewaste-api:development`, SHA256 `5af5743f5cdd78d5f231acb220a19379cd997cec22b247e37abe179ef9a43ce1`; `/tmp/corewaste-final-image-build.log` |
| Empty-database compiled startup | **47 migrations**, repeat idempotent, health200, protected stock/fee/order/refund/contract/equipment401, non-root, development runner absent; `/tmp/corewaste-final-image-check.log` |
| Local PostgreSQL recovery | Every public table's row count/content fingerprint matched after restore; `/tmp/corewaste-final-restore.log`; private archive `.local/restore-drills/cw_restore_20261107180313_19876_test.dump` |
| Local authenticated read burst | **240/240 HTTP200**, eight concurrent workers, p50 13.83ms, p95 29.77ms, max89.21ms on 896 customer / 1,902 order / 1,088 journal fixture rows; `/tmp/corewaste-final-local-load.log` |

The current backend/browser runs add contract calendar/anniversary and advance/arrears billing, deferred recognition, quarterly/annual and partial cycles, yard/truck/cart stock, immutable legacy observations/paginated equipment history, vendor credits and payment reversals with historical guards, historical receivable/credit reporting, non-posting source archives, service/route contribution, arrival-window/road timing and guarded Stripe refunds. Refund coverage includes concurrent reservation/submission, lost responses without resending, signed webhook and exact-receipt recovery, failure/mode/mismatch rejection, both account-credit funding paths and explicit external receipt reconciliation. The browser verifies once-only signed settlement over the real Nest HTTP route with provider submission intentionally disabled.

Reproduce the short local read check with `TEST_DATABASE_URL=..._test node --import tsx scripts/load-local.ts`. It starts only a loopback test API on port3200 using the demo emulator at127.0.0.1:9099; no arbitrary remote URL or business database is accepted. It creates a disposable emulator/employee fixture, discards response bodies, deactivates/removes its own identity and stops only its own process. Results and startup logs remain private under `.local/load-tests`. The first runner attempt generated a non-ISO date and correctly received400 for report requests; the runner's date query was corrected and the complete240-request run then passed. This sub-second burst is not a sustained workload, cloud capacity guarantee, external-provider benchmark or production SLA.

No live Stripe charge/refund, Intuit export, email/SMS send, deployment, environment publication, signed package, installed-device run or scale-hardware test was performed. The current dependency assessment remains zero high/critical,24 moderate and one low across the workspace; the API subset has eight moderate findings, with upstream/production review still required. Native exports are not APK/IPA builds. The unsigned Windows ZIP is a connection client, and its internal workspace link was not verified as a usable user download. See RELEASE_ACCEPTANCE.md for remaining credentials, provider, hosting, hardware, source-data, distribution and broader feature limitations.

## Historical validation log

Current-instance checks, November 6, 2026:

- Real PostgreSQL 17 running locally; both migrations applied to development and isolated test databases. Re-running migrations and the local database startup helper succeeded.
- 11 automated tests passed, 0 failed, 0 skipped: HTTP/database health and identity rejection; customer/order/dispatch/completion/invoice transaction; customer scoping/input validation; transition/version/assignment protection; retry/rollback; customer request conversion/completion; routes/progress; recurring occurrences; ordered offline replay; lost-response retry; conflict retention.
- API and web build and API/web/driver TypeScript checks passed.
- Expo exported both Android and iOS JavaScript/Hermes bundles successfully. This is not an APK, signed native app, or device test.
- API health returned 200 and business endpoints returned 401 without identity. The Vite web entry returned 200. Authenticated browser and Firebase integration tests remain unrun because the project and accounts are not configured.
- Electron runtime downloaded with TLS/checksum verification intact. Launch on this Linux machine stopped because its Chromium sandbox helper cannot be configured here. Sandbox protection was retained. Windows packaging and execution remain unrun.
- No cloud deployment, live payments, notifications, native signing, device run, scale hardware test, or legacy migration was performed.

Dependency audit results and final checks are recorded below when completed. Unresolved security advisories block production release even when functional tests pass.

The dependency audit after patch-level overrides for gRPC, Multer and PostCSS reports **1 high, 19 moderate, 1 low, 0 critical** production-classified advisories. The remaining high finding is `image-size` through Expo/Metro. Its fixed release changes the major API; it has not been forced into Metro without compatibility validation. These findings remain release blockers. Audit command: `npm --cache /workspace/.npm-cache audit --omit=dev` (nonzero exit is expected until resolved). Dependency overrides are explicit in the root manifest and lockfile; revalidate all clients when updating them.

The API Docker image was built successfully using a mounted proxy CA. The non-root container connected to the real PostgreSQL database, returned HTTP 200 with `status: ok` from health, and returned HTTP 401 for unauthenticated orders. This validates the local container artifact, not Cloud Run deployment.

A clean frozen-lockfile `npm ci` completed successfully after the dependency overrides. API/web/driver type checks, API/web builds and all 11 tests were rerun against the updated dependencies.

## Continued build validation

The local Firebase Authentication emulator (`demo-corewaste`, loopback only) now supports development and automated authentication checks without production Firebase configuration. The API refuses emulator mode in production, for real project IDs, or for non-loopback emulator hosts. Browser emulator mode is restricted to Vite development builds.

- 30 backend/storage tests passed after adding rental inventory/booking exclusion constraints, itemized rental/disposal invoicing, manual scale tickets, partial cash/check payments and recorded refunds, signed Stripe webhook deduplication, failed ACH notifications, customer-credit accounting, fleet safety/maintenance, message privacy, all 16 report queries, real CSV/PDF output, import preview/apply/archive rollback, opening-equity entries, and encrypted local storage generation recovery.
- Two HTTP identity tests passed using the actual Firebase Authentication emulator: identity provisioning, customer ownership, role rejection, administrator MFA requirement, disabled identity rejection, malformed tokens and production emulator configuration protection.
- Four Chromium browser workflows passed for customer/location/order entry, inventory persistence, invoice payment entry, and PDF report download. A further browser test passed an enrolled SMS MFA challenge and entered the owner-only company administration screen through the real API guard.
- Android/iOS source now uses encrypted Firebase session persistence and cached assigned work, with a 24-hour offline authorization window. Storage algorithm tests passed; native device restart/reconnect acceptance is still unrun. No claim of installed-device validation is made.

Stripe webhook tests generate cryptographic test signatures and exercise real PostgreSQL transactions; they do not charge a card or demonstrate a connected Stripe account. Cash/check forms record payments/refunds already received/issued. Email outbox records are queued; email/SMS delivery is not yet connected or tested.


## November 7 resumed build

This section supersedes earlier milestone counts and unrun claims.

- Migrations through 023 applied to both development and dedicated test databases.
- NestJS updated to 12.4.0; platform-express resolves Multer 2.5.0. TypeScript checks pass for API/web/driver. API/web production builds pass.
- 63 backend/storage/crypto/PostgreSQL tests passed, zero failed/skipped. New checks cover QuickBooks OAuth state/company review/encryption/account mapping, balanced exports, matching lost-response receipts, unresolved non-delivery, driver arrival timestamps, required tasks, message acknowledgement ownership, post-trip inspections and concurrent encrypted queue additions.
- Two actual Firebase emulator identity/HTTP tests passed, including customer-scoped PostgreSQL-to-SSE changes.
- Eight Chromium workflows passed, including the new driver start/task/arrival/completion path. The first resumed browser run found two regressions: the board rendered hundreds of complete assignment forms, and live billing refresh cleared a selected invoice. Pagination and refresh-state fixes were applied; all eight workflows then passed.
- Android and iOS JavaScript/Hermes bundles and source maps exported successfully after native driver tools were added. These are not signed application packages and do not demonstrate device permissions, SecureStore behavior or background acceptance.
- Local PostgreSQL custom-format backup restored into a disposable test database. Every public table matched source row count and deterministic content fingerprint. The temporary restored database was removed; the private ignored test archive was retained locally.
- API health checks PostgreSQL. The real web Firebase variables are present; test subprocesses explicitly use demo-corewaste rather than the user's real project. No GCP outbound identity/ADC was supplied, so production token revocation checks and administrator provisioning remain unverified.
- Dependency audit after the API update: one high, 19 moderate, one low. The high finding is image-size 1.2.1 through Expo/Metro; current Metro uses the version-1 callable/file-path API. A blind major override is incompatible, so no such override was applied. Uploaded operational media is handled by Sharp on the API, not Metro. This finding still requires a compatible upstream update or an independently verified compatibility patch before release. Other dependency findings remain open.
- No live Intuit export, Stripe charge, external email/SMS delivery, cloud publication, installed native/Windows acceptance, actual scale reading or legacy migration was performed. No environment draft settings were changed or published in this resumed coding session.

See FEATURES.md for unfinished feature work, QUICKBOOKS.md for export boundaries and FIREBASE_SETUP.md for the remaining server identity setup.

## November 7 billing, calendar, disposal and dispatch wave

This section supersedes earlier capability/count statements.

- Database migrations through 030 are present and applied to development/test databases.
- 86 backend/storage/crypto/PostgreSQL tests passed, zero failed/skipped. Coverage now includes monthly proration/closure/duplicate protection, zone/holiday rules, cross-month service occurrences, reviewed date changes, loaded inventory holds, unable-to-dump reassignment, independent tasks, durable action review, parent/child dependencies, route ordering, priorities and atomic calendar moves.
- Two Firebase emulator identity/HTTP tests passed. Real GCP authentication remains unverified.
- All 13 Chromium workflows passed in one complete run. The calendar drag test uses actual pointer movement, initiates the drag before scrolling the horizontal board, and verifies the committed date/driver/truck together. Dedicated drag handles/drop targets and keyboard move controls are available.
- A later focused browser check passed for concurrent driver assignment editing: the editor freezes its original version, disables a stale save, reloads the current assignment and only then permits an intentional replacement. Assignment controls are mounted on demand instead of rendering every driver's options for every order.
- API/web/driver checks and API/web builds pass. Android/iOS Hermes/JavaScript exports passed with current driver routes, independent tasks, loaded disposal work and proof queues. Installed-device acceptance remains unrun.
- The API container now packages compiled migration and scheduled-job entry points, SQL migrations and runtime dependencies. Development runners are pruned. A real empty disposable database was migrated through all 30 files, a repeat run succeeded, and the database was removed. The scheduled-job entry refused an unconfigured actor.
- The initial container migration check caught unreadable copied SQL files for the non-root runtime. Build permissions were corrected; the empty-database and idempotence checks then passed. The API still runs non-root, health returns 200 and unauthenticated work returns 401.
- Source research is now available from the required public CurbWaste hosts. RESEARCH.md records reviewed URLs and remaining gaps. No environment draft or publication was changed by this coding wave.
- No external payment, message delivery, production deployment or installed-device acceptance was performed.


## Latest November 7 completion checks for this development wave

- The complete backend suite passed 86 tests with zero failures/skips. Two actual Firebase emulator identity/HTTP checks passed.
- All 14 Chromium workflows passed in one complete run. The added concurrent assignment test verifies that an open editor cannot silently overwrite a committed dispatch change; the operator must explicitly reload the current version before replacing it.
- Current API/web/driver TypeScript checks pass. API/web production builds pass. Current Android/iOS JavaScript exports include the driver routes/task/disposal/review code; signed device acceptance remains unrun.
- The final non-root API image applied all 30 migrations to an empty disposable PostgreSQL database and repeated the migration successfully; the temporary database was removed. It returned health 200 and protected work 401. Its scheduled-job command rejected an unconfigured actor.
- No production environment settings were edited or published, no repository code was pushed, and no real payment or external delivery was performed.

- After all 30 migrations and latest tests, the local custom-format restore drill passed again: every public table matched both row count and content fingerprint. Only the disposable restored database was removed.
- The latest complete Chromium run passed all 14 workflows in 39.3 seconds, including the assignment-conflict case. The development API was restarted on current source and its protected review route returned 401; API/database health and the current web entry responded successfully.


## Latest completed wave — November 7, 2026: road plans, payables and customer pricing

This section supersedes earlier counts and audit metadata above. Development validation is not production acceptance.

- **102 backend/storage/crypto/PostgreSQL tests passed**, zero failed/skipped. New coverage includes route/pin/truck snapshots and stale preview rejection, no billable retry on repeated routing commands, malformed/restricted provider responses, loaded dimensions/weights, vendor bill accrual/partial settlements/concurrent overpayment protection, historical payable/receivable balances and aging, quote scoping/date/version/price checks, frozen quote-to-invoice pricing, and zero-dollar invoice settlement without a cash or zero-value journal posting.
- **17 Chromium workflows passed in one complete run**, including the original operational flows plus actual pin editing, preview application with deterministic provider fixtures, accountant-to-dispatch customer quote handoff, and partial vendor-bill settlement. Both Firebase Auth emulator identity/HTTP tests passed. These are demo-project tests in the dedicated test database, not live Firebase backend acceptance.
- API/web/driver TypeScript checks and API/web builds passed. After map presentation changes, the web build and the targeted real-browser map workflow passed again. The map screenshot is a private local test artifact under .local/screenshots; its line geometry comes from a test-only provider fixture. No licensed street tiles or actual routing response have been verified.
- All **33 compiled SQL migrations** applied to a fresh disposable database from the non-root API image; a second migration run was idempotent. Container health returned 200; road-planning, customer-pricing and expense endpoints returned 401 without identity. The production dependency tree excludes the tsx development runner. Temporary verification containers/databases were removed.
- Current API image: corewaste-api:development, sha256:7b8aa27830e8e8fce23aa9640bd9ff16a652e8af8731b1530322b36bc07c17ed. Container build pruning reports eight moderate dependency findings, with no high finding in that subset. No image was pushed or deployed.
- The final local test-database restore drill after migration 033 matched every public table's row count and content fingerprint. The private archive remains .local/restore-drills/cw_restore_20261107022440_6551_test.dump; the temporary restored database was removed. This does not validate managed-cloud backups or media recovery.
- A fresh whole-workspace audit initially reported three high findings, including new Electron/extract-zip advisories. Electron was upgraded from 39 to **45.2.3**, which replaces the vulnerable archive dependency. Its downloaded runtime was verified in Electron's Node mode (Electron 45.2.3, Chromium 156.0.8078.80, Node 24.22.2), desktop JavaScript syntax checks passed, and API/web/driver checks, builds and the 102-test backend suite passed with the updated dependency tree. Windows GUI/signing/packaging and Linux GUI acceptance remain unrun; no sandbox protection was disabled.
- Latest whole-workspace audit: **one high, 24 moderate, one low, zero critical**. The remaining high is image-size 1.2.1 through Expo/Metro; the published version-1 line has no compatible patched release. Metro uses the callable version-1 API and a file-path input in one code path. No blind version-2 override or unverified local compatibility shim was installed. This and the remaining moderate findings still require release work.
- Native driver source was unchanged by this wave. Earlier Android/iOS JavaScript exports remain build evidence only; no signed package, physical permissions/offline/device test or installed truck navigation acceptance is implied.
- Development API was restarted on the latest source. API health and the web entry returned 200; customer pricing returned 401 without identity. No operational fixtures were inserted into the development database.
- No environment draft was modified or published, no Git push was performed, and no real charge/refund, Intuit export, routing request, external email/SMS, production cloud activation or scale-hardware action occurred. Secure backend identity/provider credentials, remaining billing/inventory work, device/hardware acceptance and production hardening remain open in FEATURES.md.


## Latest completed wave — November 7, 2026: fees, material stock, equipment proof and Metro security

This section supersedes earlier counts and dependency metadata. It records development evidence, not production completion.

- **122 backend/queue/security/PostgreSQL tests passed, zero failed/skipped** against the accepted dependency tree. The added scenarios cover explicit fee snapshots/rounding, separated service/fee revenue, proportional credit reversal including paid-excess liability, site stock/count/transfer accounting in kilograms, concurrent shipment limits, wrong-equipment rejection, immutable manual number confirmations, retained original offline evidence, replay/crash safety, and the offline exchange-to-pickup equipment handoff.
- **20 Chromium workflows passed in one complete run** after the dependency update. The new browser cases configure/select agreed fuel/handling fees, open/count/transfer material stock and finish a tracked inbound weighing, and confirm that a wrong rental number cannot move inventory before the driver records the correct physical number. Both Firebase Auth emulator identity/HTTP tests passed.
- API/web/driver TypeScript checks and API/web builds passed. After the final native-only handoff fix, TypeScript and all 122 tests passed again. Android and iOS JavaScript/Hermes exports with source maps both passed on Metro 0.83.8; source-map checks confirm native Firebase auth and the rental handoff module. These are unsigned JavaScript artifacts, not installed Android/iPhone acceptance.
- Metro's original parser timed out on the malformed ICNS regression fixture. Incremental npm commands retained the old locked Metro despite changed overrides, so that tree was not accepted. A clean manifest resolution selected the upstream 0.83.8 Metro family, native SVG stayed at 15.12.1, and frozen-lockfile npm ci succeeded. Valid PNG/JPEG/SVG/scaled-asset tests and bounded malformed-container checks now pass. No image-size major override, local third-party patch or disabled protection was used.
- The accepted whole-workspace audit reports **zero high, zero critical, 24 moderate and one low** finding. image-size is absent. Moderate/low findings still require compatibility review before release; DEPENDENCY_REVIEW.md describes the remaining packages and limits. The pruned API image reports eight moderate findings.
- Current local image corewaste-api:development: sha256:de61f1a9e63747e043049771513bed1c451b8e97638cbfc8ff013c3a1aba1241. All **36 compiled migrations** applied from that image to a fresh disposable database, and a second run was idempotent. The API ran as non-root without tsx, health returned 200, and stock/fee/order endpoints rejected missing identity with 401. Temporary verification database/container were removed. The repeatable local check is scripts/verify-local-api-image.sh; no image was pushed or deployed.
- A final test-database restore drill after migration 036 matched every public table's row count and content fingerprint. Its private archive is .local/restore-drills/cw_restore_20261107033934_31917_test.dump; the temporary restored database was removed. Cloud SQL/media recovery is not established by this local drill.
- Development API/web were restarted on the current dependency tree/source. Health and the web entry returned 200; stock and fee routes returned 401 without identity. No operational sample records were inserted into the development database. Electron 45.2.3 runtime was reinstalled from its verified artifact after npm ci, its Node mode reported Chromium 156.0.8078.80 / Node 24.22.2, and desktop syntax validation passed. GUI/signing/Windows packaging remain unverified.
- Original queued rental completions lacking equipment confirmation are preserved for office review rather than forced through the new guard. A successful or queued exchange now advances only its own still-open pickup's old equipment reference; the cache is persisted before dequeuing acknowledged work. Unrelated, closed or already changed pickup equipment is not overwritten.
- No environment configuration was published or edited, no Git push occurred, and no real payment/refund, Intuit/routing request, external email/SMS, production cloud activation or scale-hardware action was performed. FEATURES.md retains outstanding implementation and external acceptance separately; this wave does not establish full CurbWaste parity or production readiness.

## Windows download preparation — November 7, 2026

The desktop shell now opens a connection screen without requiring an environment variable. Three desktop tests pass for HTTPS/address validation, local persistence/corrupt settings, secure startup defaults, remote-settings IPC rejection, and blocked cross-origin navigation. A Chromium check of the connection screen passed for restoring the saved address, validation errors, failed connections and retry, with no page errors. The packaged ASAR was compared byte-for-byte against the six client source/assets and contains only those files plus package metadata.

The Linux NSIS cross-build failed because Wine is unavailable. A portable Windows x64 ZIP is prepared instead. This is unsigned and has not been executed on a Windows machine. The download does not include the server/database and cannot provide authenticated business workflows until an externally reachable test server, Firebase identity configuration and provisioned account are connected. It does not establish production or native-device acceptance.
