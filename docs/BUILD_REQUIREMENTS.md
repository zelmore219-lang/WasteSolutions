# MASTER CODEX BUILD INSTRUCTIONS
## Project: CoreWaste Complete Waste Management System

### PRIMARY OBJECTIVE

Build a fully functional, production-ready waste-management software system exclusively for **CoreWaste**.

This is a single-company application, NOT a multi-tenant SaaS platform.

CoreWaste must have its own company-branded software, database, employee accounts, customer portal, driver application, billing system, and administration dashboard.

The objective is functional parity with CurbWaste, using independently developed source code and an original user interface.

Use CurbWaste's official public documentation to research the functionality and business workflows that must be supported:

- https://www.curbwaste.com/
- https://knowledgebase.curbwaste.com/
- https://www.curbwaste.com/help-center

Do not copy CurbWaste's proprietary code, trademarks, graphics, or interface assets. Reproduce the business capabilities, not the protected implementation.

## 1. CORE REQUIREMENTS

Build the following fully integrated applications:

1. CoreWaste Windows desktop application.
2. CoreWaste web-based office management application.
3. CoreWaste Android driver application.
4. CoreWaste iPhone driver application.
5. CoreWaste customer website and account portal.
6. CoreWaste administrative and accounting system.

All applications must share the same central database and synchronize information securely.

The system must operate as one unified business application.

Do not create unrelated applications with separate customer records or disconnected databases.

## 2. TECHNOLOGY

Use:

- React and TypeScript for the web application.
- Electron for the Windows desktop application.
- React Native for Android and iOS.
- Node.js and NestJS for the backend.
- PostgreSQL for the business database.
- Firebase Authentication for employee and customer authentication.
- Google Cloud Run for backend hosting.
- Google Cloud Storage for documents and photographs.
- Stripe or another appropriate payment processor for customer payments.
- Google Maps or another suitable provider for navigation and route optimization.

CoreWaste must have its own production environment and cloud resources.

Use separate development, testing, and production configurations.

The database and backend must be designed to support future growth without requiring a complete rebuild.

## 3. COMPANY ADMINISTRATION

Create a complete company administration dashboard.

Administrators must be able to manage:

- Company information and branding.
- Employees and user accounts.
- Permissions and roles.
- Drivers and dispatchers.
- Trucks and equipment.
- Customers and service locations.
- Billing and payment settings.
- Service areas and prices.
- Notifications.
- Financial reporting.
- Business expenses.
- System activity and audit logs.

Provide role-based permissions for owners, managers, dispatchers, office employees, accountants, drivers, and customers.

Support secure username-based employee login, with authentication implemented correctly through the identity provider.

## 4. CUSTOMER MANAGEMENT

Implement complete customer management, including:

- Residential and commercial customers.
- Multiple service addresses.
- Customer contact information.
- Billing addresses.
- Account balances.
- Payment history.
- Service agreements.
- Service changes.
- Customer notes and photographs.
- Account suspension and reactivation.
- Customer import and export.
- Customer search and filtering.
- Customer-specific pricing.

Customer records must connect directly to orders, routes, invoices, payments, and service history.

## 5. ORDER MANAGEMENT

Implement CurbWaste-equivalent order workflows.

Support:

- New service orders.
- Recurring service orders.
- Dumpster deliveries.
- Dumpster pickups.
- Dumpster exchanges.
- Container relocations.
- Live-load services.
- Extra pickups.
- Bulk-item collection.
- Disposal orders.
- Linked parent and child orders.
- Order photographs and attachments.
- Special driver instructions.
- Customer-specific order pricing.
- Order status history.

Orders must flow from office creation to dispatch, driver execution, service verification, and billing.

## 6. DISPATCHING

Build a professional, interactive dispatch center.

Include:

