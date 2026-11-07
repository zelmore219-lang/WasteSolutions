# CoreWaste architecture

CoreWaste is one company's system. There is no tenant registration, company switching, subscription billing, or multi-company data plane.

## Shared data and clients

The React office app and customer views, Electron Windows shell, and React Native driver client use the same NestJS API and PostgreSQL database. Clients never connect directly to PostgreSQL. Firebase authenticates identities; the API loads active roles and customer ownership from PostgreSQL, not client-supplied claims. Owner and manager access requires Firebase second-factor authentication. A Firebase login alone grants no business access.

`apps/api/src/domain.ts` contains the transactional service-order workflow; `workflows.ts` adds service requests, recurring agreements, and routes. Controllers only resolve identity and delegate. Runtime input validation is performed with Zod; SQL parameters are bound. Date-only service schedules remain date strings. All current monetary values are integer USD cents, bounded at input.

## Current transaction boundaries

- Customer, service location, and order creation each write audit records atomically.
- Assignment locks the order and checks its version, driver activity, and truck availability. Route creation locks its ordered set of jobs in deterministic ID order before assigning stops.
- Driver transitions require the assigned identity and matching version. Completion cannot skip the started state. Failure needs a reason.
- A command key is scoped to the authenticated actor and bound to the operation, target, and parsed body. A PostgreSQL transaction advisory lock serializes retries. The response is stored in the same transaction as the business mutation. Reusing a key with another request returns a conflict.
- Invoicing locks the completed order. A unique order constraint ensures one invoice. Each invoice creates a balanced debit/credit posting in the same transaction. Journal, audit, and status history are append-only at the database layer. This is an initial service-revenue journal, **not a complete general ledger**.
- Recurring agreements generate scheduled service orders and advance their next date in one transaction. A database uniqueness constraint additionally protects each agreement/date pair. This does not yet implement monthly invoice schedules or calendar/holiday rules.
- A service request is owned by its customer and can be converted once into an order. The resulting job uses the normal dispatch/completion/invoicing workflow.

## Driver synchronization

The initial mobile client retains encrypted status commands in SecureStore under the authenticated identity. It records the expected server version and stable command key before showing a local status change. Replay is sequential; acknowledge and remove only after the server succeeds. Network errors, revoked authorization, or conflicts leave the command pending and stop dependent writes. The server remains authoritative. The test suite exercises the replay algorithm and actual database retry behavior separately; an installed-device offline/reconnect acceptance test remains outstanding.

The current client requires an online login and fetch in an open application session. It does not yet cache the route securely across restarts, resolve conflicts interactively, upload offline media, or synchronize in the background. Do not assign it live production work.

## Environments and deployment design

Use isolated Firebase projects, Cloud SQL PostgreSQL databases, Storage buckets, Stripe modes/accounts, and Cloud Run services for development, testing, and production. Local test commands reject database names without the `_test` suffix. The example `.env` contains local-only database settings; never use these credentials remotely.

Cloud Run should use a dedicated least-privilege service identity, private Cloud SQL connectivity, managed secrets, structured redacted logging, and an explicit web origin. Apply migrations as a controlled deployment job before shifting traffic, never on every request. The supplied Dockerfile builds the API, but cloud deployment has not been executed. Production still needs validated database TLS/connector settings, restricted DB roles, backups/PITR and restore drills, provider webhook verification, monitoring, and load testing.

Employee/customer provisioning is deliberately an operator action at this stage. Web employee usernames map to Firebase email aliases at an explicitly configured company-owned domain, checked during provisioning. Authenticator-app MFA challenges are supported; SMS challenges, public registration, MFA enrollment/recovery, and account administration remain acceptance gaps. No development auth bypass exists in the API.

## Next implementation milestones

1. Complete identity lifecycle and browser acceptance tests with Firebase emulators; add admin employee/fleet CRUD and username login.
2. Finish dispatch updates, route editing, road-network optimization with vehicle constraints, signed media uploads, and full durable mobile synchronization.
3. Add container reservations with PostgreSQL exclusion constraints and movement ledger; complete the rental/exchange/disposal workflow.
4. Integrate provider-hosted payments and verified idempotent webhooks, payment allocations, refunds, reconciliation, full ledger, monthly billing, and QuickBooks.
5. Implement transfer-station weighing, material pricing, expense/fleet maintenance, notifications, import preview/rollback, reporting, and the public customer website.
6. Complete all eight requested acceptance scenarios, native device tests, signed installers, backup recovery, security review and production deployment.

No placeholder payment success, fabricated GPS optimization, sample operational records, or mocked provider integration is shipped.

## Subsequent implemented modules

Migrations 003–009 add physical containers, range-excluded bookings, rental jobs and movement history, disposal tickets and itemized rental invoices, scale tickets/materials, payments/refunds/credits, provider event deduplication, expenses, notification outbox, employee/fleet administration, maintenance, messaging, and import preview/application/rollback lineage. Service completion and physical container movements share one transaction. Pickup/exchange jobs cannot be billed independently of the rental. Weight fees use metric tonnes and integer half-up rounding; units are explicit in forms.

Stripe Checkout uses the current official Node SDK and a stable payment-attempt ID outside the database transaction. Only verified signed webhooks post provider receipts. ACH pending/failed events leave balances unpaid. Captured funds whose target invoice balance changed are posted to customer-credit liability for reconciliation, never silently lost or applied twice. Manual cash/check receipts and refunds are separate from provider operations.

Imports support new customers, locations, yard containers, service agreements, orders, route assignments and positive opening receivables. Preview is inert with respect to business records; applying or rolling back requires an explicit batch-specific confirmation. Revalidation and mutations are transactional. Rollback preserves source records and audit history; related activity blocks unsafe rollback. Opening balances post to opening equity, not service revenue. Existing historical records are not rewritten.

The mobile adapter chunks encrypted values on Unicode code-point boundaries and commits by swapping a small generation pointer. Failed writes retain the previous readable generation. This adapter is also used with Firebase's documented React Native persistence API, keeping tokens in device-backed secure storage rather than plain AsyncStorage. Native execution and platform keychain/keystore behavior still require device acceptance tests.
