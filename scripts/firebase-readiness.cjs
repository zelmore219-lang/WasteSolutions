const fs = require("node:fs");
const config = require("../config/firebase-client.json");
const hosting = require("../firebase.hosting.json").hosting;
const {
  HOSTED_URL,
  verifyFirebaseHost,
} = require("../apps/desktop/hosted.cjs");
(async () => {
  const checks = {
    project: config.projectId,
    website: HOSTED_URL,
    client_config: Boolean(
      config.apiKey &&
      config.appId &&
      config.authDomain === `${config.projectId}.firebaseapp.com`,
    ),
    web_build: fs.existsSync(hosting.public + "/index.html"),
    api_rewrite: hosting.rewrites[1]?.run?.serviceId === "corewaste-api",
    // These cannot be established from public client settings or a credential file's presence.
    cloud_identity: "not verified",
    database: "not verified",
    employee_account: "not verified",
    live_deployment: "not verified",
  };
  if (process.argv.includes("--online")) {
    try {
      await verifyFirebaseHost(HOSTED_URL);
      checks.live_deployment =
        "API/database health passed; sign-in acceptance still required";
    } catch {
      checks.live_deployment = "unreachable, blocked or not activated";
      process.exitCode = 1;
    }
  }
  if (!checks.client_config || !checks.web_build || !checks.api_rewrite)
    process.exitCode = 1;
  console.log(JSON.stringify(checks, null, 2));
})().catch(() => {
  console.error("Firebase preparation check failed.");
  process.exitCode = 1;
});
