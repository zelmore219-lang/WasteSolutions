# CoreWaste feature and acceptance checklist

**Development build. Not approved for production release.** One company and one central PostgreSQL database. No multi-tenant SaaS or software-resale business.

## Implemented capabilities

| Area | Current capability | Remaining implementation or acceptance |
|---|---|---|
| Identity | Firebase token/revocation checks, active roles, username aliases, administrator MFA, SMS/TOTP challenges, authenticator enrollment, password setup/recovery | Live backend GCP identity, production provider settings, recovery and installed-device acceptance |
| Administration | Company/timezone/invoice terms/fee settings, employees/roles/disable, last-owner protection, audit log | Production activation, security/load review and operational recovery procedures |
| Customers | Residential/commercial accounts, locations, search/filter, optimistic edits, suspension/reactivation, notes, statements, private attachments, customer-specific per-service rate cards and frozen quoted order prices | Broader rate tiers/contract pricebook integration and real-data import acceptance |
| Website/portal | Original company website, inquiry queue, verified-email registration with office approval, owned schedules/invoices/requests/notices | Production domain/contact/service-area settings and real-provider acceptance |
| Dispatch | Searchable order references, priority, linked parent/child dependencies, calendar and list views, atomic date/driver/truck drag-and-drop, stale-edit protection, ordered routes, in-progress reassignment, arrival/history, required checklists, messages, paired arrival windows and planned service durations | Live road-provider acceptance, real-time field ETA and broader dispatch acceptance |
| Map/road planning | Verified entrance pins with address invalidation, Leaflet map, verified loaded rigid-truck profiles, real-road provider adapter, immutable preview inputs, explicit stale-safe application, verified per-leg timing with service/wait estimates and arrival-window rejection | Live Amazon Location key/network/basemap setup, time-dependent routing quality, linked resequencing, trailers/hazardous cargo and installed navigation |
| Recurring service | Interval schedules, bounded catch-up generation, per-service billing, calendar/anniversary monthly-quarterly-annual cycles, actual-day partial-period proration, explicit advance/arrears timing, deferred advance charges and verified once-only recognition, guarded prepaid shortening | Additional cadence/template/amendment/price-escalation policies and broader commercial contract acceptance |
| Zones/holidays | Location zones, collection weekdays, company/zone date rules, cycle/collision rejection, preview-hash review before moving existing work, original occurrence retained across month-end | Larger real-calendar acceptance and route-aware bulk planning |
| Roll-off/inventory | Physical reservations, overlapping-booking exclusion, delivery/exchange/pickup, movements, extensions/cancellation, disposal tickets, weight/extension charges, itemized final invoices, required manual container/replacement confirmation, known multi-yard/truck stock, cart/commercial placement/recovery, owner-only legacy observations and paginated physical history | Broader equipment lifecycle, exact disposal-return destination recording and physical acceptance |
| Disposal | Collection creates a separate load, holds inventory unavailable, unable-to-dump with return-to-dispatch/reassignment, relief-driver inspection/ticket recording, exactly one release after verified disposal | Full installed-device and yard/facility operational acceptance |
| Driver | Encrypted Firebase session, cached work/routes, ordered durable queues, photos/signatures, navigation, optional foreground GPS, messages, inspections, disposal work, independent prioritized tasks, captured equipment numbers and original commands preserved for office conflict review | Signed installed applications, device/permission/crash tests, fuller background behavior and physical field acceptance |
| Transfer station | Materials/prices, manual inbound/outbound readings, gross/tare/net, disposal invoices, receipts/reconciliation, site/bin stock counts/transfers and atomic tracked weight movements | Actual scale protocol/calibration/hardware, material processing and costing/valuation |
| Finance | Integer USD amounts, balanced append-only journal, partial cash/check receipts, recorded refunds, credits/refunds, credit memos, configured late fees, signed Stripe events/ACH failures, unpaid vendor bills and partial settlements, immutable vendor credits/payment reversals, guarded Stripe payment/account-credit refunds with exact-receipt recovery and external receipt reconciliation, explicit fuel/handling fees and allocated credit reversal | Live payments/refunds, broader vendor/bank reconciliation, reviewed global/contract fee/tax policies |
| QuickBooks | OAuth state/company review, encrypted tokens, chart classification/customer links, immutable journal exports, exact-receipt recovery without a second POST | Intuit sandbox/live acceptance, confirmed non-delivery resolution, native invoice/payment and payable/vendor integration |
| Autopay | Hosted setup, explicit consent/cap, withdrawal-version protection, off-session attempts, signed-event settlement | Live provider setup/charges and deployed schedule |
| Fleet/expenses | Trucks, maintenance, pre/post-trip inspections for orders/disposal/tasks, recorded fuel/repair/other expenses, unpaid bills, partial settlements/credits/reversals and explicit service/route expense attribution | Broader asset lifecycle, vendor cash refunds and bank reconciliation |
| Notifications | Portal notices, lifecycle/date/invoice/payment notices, email/SMS preferences, templates, transactional outbox, Resend/Twilio adapters, leases/retries/receipts/uncertain-send review | Real delivery, sender/domain setup and deployment |
| Reporting | 21 reports including historical AR/AP and customer-credit balances, ledger revenue/expense/trial balance, service/route operating contribution with unallocated costs retained, legacy source lookup, CSV/PDF/printing | Fully allocated margins, historical route-ownership reconstruction and bank reconciliation |
| Imports | Preview/duplicates/validation for customers, locations, containers, agreements, orders, routes and opening receivables plus immutable non-posting legacy invoice/payment/refund/credit/expense archives; guarded transactional apply/rollback with accounting dates and no deleted history | Authorized real-source/cutover acceptance and any separately reviewed historical GL conversion |
| Security/operations | Validation, role/ownership checks, limits, private normalized media/checksums, immutable financial/audit/proof records, compiled migrations/jobs, non-root production API, local restore drill | Open dependency findings, cloud SQL/media recovery, deployed security/representative load acceptance and production hardening |
| Platforms | React web, hardened Electron connection client/Windows CI and unsigned portable ZIP, Expo Android/iOS configuration and current JavaScript exports | Accessible Windows download delivery, signed packages and Windows/Android/iPhone installed-device testing and publication |

