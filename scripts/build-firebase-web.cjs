// Public client configuration only. Never copies ADC, database URLs or provider keys.
const { spawnSync } = require("node:child_process");
const profile = require("../config/firebase-client.json");
const env = {
  ...process.env,
  VITE_FIREBASE_API_KEY: profile.apiKey,
  VITE_FIREBASE_AUTH_DOMAIN: profile.authDomain,
  VITE_FIREBASE_PROJECT_ID: profile.projectId,
  VITE_FIREBASE_APP_ID: profile.appId,
  VITE_FIREBASE_STORAGE_BUCKET: profile.storageBucket,
  VITE_FIREBASE_MESSAGING_SENDER_ID: profile.messagingSenderId,
  VITE_USE_AUTH_EMULATOR: "false",
  VITE_LOCAL_TEST_KIT: "false",
};
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
// npm.cmd requires the Windows command shell; all arguments are fixed, not user input.
const result = spawnSync(
  npm,
  ["run", "build", "-w", "@corewaste/web", "--", "--mode", "firebase"],
  { env, stdio: "inherit", shell: process.platform === "win32" },
);
process.exit(result.status ?? 1);
