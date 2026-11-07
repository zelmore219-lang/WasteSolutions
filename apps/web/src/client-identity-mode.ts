type IdentityMode = {
  emulator: string | undefined;
  development: boolean;
  mode: string;
  localTestKit: string | undefined;
  projectId: string | undefined;
};
type Address = { protocol: string; hostname: string; port: string };
export function useClientAuthEmulator(config: IdentityMode, address: Address) {
  if (config.emulator !== "true") return false;
  const isolatedKit =
    config.mode === "local-test" &&
    config.localTestKit === "true" &&
    address.protocol === "http:" &&
    address.hostname === "127.0.0.1" &&
    address.port === "8088";
  if (
    !config.projectId?.startsWith("demo-") ||
    (!config.development && !isolatedKit)
  )
    throw Error(
      "Auth emulator requires development or the explicit loopback local-test build, and a demo project",
    );
  return true;
}
