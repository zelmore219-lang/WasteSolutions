# Firebase-hosted CoreWaste release

This is the active direction for testing without Docker on the user's computer. Firebase Authentication handles sign-in, Firebase Hosting serves the office/portal/public app, and Hosting forwards `/api` to the `corewaste-api` Cloud Run service in `us-central1`. Business transactions remain in PostgreSQL; the existing ledger, audit trail and 47 SQL migrations are not converted into unreviewed Firestore writes. Private attachments use the supplied Firebase Storage bucket through the API's existing Google Cloud Storage adapter.

## Prepared software

- `config/firebase-client.json` contains the user's public Firebase web settings for **wastesoloutions**. These are not administrative credentials.
- `node scripts/build-firebase-web.cjs` builds the real app with those settings, including app ID and bucket, while explicitly disabling both emulator flags regardless of inherited environment values.
- `firebase.hosting.json` places API rewrites ahead of the SPA fallback, pins the Cloud Run revision and sets no-store headers for app/API paths. This separate file preserves the existing isolated emulator configuration.
- The Windows portable client pre-fills `https://wastesoloutions.web.app/office`. It needs no Docker, database install or Node.js on Windows. Before loading that Firebase site it requires a successful JSON API/database health response; a default Firebase welcome page is rejected.
- `deployment/firebase/api.env.example` and `scripts/deploy-firebase-api.sh` describe the hosted runtime and guarded migration/deployment commands. The deployment script requires an image digest, separate runtime/schema-owner service accounts, Cloud SQL and Secret Manager names. It does not create those prerequisites or log secrets.
- `deployment/firebase/storage.rules` denies direct client file access; the API enforces customer/employee ownership and uses IAM for server access. These rules are a reviewable template, not a claim that the live bucket was changed. Do not overwrite rules used by another app without reviewing that use.

## Activation still required

This environment has no ready, authorized Google Cloud identity. A credential-path variable alone is not proof of a usable identity. Its enforced network policy excludes Google/Firebase management and authentication APIs. A fresh request to `firebasehosting.googleapis.com` was rejected by the proxy with CONNECT403. No environment settings or live project resources were changed.

The project owner must enable billing/Blaze for Cloud Run, Cloud SQL and Storage as required, and securely connect a least-privilege deployment identity. Do not send private keys or passwords in chat. Permit the intended deployment/authentication endpoints in environment network settings: `firebasehosting.googleapis.com`, `firebase.googleapis.com`, `cloudresourcemanager.googleapis.com`, `serviceusage.googleapis.com`, `run.googleapis.com`, `sqladmin.googleapis.com`, `secretmanager.googleapis.com`, `iam.googleapis.com`, `oauth2.googleapis.com`, `accounts.google.com`, `identitytoolkit.googleapis.com`, `securetoken.googleapis.com`, `storage.googleapis.com`, `us-central1-docker.pkg.dev`, and the project's actual Hosting/Cloud Run hosts. Additional build/upload destinations depend on the chosen operator's toolchain; review reported destinations rather than allowing all hosts.

Before publishing:

1. Provision reviewed PostgreSQL/Cloud SQL in the same region, backups/PITR, restricted application and separate schema-owner DB users. Store their URL-encoded connection URLs in separate Secret Manager secrets, using the Cloud SQL Unix socket. Enable necessary service APIs and Artifact Registry.
2. Grant the runtime identity Firebase Authentication administration permissions required by revocation/provisioning, Cloud SQL Client, access only to its database secret and private attachment bucket. Give the migration identity its own database secret and Cloud SQL access. Review deployment identity permissions separately; do not grant all users database/bucket access.
3. Build the existing API Dockerfile, push it to this project's Artifact Registry and review the immutable digest. Supply the required `COREWASTE_*` settings listed by `scripts/deploy-firebase-api.sh`; run it as the authorized operator. It runs the migration job before deploying the API. Its Cloud Run transport is public for Hosting, while business endpoints still enforce Firebase identity/roles. No automated billing or provider-delivery schedule is installed.
4. In Firebase Authentication enable Email/Password; authorize `wastesoloutions.web.app` and the actual approved domains. Configure Identity Platform/MFA as needed. Create/verify the first owner identity, provision its employee mapping using `scripts/provision.ts` and enroll MFA before acceptance. Public sign-up does not grant employee permissions.
5. Deploy Hosting with an authenticated Firebase CLI:

   ```sh
   firebase deploy --only hosting --project wastesoloutions --config firebase.hosting.json
   node scripts/firebase-readiness.cjs --online
   ```

   The predeploy command rebuilds the Firebase web app, never starts an emulator. Review the Firebase CLI version/environment before deployment; the existing toolchain uses 15.35.0. A successful public health check is not a successful employee sign-in or business acceptance test.
6. Test real project sign-in/MFA, revocation, customer ownership, dispatch, invoice/payment recording, private attachments, backup recovery and Windows execution. Keep live charges/messages/integrations disabled until separately accepted.

## Windows installer

The standard per-user installer is `CoreWaste-Setup-0.2.0-x64.exe`. It includes Start-menu shortcuts and an uninstaller, writes only current-user installation registry entries and preserves AppData/cloud records. It refuses a nonempty destination or an existing registered installation; uninstall first to reinstall. It contains the same Firebase-connected client as the portable package, without Docker, credentials or local databases.

```sh
npm run package:windows:portable -w @corewaste/desktop
python3 scripts/build-windows-installer.py
```

The output is in `.local/firebase-installer`, with a SHA256 checksum and startup instructions. Linux NSIS compilation, PE/NSIS structure and whole-installer CRC validation passed. It remains unsigned, and actual Windows installation, launch and uninstallation are unverified. The manual Windows-download workflow also prepares this installer as a separate artifact. It has not been published or run remotely.

## Portable Windows artifact

```sh
npm run package:windows:portable -w @corewaste/desktop
python3 scripts/package-firebase-windows.py
```

The output `.local/firebase-download/CoreWaste-Firebase-Windows-0.2.0-x64.zip` contains the portable EXE and `START-HERE.txt`, with a separate SHA256 file. It is unsigned and does not include local containers or credentials. The API health gate and runtime settings have automated tests; actual Windows execution remains pending.

A build file in this workspace is not an accessible download. The manual **Prepare Windows test downloads** workflow also prepares this hosted-client ZIP as a GitHub Actions artifact; it has not been run remotely. GitHub API delivery remains blocked here. Do not label the project URL as deployed or repeat a workspace ZIP link as a verified download.

## Download delivery update

The installer is available as an artifact from the [successful repository build](https://github.com/zelmore219-lang/WasteSolutions/actions/runs/42422788236), verified on its build page. The normal Git connection enabled a separate delivery branch and a push-triggered workflow despite the blocked REST/upload APIs. See [installation steps](../DOWNLOAD-WINDOWS.md). Earlier statements that no remote build/artifact was available are superseded. Cloud activation and Windows execution acceptance remain pending.

## Version 0.3.0 settings and branding

The application now includes [Settings → Providers](PROVIDER_SETTINGS.md), authenticated encryption for stored provider secrets, runtime provider configuration and a public-field-only Firebase client profile. Migration048 and the secure provider encryption key are required. The demo username/password are demo/password1, only in the isolated emulator. The Windows icon is derived from the supplied CORE green circular mark; Windows EXE, setup/uninstaller, web favicon and driver assets use the icon. Native Windows/device acceptance and live cloud/provider activation remain pending.
