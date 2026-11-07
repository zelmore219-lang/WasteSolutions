import { test } from "node:test";
import assert from "node:assert/strict";
import { useClientAuthEmulator } from "../../web/src/client-identity-mode";
const kit = {
  emulator: "true",
  development: false,
  mode: "local-test",
  localTestKit: "true",
  projectId: "demo-corewaste",
};
const address = { protocol: "http:", hostname: "127.0.0.1", port: "8088" };
test("local test client permits demo identity only in its explicit loopback build", () => {
  assert.equal(useClientAuthEmulator(kit, address), true);
  for (const change of [
    { hostname: "public.example" },
    { hostname: "localhost" },
    { port: "443" },
    { protocol: "https:" },
  ])
    assert.throws(() => useClientAuthEmulator(kit, { ...address, ...change }));
  assert.throws(() =>
    useClientAuthEmulator({ ...kit, projectId: "wastesoloutions" }, address),
  );
  assert.throws(() =>
    useClientAuthEmulator({ ...kit, mode: "production" }, address),
  );
  assert.throws(() =>
    useClientAuthEmulator({ ...kit, localTestKit: undefined }, address),
  );
});
test("normal production client cannot enable emulator authentication; development retains its demo-only guard", () => {
  assert.equal(
    useClientAuthEmulator(
      {
        ...kit,
        emulator: undefined,
        mode: "production",
        projectId: "wastesoloutions",
      },
      { protocol: "https:", hostname: "company.example", port: "" },
    ),
    false,
  );
  assert.throws(() =>
    useClientAuthEmulator(
      { ...kit, mode: "production", localTestKit: undefined },
      address,
    ),
  );
  assert.equal(
    useClientAuthEmulator(
      {
        ...kit,
        development: true,
        mode: "development",
        localTestKit: undefined,
      },
      address,
    ),
    true,
  );
  assert.throws(() =>
    useClientAuthEmulator(
      {
        ...kit,
        development: true,
        mode: "development",
        projectId: "real-project",
      },
      address,
    ),
  );
});
