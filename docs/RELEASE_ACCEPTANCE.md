# CoreWaste release acceptance

Passing local tests does not complete activation or establish production readiness. The user now requests Firebase integration; public client/Hosting preparation is in place. The user confirmed billing is not enabled and plans to enable it later. Cloud Run/PostgreSQL activation remains pending. No live resources, charges, messages, exports, publication or deployment are performed by the local build/test commands.

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

## Windows test-kit status

The 0.2.0 full local kit now includes the API, database, office web app and test identity emulator, rather than only the earlier connection client. Docker Desktop with Linux containers is required. Business workflows and clean restart persistence passed Linux/Docker/Chromium validation; Windows execution, signing and real devices remain pending. See [Windows testing](WINDOWS_TEST.md).

No working public download has been verified. GitHub delivery is blocked by denied `api.github.com` access in this environment. The manual download workflow and archive are prepared, but have not been published or run remotely. An internal workspace link is not a verified download.

These outstanding requirements must remain visible. Do not label an unfinished or externally unverified build as 100% complete.

## Firebase client release preparation

The Windows client is preconfigured for the intended Firebase host and needs no Docker on the user’s computer. It rejects a Firebase welcome page or unhealthy API. Public client configuration, a production web build, API rewrites, private-storage rules template, and guarded Cloud Run migration/deployment scripts are prepared. Actual hosting, authentication/MFA, database/bucket setup, Windows acceptance and downloadable delivery are still pending. See [Firebase release](FIREBASE_RELEASE.md).

## Standard Windows installer

The per-user `CoreWaste-Setup-0.2.0-x64.exe` compiled successfully, with Start-menu/uninstall registration and verified PE/NSIS structure, CRC and SHA256. It requires no Docker on Windows. It remains unsigned; native Windows installation/launch/removal, hosted delivery and live Firebase sign-in are unverified. See [Windows instructions](WINDOWS_TEST.md).

## Verified installer artifact delivery

The separate delivery branch now has a [successful GitHub installer run](https://github.com/zelmore219-lang/WasteSolutions/actions/runs/42422788236) with the named downloadable artifact. GitHub sign-in is required. This supersedes earlier download-hosting blockers, while live cloud activation and Windows execution remain unverified. The installer currently opens a connection screen; it cannot enable business exploration without the hosted API/database and Firebase account setup.
