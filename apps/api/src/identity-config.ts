export function assertIdentityConfiguration(
  env: NodeJS.ProcessEnv = process.env,
) {
  if (!env.FIREBASE_AUTH_EMULATOR_HOST) return;
  if (
    !["development", "test"].includes(env.NODE_ENV || "") ||
    !env.FIREBASE_PROJECT_ID?.startsWith("demo-") ||
    !/^(127\.0\.0\.1|localhost):[0-9]{1,5}$/.test(
      env.FIREBASE_AUTH_EMULATOR_HOST,
    )
  )
    throw new Error(
      "Authentication emulator requires development/test mode, a demo-* project and loopback host",
    );
}
