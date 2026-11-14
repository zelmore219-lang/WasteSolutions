# Provider configuration in Settings

Open **Settings → Providers** after signing in. Office/finance roles can review redacted configuration; only an owner who has completed normal administrator MFA can save changes. The isolated `demo` / `password1` account is a dispatcher and cannot change provider keys.

| Section | Values to enter |
|---|---|
| Firebase | Public web API key, project ID, auth domain, app ID and storage bucket from Firebase Console → Project settings → General → Your apps → Config. The project must match the backend identity project. Enabled public settings apply after reloading the app. |
| Stripe | Secret API key, webhook signing secret, test/live mode and payment return website. The return website must match the configured company website. |
| QuickBooks | Client ID/secret, registered OAuth return address and sandbox/production environment. Then connect the intended company from QuickBooks. |
| Email | Resend API key and verified sender email. |
| SMS | Twilio account SID/auth token and verified international sender phone number. |
| Road routing | Amazon Location routing API key and AWS region. |
| File storage | Choose Supabase for the free route (project URL, private bucket and backend service-role key), or Google Cloud Storage for the paid route. |

Do not enter a Firebase service-account JSON/private key here or paste it in chat. Backend Google Cloud identity is connected through secure deployment configuration. Firebase web keys alone cannot activate hosting, API access, PostgreSQL, IAM or employee accounts.

Saving is configuration only: it does not verify a provider connection, send queued messages, export to QuickBooks or charge a payment. Test real providers separately before activation. In the isolated emulator demo, external providers cannot be enabled. Environment-provided settings remain in effect until a saved configuration overrides that provider; the page distinguishes deployment settings from saved settings. Blank secret fields preserve existing saved values. Removal applies only to a saved secret, not a deployment-managed environment value.

## Secure storage setup (deployment operator)

Apply migrations through **049** before running the updated API. Connect **PROVIDER_SETTINGS_KEY** to the backend through Secret Manager as a canonical base64-encoded 32-byte random key. This is an app encryption key, not a Firebase API key. Use a separate key for each environment. Do not commit it or expose it through a VITE variable. Keep it stable and back it up separately from the database; replacing it without a credential migration locks previously stored secrets.

The Cloud Run deployment helper now requires `COREWASTE_PROVIDER_KEY_SECRET`, the Secret Manager name containing that key, in addition to the database/image/identity settings. Grant the runtime identity access only to the needed secret versions and resources. A separately deployed scheduled-job process also needs that encryption key to read provider settings.

Until secure storage is configured, the UI disables entering private provider keys and the backend refuses secret writes. Public values can still be saved. Keys use AES-256-GCM with fresh nonces and provider/field binding. GET responses, idempotent command responses and audit records never return the plaintext secrets. The browser does not store them in localStorage. Version checks prevent stale edits and idempotency prevents repeat saves. Runtime processes refresh saved configuration; Firebase backend identity remains deployment-managed. Disabling new Stripe requests retains the webhook verifier and payment-mode checks for incoming receipts.

## Isolated demo login

Provision only with the separate demo Firebase emulator and a dedicated demo database:

```sh
NODE_ENV=test FIREBASE_PROJECT_ID=demo-corewaste \
FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 \
DATABASE_URL=postgresql://...@127.0.0.1/corewaste_demo_test \
node --import tsx scripts/provision-demo.ts
```

Use username **demo**, password **password1**. This is a real Firebase-emulator sign-in mapped to an active dispatcher employee, not a token/role bypass. Production, non-demo Firebase projects and business database names are rejected. The bundled Docker test initializer also provisions this account while retaining the separate generated role accounts and owner MFA. This change does not turn the Firebase-connected Windows installer into an offline standalone demo.

For the free Render blueprint, the automatically generated private **PROVIDER_SETTINGS_SEED** derives a stable encryption key. Preserve it across restarts/upgrades and back it up securely. Initial Firebase backend credentials are entered only in Render’s private environment field, not this Settings page or chat. See [free setup](FREE_HOSTING_SETUP.md).
