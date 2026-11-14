This prerelease installs the **Firebase-connected Windows client**, with the CORE-inspired app icon, Start-menu shortcut and uninstaller. It requires no Docker on Windows.

**Cloud activation is still pending. The installer opens connection setup; business features require the hosted API/database and verified Firebase account to be activated.** It is not an offline standalone demo.

The app source now includes Settings → Providers for Firebase, Stripe, QuickBooks, Resend email, Twilio SMS, Amazon Location routing and private storage. Owner changes require normal administrator MFA. Saved private keys use authenticated encryption; they are never returned in settings or audit responses. Provider connections and real deliveries/payments remain unverified. Configure the server encryption key through secure deployment settings before entering provider secrets.

The username `demo` and password `password1` work only against the isolated demo backend. They do not create a shared login on the live Firebase project. The demo account has dispatcher permissions; owner-only settings remain protected.

Download `CoreWaste-Setup-0.3.0-x64.exe`, run it and open CoreWaste from the Start menu. Windows 10/11 x64 is required. This is an unsigned development build; actual Windows installation, launch and removal remain unverified. Do not disable Windows protection settings. The checksum verifies integrity, not publisher identity.