- Calendar view.
- List view.
- Map view.
- Drag-and-drop job assignments.
- Driver scheduling.
- Truck assignment.
- Order prioritization.
- Unassigned work queue.
- Real-time driver status.
- Route adjustments.
- Disposal-site assignments.
- Dispatch notes.
- Customer notifications.
- Driver messaging.

Dispatchers must be able to change assignments while drivers are working.

Changes must synchronize to the driver applications.

## 7. ROUTING AND GPS

Build complete route management.

Include:

- Recurring residential routes.
- Commercial collection routes.
- Roll-off dispatch routes.
- Route creation and editing.
- Stop assignments.
- Route optimization.
- GPS navigation.
- Driver location tracking with appropriate permissions.
- Route progress.
- Estimated arrival times.
- Missed-stop tracking.
- Route completion reporting.

Route optimization must use actual road-network information and respect vehicle and operational constraints.

## 8. DRIVER MOBILE APPLICATION

Build Android and iPhone applications.

Drivers must be able to:

- Log in securely.
- View assigned routes.
- View individual orders.
- Start and complete jobs.
- Record arrival times.
- Follow navigation.
- Take photographs.
- Capture signatures.
- Record container numbers.
- Enter disposal weights.
- Report failed pickups.
- Report unable-to-dump situations.
- Receive dispatcher messages.
- Complete assigned tasks.
- Record vehicle inspections.
- Operate offline.

Implement local storage and reliable offline synchronization.

Prevent duplicate job completion and conflicting updates.

## 9. RESIDENTIAL GARBAGE SERVICES

Support recurring household garbage collection.

Include weekly and custom collection schedules, service zones, route assignments, holiday adjustments, missed pickups, cart management, additional pickup fees, bulk-item services, and automated recurring billing.

## 10. COMMERCIAL DUMPSTER SERVICES

Implement commercial waste services.

Include:

- Commercial contracts.
- Recurring collection schedules.
- Container sizes.
- Dumpster inventory.
- Container locations.
- Extra pickups.
- Overflow fees.
- Contamination fees.
- Contract pricing.
- Container repairs and exchanges.
- Commercial route reporting.

## 11. ROLL-OFF DUMPSTER SERVICES

Implement roll-off rental operations.

Include:

- Dumpster rental reservations.
- Available container inventory.
- Container delivery and pickup.
- Rental periods.
- Rental extensions.
- Container exchanges.
- Disposal tickets.
- Tonnage charges.
- Overweight fees.
- Driver photographs.
- Customer signatures.
- Automated invoicing.

Prevent double-booking and maintain complete container movement history.

## 12. TRANSFER STATIONS AND RECYCLING

Create a transfer-station point-of-sale system.

Include:

- Scale tickets.
- Inbound and outbound weighing.
- Gross, tare, and net weights.
- Disposal charges.
- Material categories.
- Cash and account transactions.
- Recycling material tracking.
- Inventory.
- Customer statements.
- Daily reconciliation.
- Facility reports.
- Tonnage reporting.

Design a documented interface for supported scale equipment. Actual hardware integrations must be tested before production deployment.

## 13. BILLING AND ACCOUNTING

Build a complete financial management system.

Include:

- Customer invoices.
- Recurring billing.
- Automatic invoice generation.
- Credit card payments.
- ACH payments.
- Autopay.
- Payment receipts.
- Refunds.
- Partial payments.
- Late fees.
- Customer credits.
- Accounts receivable.
- Payment reconciliation.
- Customer statements.
- Expense tracking.
- Revenue reporting.
- Service profitability.
- QuickBooks Online integration.

Implement a proper financial transaction ledger.

Do not store raw payment card information.

Use secure payment-provider integration and idempotent financial operations.

## 14. CUSTOMER PORTAL

Create a CoreWaste-branded customer website.

Customers must be able to:

- Create accounts.
- Sign in.
- View service schedules.
- View invoices.
- Pay bills.
- Configure autopay.
- View payment history.
- Request additional pickups.
- Request dumpsters.
- Report missed pickups.
- Submit support requests.
- Receive notifications.
- Update account information.

