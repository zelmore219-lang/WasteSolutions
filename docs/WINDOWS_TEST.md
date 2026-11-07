# Windows local test download

The version 0.2.0 Windows x64 kit bundles the CoreWaste office app, compiled API, PostgreSQL and an isolated Firebase identity emulator. It supports local business testing without activating the live Firebase project. Install Docker Desktop with Linux containers first; Node.js and a live server are not required.

## Start on Windows

1. Download `CoreWaste-Windows-Local-Test-0.2.0-x64.zip` and choose **Extract All** into a writable folder.
2. Start Docker Desktop in Linux-container mode.
3. Double-click **Start-CoreWaste.cmd**, then **Start local test system**. Initial image import may take several minutes.
4. When Ready appears, choose **Show local test sign-ins**, then **Open CoreWaste**.
5. Use the generated owner, dispatcher, accountant or driver account. Owner sign-in requires MFA: request a code in the app, then use **Show local sign-in code** in the separate controls window.
6. Choose **Stop local services** when finished. Closing the windows alone leaves services running.

Use test information only. Customer, job and financial records start empty; four clearly identified test accounts and one test truck are provisioned. Live payments, QuickBooks, external message delivery and live road planning are disabled. This loopback-only kit is not a phone/LAN server or production installation.

Preserve `local-test/.state` and the installation's Docker volumes. State contains generated passwords and private configuration; do not upload it. Clean Stop saves emulator identities before stopping services and preserves database/uploads. If the save fails, Stop reports an error and leaves services running. Do not delete volumes as a recovery step. Abrupt computer shutdown still requires recovery testing.

The app is unsigned. No protection settings, TLS checks or execution policies need to be disabled. Actual Windows installation/startup and device acceptance remain unverified; the executable was built on Linux. See the included `START-HERE.txt` for troubleshooting.

## Completed checks

The bundled services passed real Chromium workflows for owner MFA, customer/location creation, dispatch, driver completion, invoice creation and recorded cash payment. Database records, account identity and owner MFA survived a clean Stop/Start. Ten desktop security/controller tests pass. No live charge or external delivery was performed.

The archive builder validates service SHA256 hashes, ZIP CRCs and the Windows executable header and excludes generated state, passwords and logs. Hosted mode remains HTTPS-only; local Docker controls are available only to the trusted setup window, never the office web page.

## Build and deliver

```sh
npm ci
npm run package:windows:portable -w @corewaste/desktop
bash scripts/build-local-test-images.sh
node scripts/package-windows-test-kit.cjs
python3 scripts/archive-windows-test-kit.py .local/windows-download/CoreWaste-Windows-Local-Test-0.2.0-x64
```

The manual **Prepare Windows test downloads** GitHub Actions workflow builds and tests the full kit, then uploads the ZIP and checksum as a 14-day workflow artifact. A separate Windows job builds the hosted-client NSIS installer; that installer alone does not include local services. Neither job publishes a release or deploys the app.

A ZIP on this workspace is not a verified browser download. Delivery through GitHub remains blocked here because `api.github.com` is denied; no public download URL or remote workflow run is claimed. Do not repeat an internal workspace link as a working download.
