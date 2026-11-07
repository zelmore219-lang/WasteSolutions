# Install CoreWaste on Windows

The installer build succeeded and its artifact is available on the [verified GitHub build page](https://github.com/zelmore219-lang/WasteSolutions/actions/runs/42422788236).

1. Sign in to GitHub with your account and open that page.
2. Under **Artifacts**, click **CoreWaste-Windows-Installer-0.2.0-x64-UNSIGNED** (151 MB).
3. Extract the downloaded ZIP.
4. Run **CoreWaste-Setup-0.2.0-x64.exe**, choose an empty installation folder, then open **CoreWaste** from the Windows Start menu.

No Docker or Node.js is required on your Windows computer. Windows 10/11 x64 is required. This unsigned development installer was built and integrity-checked on Linux; actual Windows installation/startup/removal remain unverified. Do not disable Windows protection settings to run it.

**The current installer opens the connection screen. Exploring the business features requires an activated hosted API/database, Firebase sign-in and a provisioned account. Those services are still pending; installing the client does not activate them.** The owner plans to enable Firebase billing later.

The artifact remains available for14 days after the run. Its outer artifact SHA256 reported by GitHub is `5f59fc10163d8c43cc1631d8078474b9a9b4cb08e417d03f84c786bf135bd0c8`. Check the included `.exe.sha256` for the installer itself; the local development build may have a different hash. No passwords or customer records are included.

Use **Uninstall CoreWaste** in the Start menu or Windows Installed Apps to remove it. AppData settings and cloud records are preserved.
