# Firebase connection

The published environment supplies FIREBASE_PROJECT_ID, VITE_FIREBASE_PROJECT_ID, VITE_FIREBASE_API_KEY and VITE_FIREBASE_AUTH_DOMAIN. The web application reads these directly; process variables take precedence over blank local .env entries. Firebase web configuration is public configuration, not server credentials.

The current supplied project is wastesoloutions. The app's web build uses its configured auth domain. No Firebase project, authentication provider, billing setting or cloud resource was changed by this coding session.

To accept real authentication:
1. Enable Email/Password in Firebase Authentication.
2. Add the actual deployed website hostname to Firebase Authentication's authorized domains.
3. Enable the desired MFA providers/Identity Platform capabilities for administrator MFA.
4. Attach a Google Cloud service account or another supported Application Default Credential identity to the backend. Token revocation checks and employee creation need Firebase Authentication administration permissions. Do not paste a private key into chat or commit a service account file.
5. Provision the first verified administrator using the operator script and enroll MFA through Account security. Public registration only requests customer access; office approval links a verified customer to an account.
6. Restart Vite after changing web configuration and rebuild the web distribution for deployment.

There is no configured GCP outbound identity or GOOGLE_APPLICATION_CREDENTIALS variable in the current environment. Production authentication has not been verified. The environment's current outbound allowlist also needs to permit the Firebase/Google authentication endpoints used by the selected credential mechanism before backend provider calls can work. These requirements were documented, not published as environment changes.

The driver build uses EXPO_PUBLIC_FIREBASE_PROJECT_ID, EXPO_PUBLIC_FIREBASE_API_KEY and EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN with the same Firebase project values. EXPO_PUBLIC_API_URL must point to the deployed HTTPS CoreWaste API including its /api prefix. Native application IDs, signing and Firebase provider settings must be accepted on installed devices.

Tests use a separate demo-corewaste Firebase Auth emulator and dedicated PostgreSQL test database. Explicit test subprocess variables prevent the emulator from ever connecting to the real project. Emulator use is rejected for production or a non-demo project.
