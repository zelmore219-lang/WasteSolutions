const { test } = require("node:test");
const assert = require("node:assert/strict");
const { HOSTED_URL, verifyFirebaseHost } = require("../hosted.cjs");
test("Firebase client rejects Hosting placeholder pages and unhealthy API/database", async () => {
  assert.equal(HOSTED_URL, "https://wastesoloutions.web.app/office");
  const response = (body, status = 200, type = "application/json") =>
    new Response(body, { status, headers: { "content-type": type } });
  await assert.rejects(
    verifyFirebaseHost(HOSTED_URL, async () =>
      response("<html>Welcome to Firebase</html>", 200, "text/html"),
    ),
    /not connected/,
  );
  await assert.rejects(
    verifyFirebaseHost(HOSTED_URL, async () => response("{}", 503)),
    /not connected/,
  );
  await assert.rejects(
    verifyFirebaseHost(HOSTED_URL, async () =>
      response('{"status":"starting"}'),
    ),
    /not ready/,
  );
  await verifyFirebaseHost(HOSTED_URL, async (url, options) => {
    assert.equal(url.href, "https://wastesoloutions.web.app/api/health");
    assert.equal(options.redirect, "error");
    assert.equal(options.cache, "no-store");
    assert.ok(options.signal);
    return response('{"status":"ok","service":"CoreWaste API"}');
  });
  await assert.rejects(
    verifyFirebaseHost(HOSTED_URL, async () => {
      throw Error("network unavailable");
    }),
    /network unavailable/,
  );
});
test("Firebase host preparation keeps API rewrites ahead of SPA and excludes emulator builds", () => {
  const config = require("../../../firebase.hosting.json");
  const profile = require("../../../config/firebase-client.json");
  assert.equal(profile.projectId, "wastesoloutions");
  assert.equal(config.hosting.rewrites[0].source, "/api");
  assert.equal(config.hosting.rewrites[1].source, "/api/**");
  assert.equal(config.hosting.rewrites[1].run.serviceId, "corewaste-api");
  assert.equal(config.hosting.rewrites[1].run.pinTag, true);
  assert.equal(config.hosting.rewrites.at(-1).destination, "/index.html");
});