Customer requests must immediately appear in the appropriate office management workflow.

## 15. INVENTORY AND FLEET

Build complete tracking for:

- Trucks.
- Trailers.
- Dumpsters.
- Residential carts.
- Roll-off containers.
- Maintenance.
- Vehicle inspections.
- Fuel expenses.
- Repairs.
- Equipment status.
- Container movements.
- Container availability.
- Container profitability.

## 16. NOTIFICATIONS

Implement automated email, SMS, and in-app notifications.

Support notifications for:

- Upcoming service.
- Driver en route.
- Driver arrival.
- Completed service.
- Missed pickup.
- Invoice generated.
- Payment received.
- Payment failed.
- Overdue invoice.
- Service changes.
- Holiday schedule changes.

Provide company-configurable notification templates.

## 17. REPORTING

Create reports for:

- Revenue.
- Expenses.
- Profitability.
- Accounts receivable.
- Customer balances.
- Collection rates.
- Driver performance.
- Route profitability.
- Truck utilization.
- Container utilization.
- Disposal tonnage.
- Recycling materials.
- Customer growth.
- Service completion.
- Missed pickups.

Support filtering, printing, and CSV/PDF exports.

## 18. SECURITY AND DATA PROTECTION

Implement:

- Secure authentication.
- Role-based permissions.
- Administrator MFA.
- Encrypted connections.
- Secure payment processing.
- Database backups.
- Restoration procedures.
- Audit logs.
- API rate limiting.
- Input validation.
- Error monitoring.
- Automated security tests.

Protect customer financial and personal information.

## 19. DATA MIGRATION

Create import tools for customer records, service locations, containers, routes, contracts, balances, and historical transactions.

Support documented CSV imports and authorized exports from existing systems.

Provide preview, validation, duplicate detection, and rollback procedures.

Never modify or delete existing company records during migration without explicit authorization.

## 20. DEVELOPMENT AND TESTING

Build the complete system in an organized repository.

Create automated tests for every major module.

Verify these end-to-end workflows:

1. Create customer → assign service → generate recurring invoice → collect payment.
2. Create order → dispatch driver → complete service → generate invoice.
3. Rent dumpster → deliver → exchange → collect → reconcile disposal charges.
4. Create route → assign driver → complete stops → update dispatch.
5. Customer submits request → office receives request → driver completes service.
6. Driver loses internet → completes jobs offline → reconnects → synchronizes.
7. Transfer station records weights → generates charges → reconciles payments.
8. Payment fails → account updates → customer receives notification.

Every important button, form, and operation must be functional.

Do not use mock data as a substitute for production features.

## 21. WINDOWS AND MOBILE BUILDS

Configure build pipelines for:

- Windows installer (.exe).
- Android installation package (.apk).
- iOS application build.
- Web application deployment.

Clearly document signing, credentials, deployment requirements, and platform-specific limitations.

Do not claim builds have been tested on devices unless they actually have.

## 22. PROJECT COMPLETION

Maintain a feature checklist identifying:

- Completed features.
- Tested features.
- Failed tests.
- Outstanding work.
- Required credentials.
- External integration blockers.
- Production readiness.

Do not claim completion until the entire required system passes acceptance testing.

Do not release unfinished builds as final versions.

## FINAL INSTRUCTION TO CODEX

This is a dedicated application for CoreWaste.

Do not create a multi-company SaaS subscription platform.

Do not include the future competitive software business in this repository.

Build CoreWaste's own complete waste-management operations system with original code and branding, matching CurbWaste's documented business functionality as closely as possible.

Start by establishing the architecture and database, then implement each connected module systematically.

Continue through the development milestones, running tests and fixing failures.

Document any work that cannot be completed because of unavailable external accounts, credentials, hardware, or deployment permissions.

The final deliverable must be a tested, integrated business system—not a demonstration dashboard.
