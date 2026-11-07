import { defineConfig } from "@playwright/test";
const database = process.env.TEST_DATABASE_URL;
if (!database || !new URL(database).pathname.endsWith("_test"))
  throw Error("TEST_DATABASE_URL must name a dedicated *_test database");
export default defineConfig({
  testDir: "tests/browser",
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  use: {
    baseURL: "http://127.0.0.1:5174",
    headless: true,
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : {},
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "node --env-file=.env --import tsx apps/api/src/main.ts",
      port: 3100,
      reuseExistingServer: false,
      env: {
        NODE_ENV: "test",
        STRIPE_SECRET_KEY: "",
        STRIPE_WEBHOOK_SECRET: "whsec_local_browser_only",
        PAYMENTS_MODE: "test",
        ROUTING_API_KEY: "",
        ROUTING_REGION: "",
        NOTIFICATIONS_WORKER_ENABLED: "false",
        STORAGE_DRIVER: "local",
        PORT: "3100",
        DATABASE_URL: database,
        FIREBASE_PROJECT_ID: "demo-corewaste",
        FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099",
        WEB_ORIGIN: "http://127.0.0.1:5174",
      },
    },
    {
      command:
        "npm exec -w @corewaste/web -- vite --host 127.0.0.1 --port 5174",
      url: "http://127.0.0.1:5174",
      reuseExistingServer: false,
      env: {
        VITE_MAP_TILE_URL: "",
        VITE_MAP_ATTRIBUTION: "",
        COREWASTE_API_PROXY: "http://127.0.0.1:3100",
        VITE_USE_AUTH_EMULATOR: "true",
        VITE_FIREBASE_PROJECT_ID: "demo-corewaste",
        VITE_FIREBASE_API_KEY: "local-test-key",
        VITE_FIREBASE_AUTH_DOMAIN: "demo-corewaste.firebaseapp.com",
      },
    },
  ],
});
