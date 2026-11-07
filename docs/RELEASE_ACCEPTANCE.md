# CoreWaste release acceptance

Passing local tests does not complete activation or establish production readiness. The user has deferred Firebase setup until software work is complete. No live resources, charges, messages, exports, publication or deployment are performed by the local build/test commands.

## Required external setup and acceptance

- Firebase: retain the supplied public web configuration for `wastesoloutions`; configure the backend GCP identity, authorized domains/providers, verified employee identities, production administrator MFA and account provisioning. Public web configuration alone cannot authorize the backend.
- Hosting/data: provision the reviewed API/web deployment and private PostgreSQL, durable private attachment storage, HTTPS/domain settings, secrets, monitoring, backup policy and cloud database/media restore drill. Review the company timezone, contact details, prices, areas and terms before receiving customer traffic.
- Payments: connect the intended Stripe account/mode, return URL and signed webhook. Verify checkout/card/ACH success/failure, consent limits, account-credit reconciliation and refunds with the provider. Refund events are `refund.created`, `refund.updated`, and `refund.failed`. Never use a live charge as a substitute for authorized acceptance.
- QuickBooks: authorize the intended company and chart/customer links, verify sandbox journal receipts and duplicate-delivery recovery, then approve any real export. Vendor/payable/native-document integration is broader work beyond the current journal export.
- Email/SMS: verify the company's sender identity/domain/phone, preferences/templates, uncertainty handling and real receipt/delivery. Queued portal notices are not proof of external delivery.
- Road mapping: supply the authorized Amazon Location region/key/network rules and licensed basemap; verify local truck restrictions, geometry, traffic/timing and GPS/permission behavior. Unsupported linked optimization, trailers and hazardous cargo remain explicit limitations.
- Installed clients: provide Windows/Android/iPhone devices and the required signing/distribution identities. Verify installation, login/MFA/recovery, offline interruption/replay, permissions, evidence capture, updates and uninstall. JavaScript exports and an unsigned Windows ZIP are not signed native/device acceptance.
- Scale hardware: provide protocol/calibration/access and verify weights, reading identity, charges and recovery against the actual scale. Manual verified readings do not prove hardware integration.
- Migration/business acceptance: supply authorized source exports and reviewed cutover totals. Historical source lookup does not imply historical ledger conversion. Review contract/fee/tax/amendment policy, expense attribution, physical yard counts, real schedules and all eight required end-to-end scenarios with company operators.
- Security/operations: resolve or accept documented dependency findings through supported upstream versions, review deployed roles/configuration, perform representative load and cloud recovery tests, and complete operational ownership/runbooks.

## Windows download limitation

The previously generated workspace ZIP is an unsigned connection client and cannot run the database/server by itself. A workspace file link was not a usable download for the user. No working public download or Windows machine run has been verified. GitHub Releases delivery currently cannot be performed from this environment because `api.github.com` access was denied. Do not repeat the internal workspace link as a verified download or imply that the ZIP provides full business testing before a test server/account exists.

These outstanding requirements must remain visible. Do not label an unfinished or externally unverified build as 100% complete.
