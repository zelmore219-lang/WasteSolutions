const fs = require("node:fs/promises");
const { randomUUID } = require("node:crypto");
async function main() {
  if (
    process.env.NODE_ENV !== "test" ||
    process.env.FIREBASE_PROJECT_ID !== "demo-corewaste"
  )
    throw Error(
      "Identity snapshots are restricted to the isolated demo test kit",
    );
  const base = "http://127.0.0.1:9099",
    headers = { Authorization: "Bearer owner" };
  const read = async (route) => {
    const response = await fetch(base + route, {
      headers,
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw Error("Local identity export was not confirmed");
    return response.json();
  };
  const tenants = await read(
    "/identitytoolkit.googleapis.com/v2/projects/demo-corewaste/tenants",
  );
  if (tenants.tenants?.length)
    throw Error("This single-company kit does not export identity tenants");
  const accounts = await read(
    "/identitytoolkit.googleapis.com/v1/projects/demo-corewaste/accounts:batchGet?maxResults=-1",
  );
  const config = await read("/emulator/v1/projects/demo-corewaste/config");
  if (
    !Array.isArray(accounts.users) ||
    typeof config !== "object" ||
    config === null
  )
    throw Error("Local identity export is incomplete");
  const root = "/home/node/auth-state/current",
    generation = "auth_export_" + randomUUID();
  await fs.mkdir(root + "/" + generation, { recursive: true, mode: 0o700 });
  await fs.writeFile(
    root + "/" + generation + "/accounts.json",
    JSON.stringify(accounts),
    { mode: 0o600 },
  );
  await fs.writeFile(
    root + "/" + generation + "/config.json",
    JSON.stringify(config),
    { mode: 0o600 },
  );
  const metadata = {
    version: "15.35.0",
    auth: { version: "15.35.0", path: generation },
  };
  const temporary = root + "/.metadata-" + randomUUID();
  await fs.writeFile(temporary, JSON.stringify(metadata), { mode: 0o600 });
  await fs.rename(temporary, root + "/firebase-export-metadata.json");
  console.log("Local test identity checkpoint saved.");
}
main().catch(() => {
  console.error(
    "Local identity checkpoint failed. Services must stay running until this is resolved.",
  );
  process.exitCode = 1;
});
