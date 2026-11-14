# Windows testing

## Current download: version 0.3.0

[Direct installer download](https://github.com/zelmore219-lang/WasteSolutions/releases/download/demo-v0.3.0/CoreWaste-Setup-0.3.0-x64.exe), anonymously downloaded and checked against the published SHA256 plus NSIS CRC. Follow [installation steps](../DOWNLOAD-WINDOWS.md). This supersedes earlier artifact-only download instructions below. The installer has the CORE-inspired icon; hosted activation and actual Windows acceptance are still pending.


**A working installer artifact is now listed on the [successful GitHub build](https://github.com/zelmore219-lang/WasteSolutions/actions/runs/42422788236).** Follow [download/install instructions](../DOWNLOAD-WINDOWS.md). Sign in to GitHub to download it. The current installer opens the connection screen; business features still require hosted activation. This delivery result supersedes earlier workspace/GitHub delivery limitations below.


## Installable Windows client

`CoreWaste-Setup-0.2.0-x64.exe` is the compiled per-user installer for Windows 10/11 x64. It adds a Start-menu shortcut and Windows Installed Apps uninstall entry, offers an installation directory, refuses existing/nonempty destinations and preserves AppData settings on removal. Docker and administrator access are not required. Close CoreWaste before removal. Live Firebase/API/database activation and an employee account are still required for sign-in.

The installer is unsigned and compiled on Linux, not tested on a Windows machine. Its PE/NSIS headers, complete installer CRC and SHA256 were checked; twelve desktop checks pass. It is 157,895,602 bytes; SHA256 `2b6831ba6e3a4c9298159ad87a590f330016311e088824396d9304b2b0c6ffe1`. Download hosting remains blocked; a workspace path is not a working download URL.

Rebuild the current Windows runtime with Electron Builder, then run `python3 scripts/build-windows-installer.py`. The script uses the Linux NSIS compiler already downloaded by the portable build; no Wine or Windows build container is needed. Outputs and checksums go to `.local/firebase-installer`. [Installer startup notes](../distribution/firebase/INSTALLER-README.txt).


The user now prefers the **Firebase-hosted client without Docker**. Its separate `CoreWaste-Firebase-Windows-0.2.0-x64.zip` contains a portable EXE and startup instructions, prefilled for the intended Firebase website. Live services and accessible delivery are pending; billing will be enabled later. See [Firebase release preparation](FIREBASE_RELEASE.md).

The older full local kit below remains an optional Docker-based development path.

## Optional local test download

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
