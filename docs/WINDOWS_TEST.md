# Windows test download

## What this build can test

The current downloadable Windows x64 client can open the connection screen, save an HTTPS CoreWaste server address, and connect to that server. It is not a standalone installation of the server/database, and it contains no credentials, default account, or sample business records.

A reachable CoreWaste test server and a provisioned test account are still needed to test dispatching, billing, inventory, and other authenticated workflows. Firebase activation and externally reachable server setup remain pending. Do not mistake the client download for completion of the application or a ready-to-use business system.

## Open the portable download

1. Download `CoreWaste-Windows-Test-0.1.0-x64.zip`.
2. Right-click the ZIP and choose **Extract All**. Keep the extracted files together.
3. Open **CoreWaste.exe** in the extracted folder.
4. When a test server address is supplied, enter it on the connection screen and choose **Connect**. Do not enter a Firebase project address; this field needs the hosted CoreWaste web application's URL.
5. Use **Connection → Change server** to update the address later.

This is an unsigned development build. Windows may show a publisher warning. No certificate or Windows protection settings need to be changed. Native Windows installation, startup, and device acceptance have not been verified in this Linux build environment. Do not use this build for production work.

## Rebuild

From the repository root after `npm ci`:

```sh
npm run package:windows:zip -w @corewaste/desktop
# NSIS installer, on Windows or a cross-build host with Wine:
npm run package:windows -w @corewaste/desktop
node --test apps/desktop/test/*.test.cjs
```

Artifacts are written to `.local/windows-test`. Electron is explicitly selected as 45.2.3. The build does not publish artifacts, use signing credentials, or embed environment secrets. Connection settings are stored in the user's Electron application-data directory. Remote pages cannot access the connection-settings IPC; navigation is restricted to the chosen server origin and popup windows and device permissions are denied.