## Requested scenarios

1. Customer → service → recurring invoice → payment: per-service and calendar/anniversary contract component flows pass, including advance/arrears, proration, deferred recognition and recorded payment; real provider and complete billing-template acceptance remain.
2. Order → dispatch → completion → invoice: PostgreSQL flow passes; browser forms, calendar assignment and driver service work are covered.
3. Rental → deliver → exchange → collect → disposal reconciliation: PostgreSQL flow passes; collected inventory remains unavailable until disposal is verified.
4. Route → driver → completed stops → dispatch: route progress, dependency ordering, live reassignment protection and committed-change refresh pass.
5. Customer request → office → driver work: connected database flow passes; public inquiry/verified portal approval pass in Chromium.
6. Offline work → reconnect: queue replay, retry keys, stale versions, encrypted storage/media, acknowledged-state cache and retained office evidence pass automated checks; complete device acceptance remains.
7. Scale weights → charges → reconciliation: manual verified-reading flow passes; calibrated hardware acceptance remains.
8. Failed payment → balance stays due → notice: signed provider-event flow passes against PostgreSQL/outbox; real provider delivery remains.

## Validation

See VALIDATION.md for exact completed evidence and limitations. The latest complete run has **165 backend tests, 27 Chromium workflows, two Firebase emulator identity tests and three desktop security/settings tests passing**. API/web/driver TypeScript checks and API/web production builds pass. Current Android/iOS JavaScript/Hermes exports include the driver arrival-window display; these are not signed installed applications.

The non-root production API image applies **all 47 compiled migrations** to an empty disposable database; a second migration run is idempotent. Its database health returns 200 and protected stock/fee/order/refund/contract/equipment endpoints return 401 without identity. The current local restore drill matched every public table's row count/content fingerprint. A local authenticated burst completed 240 reads with eight workers and no failed responses; it is not production load acceptance.

No real charge, Intuit export, external email/SMS send, cloud publication, signed native package, installed-device run or scale-hardware test has been performed. Metro 0.83.8 removes the vulnerable image-size dependency. The latest full-workspace audit has zero high/critical findings, 24 moderate and one low; the API image dependency subset still reports eight moderate findings. Remaining findings and live security acceptance are release work.

## External requirements

Backend Firebase/GCP identity and resources; Cloud Run/SQL/Storage/DNS; Stripe and QuickBooks accounts; Amazon Location routing key/region and licensed basemap configuration; verified email/SMS senders; signing accounts and Windows/Android/iPhone devices; scale protocol/calibration access; authorized legacy exports.

Public CurbWaste sources became reachable after the user published the environment and have been partially reviewed. Full parity is not established. See RESEARCH.md and the original BUILD_REQUIREMENTS.md.

Do not equate implemented source or this checklist with production completion.

Development workflow details: CONTRACT_BILLING.md, EQUIPMENT_STOCK.md, PAYABLES.md, HISTORICAL_IMPORTS.md, CONTRIBUTION_REPORTS.md, SERVICE_TIMING.md and STRIPE_REFUNDS.md. Source archive amounts do not re-post old revenue. Operating contribution does not invent unrecorded labor/overhead costs.

## Windows local testing, version 0.2.0

A full local Windows test kit bundles the office client, API, PostgreSQL and isolated demo identity. Customer-to-payment workflows and clean restart persistence passed Linux/Docker/Chromium checks; ten desktop tests pass. Docker Desktop is required. Actual Windows/device acceptance, signing and accessible download hosting remain pending. See [Windows testing](WINDOWS_TEST.md).

## Firebase-hosted Windows direction

Firebase production client configuration and Hosting-to-Cloud-Run API routing are prepared. The Windows client pre-fills the intended Firebase URL and checks API/database health before opening it, without Docker on the user’s computer. The user plans to enable billing later; real cloud deployment, sign-in/MFA, PostgreSQL/bucket provisioning, installed Windows acceptance and accessible delivery remain pending. See [Firebase release](FIREBASE_RELEASE.md).
