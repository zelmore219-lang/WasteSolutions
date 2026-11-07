const PROJECT_ID = "wastesoloutions";
const HOSTED_URL = `https://${PROJECT_ID}.web.app/office`;
async function verifyFirebaseHost(url, fetcher = fetch) {
  if (new URL(url).origin !== new URL(HOSTED_URL).origin) return;
  const response = await fetcher(new URL("/api/health", url), {
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
  });
  if (
    !response.ok ||
    !(response.headers.get("content-type") || "").includes("application/json")
  )
    throw Error(
      "Firebase hosting is not connected to the CoreWaste API yet. Cloud activation is still required.",
    );
  const body = await response.json();
  if (body.status !== "ok" || body.service !== "CoreWaste API")
    throw Error(
      "The hosted CoreWaste database is not ready. Please retry after cloud setup is complete.",
    );
}
module.exports = { PROJECT_ID, HOSTED_URL, verifyFirebaseHost };
