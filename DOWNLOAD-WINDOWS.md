# Install CoreWaste on Windows

[Download CoreWaste Setup 0.3.0 for Windows x64](https://github.com/zelmore219-lang/WasteSolutions/releases/download/demo-v0.3.0/CoreWaste-Setup-0.3.0-x64.exe) — 158 MB. This is a normal public release download; no Actions artifact search is needed. The entire file was downloaded anonymously and verified against its published checksum.

1. Download the EXE and run it.
2. Choose an empty installation folder.
3. Open **CoreWaste** from the Windows Start menu.

No Docker or Node.js is needed on your Windows computer. Windows 10/11 x64 is required. The unsigned development installer was compiled and integrity-checked on Linux; actual Windows installation/startup/removal remain unverified. Do not disable Windows protection settings.

**This is the Firebase-connected client. It opens connection setup; business features still require an activated hosted API/database, Firebase access and a provisioned account. It is not an offline standalone demo.**

The source now includes Settings → Providers, encrypted private-key storage and the CORE-inspired icon. In an isolated demo backend only, the username is **demo**, password **password1** (dispatcher permissions). These credentials do not provision or bypass production Firebase login. See [provider configuration](docs/PROVIDER_SETTINGS.md).

[Release notes and checksum](https://github.com/zelmore219-lang/WasteSolutions/releases/tag/demo-v0.3.0). Downloaded installer SHA256: `e7c86d40b29ca08f02f58fa8a34e7d0865243c91fd8c8dd23f93600ba27d1ed1`. Size:158,047,362 bytes. Checksum and full NSIS CRC passed. This verifies integrity, not publisher identity.

Use **Uninstall CoreWaste** in the Start menu or Windows Installed Apps to remove it. AppData settings and cloud records are preserved.
