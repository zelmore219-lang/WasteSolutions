# Free-tier customer trial: Firebase + Render + Supabase

The chosen starter route keeps Firebase on Spark for authentication, runs the compiled website and API together on a Render **Free web service**, and uses a separate Supabase **Free project** for PostgreSQL and private attachments. Cloud Run, Cloud SQL, Firebase Functions and Firebase Storage are not used by this route. The existing paid Google Cloud deployment remains optional for later. Upgrading the same Render/Supabase/Firebase projects preserves the data model and attachment IDs.

No live deployment or provider authorization is claimed by these setup files. Free services have quotas, sleep/pause behavior and backup limits. Review their current terms before customer launch; this is a limited trial, not a capacity or availability guarantee. Don't choose a paid plan/add-on during this setup. Administrator MFA remains required; verify the project's supported factors before acceptance rather than disabling the guard.

## 1. Private Supabase bucket

Create **corewaste-private** in Storage with **Public bucket off**. The API checks the bucket's private flag, authenticates server-side, uploads without overwriting existing content and verifies attachment checksums. Files never get a public storage URL or a service-role key in the browser.

## 2. Database schema and restricted runtime login

Use a NEW dedicated CoreWaste project. Open `deployment/free/supabase-setup.sql`, copy its entire contents, and run it in that project's SQL Editor as **postgres**. The generated file contains49 numbered migrations, grants for the private API database role, anonymous/Data-API access revocation, and row-level security policies for that role. It refuses an unrelated existing installation. It does not create customer records or the shared demo login.

The final result is a generated runtime password. **Save that value privately for Render. Do not paste it in chat.** The role is `corewaste_app`. It cannot change the schema or mutate audit/command history. Re-running setup refuses to rotate an already configured login; keep the original password. If lost, deliberately rotate that role's password in database administration and update Render together.

From Supabase **Connect → Session pooler**, copy the PostgreSQL URI. Use port **5432**, not the transaction-pooler port6543. Keep the host and `/postgres` database name. Replace `postgres.PROJECT_REFERENCE` with **corewaste_app.PROJECT_REFERENCE** and replace the password with the generated runtime password, not the project administrator password. Add **?sslmode=verify-full** (or append `&sslmode=verify-full` if other query parameters already exist). This private URL goes only into Render's DATABASE_URL.

## 3. Firebase backend access and sign-in

The existing public web settings for **wastesoloutions** are already in `config/firebase-client.json`; do not generate new web keys unnecessarily. Enable Email/Password in Firebase Authentication.

In Firebase Project settings → Service accounts → Firebase Admin SDK, generate a service-account JSON for this same project. Store it privately. Its full contents go ONLY into Render's private **FIREBASE_SERVICE_ACCOUNT_JSON** environment field. Never commit the file, paste it in chat, or enter it into an app's public API-key field. The backend validates its project and key structure without logging the secret. The identity needs Firebase Authentication administration permissions for revocation/provisioning; it does not need Google billing/deployment permissions for this route.

## 4. Deploy the free Render blueprint

Connect this GitHub repository and select branch **codex/free-tier-deployment**, then create a Blueprint using the root **render.yaml**. Confirm the web service plan says **Free**. It uses **Dockerfile.free**; no Render database or persistent disk is declared, and auto-deploy is disabled.

Supply these four private settings in Render:

| Field | Value source |
|---|---|
| DATABASE_URL | Restricted corewaste_app session-pooler URI from step2, with verified TLS |
| SUPABASE_URL | Project settings → Data API/API → Project URL (`https://PROJECT_REFERENCE.supabase.co`) |
| SUPABASE_SERVICE_ROLE_KEY | API Keys → legacy **service_role** backend key; never use it in frontend code or chat |
| FIREBASE_SERVICE_ACCOUNT_JSON | The matching Firebase Admin SDK JSON from step3 |

The bucket defaults to **corewaste-private**. Render generates **PROVIDER_SETTINGS_SEED** once; the server derives its authenticated-encryption key from that private seed. Preserve and back up the seed securely. Do not regenerate it when redeploying or upgrading. Explicit PROVIDER_SETTINGS_KEY is also supported for the existing paid deployment; changing encryption keys requires a credential migration.

The service derives its HTTPS origin from Render's managed hostname. Payment mode stays test and notification workers stay disabled. Saving provider settings alone sends no messages and performs no charges. The server refuses the project administrator DB login or missing migrations and will not start without valid-format Firebase credentials for the configured project. Format validation is not proof of live Firebase permissions.

After deployment, copy the service's assigned **https://…onrender.com** address. Add that exact hostname (without scheme/path) to Firebase Authentication → Settings → Authorized domains. If the web API key has HTTP-referrer restrictions, include the service's actual website. Review MFA/Identity Platform options without enabling paid features; stop if the chosen factors require a plan outside the free constraint.

## 5. First owner and acceptance

Create your individual account in Firebase Authentication and verify its email. Copy its UID into `deployment/free/first-owner.sql` and run that query in the private Supabase SQL Editor. It refuses to replace an existing owner. Open the Render website at **/office**, sign in with your email and personal password, and use **Account security** to enroll a supported authenticator factor. Sign out and sign back in with MFA. Business routes remain blocked until the owner has completed MFA.

Before giving the customer live access, verify on the deployed services: health/schema and private credentials, owner login/MFA/revocation, customer ownership, customer/location creation, dispatch/driver completion, invoice and recorded payment, private attachment upload/download plus unauthorized denial, company prices/terms/timezone, and a backup/restore procedure that includes the provider-encryption seed. Do not use real charges or messages as an unapproved acceptance test. The demo/password1 account exists only in isolated local testing.

The office/customer portal run at the same Render origin. Windows users can enter **https://YOUR_RENDER_HOST/office** in the existing client connection screen; no Docker is needed on their computer. Native signing/device acceptance remains separate.

## Build evidence and maintenance

`Dockerfile.free` compiles API and web, prunes development dependencies, and runs as node. The combined image was exercised at a512 MB limit with a read-only filesystem, a restricted database role, valid-format locally generated test credentials and all49 migrations. Office/portal returned200; protected API401; unknown API paths stayed JSON404 instead of falling through to the SPA. A real Chromium check rendered the production sign-in under the new security headers with no page errors. No real Firebase authentication or Supabase API connection was attempted in these local checks.

Storage tests cover trusted HTTPS origins, private bucket enforcement, server-side authentication, non-overwriting retries, mismatched-object rejection and bounded downloads. Schema checks denied anonymous reads, DDL and audit deletion while allowing normal application writes. These checks supplement existing business tests; they do not replace deployed customer acceptance.

After adding migrations, regenerate the SQL file with `node scripts/export-supabase-schema.cjs` and review it. Never run initial setup against unrelated tables, reset a customer database, expose the bucket, disable TLS verification or remove administrator MFA to make deployment succeed.
