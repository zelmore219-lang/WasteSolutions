const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const {
  LocalTestController,
  hashFile,
  VERSION,
  childEnvironment,
} = require("../local-test.cjs");
const { validateTarget } = require("../connection.cjs");
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "corewaste-kit-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const files = [];
  for (const name of [
    "compose.yaml",
    "bootstrap.cjs",
    "checkpoint.cjs",
    "images.tar.gz",
  ]) {
    const file = path.join(root, name);
    await fs.writeFile(file, "verified fixture " + name);
    files.push({
      path: name,
      bytes: (await fs.stat(file)).size,
      sha256: await hashFile(file),
    });
  }
  const images = Object.fromEntries(
    ["api", "auth", "web", "postgres"].map((name, i) => [
      "corewaste/local-" + name + ":" + VERSION,
      "sha256:" + String(i + 1).repeat(64),
    ]),
  );
  await fs.writeFile(
    path.join(root, "manifest.json"),
    JSON.stringify({ version: VERSION, mode: "local-test", files, images }),
  );
  return { root, images };
}
test("packaged local mode permits only the fixed loopback test address; hosted mode continues to require HTTPS", () => {
  assert.equal(
    validateTarget("http://127.0.0.1:8088/office", false, true),
    "http://127.0.0.1:8088/office",
  );
  for (const url of [
    "http://localhost:8088/office",
    "http://127.0.0.1:8089/office",
    "http://127.0.0.1:8088/other",
    "http://evil.example:8088/office",
    "http://127.0.0.1.evil.example:8088/office",
  ])
    assert.throws(() => validateTarget(url, false, true));
  assert.throws(() =>
    validateTarget("http://127.0.0.1:8088/office", false, false),
  );
});
test("bundle verification rejects corruption and path traversal before importing images", async (t) => {
  const { root } = await fixture(t),
    controller = new LocalTestController({ kitDir: root });
  await controller.verify();
  await fs.appendFile(path.join(root, "compose.yaml"), "tampered");
  await assert.rejects(controller.verify(), /damaged/);
  const manifest = JSON.parse(
    await fs.readFile(path.join(root, "manifest.json"), "utf8"),
  );
  manifest.files[0].path = "../private";
  await fs.writeFile(
    path.join(root, "manifest.json"),
    JSON.stringify(manifest),
  );
  await assert.rejects(controller.verify(), /manifest/);
});
test("test database settings persist, isolate the Compose project and never reset invalid saved settings", async (t) => {
  const { root } = await fixture(t),
    first = new LocalTestController({ kitDir: root });
  await first.prepareState();
  const file = path.join(root, ".state", "database.env"),
    saved = await fs.readFile(file, "utf8");
  assert.match(saved, /^COREWASTE_LOCAL_DB_PASSWORD=[a-f0-9]{64}\n$/);
  const next = new LocalTestController({ kitDir: root });
  await next.prepareState();
  assert.equal(await fs.readFile(file, "utf8"), saved);
  assert.equal(first.projectName, next.projectName);
  assert.match(first.projectName, /^corewaste-local-test-[a-f0-9]{12}$/);
  await fs.writeFile(file, "invalid");
  await assert.rejects(next.prepareState(), /Invalid saved/);
  assert.equal(await fs.readFile(file, "utf8"), "invalid");
});
test("concurrent starts import once, use only a local Docker endpoint and stop preserves volumes", async (t) => {
  const { root, images } = await fixture(t),
    calls = [];
  let loaded = false;
  const run = async (args) => {
    calls.push(args);
    assert.equal(args[0], "--host");
    assert.match(
      args[1],
      /^(unix:\/\/\/var\/run\/docker.sock|npipe:\/\/\/\/\.\/pipe\/docker(?:DesktopLinuxEngine|_engine))$/,
    );
    if (args.includes("version")) return "linux\n";
    if (args.includes("ps")) return "";
    if (args.includes("inspect")) {
      if (!loaded) throw Error("not loaded");
      return images[args[4]] + "\n";
    }
    if (args.includes("load")) loaded = true;
    return "";
  };
  const controller = new LocalTestController({
    kitDir: root,
    run,
    portCheck: async () => false,
  });
  controller.ready = async () => true;
  await Promise.all([controller.start(), controller.start()]);
  assert.equal(controller.status.phase, "ready");
  assert.equal(calls.filter((a) => a.includes("load")).length, 1);
  assert.equal(calls.filter((a) => a.includes("up")).length, 1);
  await controller.stop();
  assert.equal(controller.status.phase, "stopped");
  assert.ok(calls.some((a) => a.includes("stop")));
  assert.ok(!calls.some((a) => a.includes("down") || a.includes("--volumes")));
});
test("Docker connection selectors are removed from the child only; user registry configuration stays intact", () => {
  const before = { ...process.env };
  try {
    process.env.DOCKER_HOST = "tcp://remote.invalid:2376";
    process.env.DOCKER_CONTEXT = "remote";
    process.env.DOCKER_TLS_VERIFY = "1";
    process.env.DOCKER_CONFIG = "/user/registry-settings";
    const child = childEnvironment();
    assert.equal(child.DOCKER_HOST, undefined);
    assert.equal(child.DOCKER_CONTEXT, undefined);
    assert.equal(child.DOCKER_TLS_VERIFY, undefined);
    assert.equal(child.DOCKER_CONFIG, "/user/registry-settings");
    assert.equal(process.env.DOCKER_HOST, "tcp://remote.invalid:2376");
  } finally {
    for (const key of [
      "DOCKER_HOST",
      "DOCKER_CONTEXT",
      "DOCKER_TLS_VERIFY",
      "DOCKER_CONFIG",
    ])
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
  }
});

test("failed identity checkpoint prevents shutdown instead of silently losing sign-ins", async (t) => {
  const { root } = await fixture(t),
    calls = [];
  const run = async (args) => {
    calls.push(args);
    if (args.includes("version")) return "linux";
    if (args.includes("ps")) return "a".repeat(64);
    if (args.includes("exec")) throw Error("Identity checkpoint failed");
    return "";
  };
  const c = new LocalTestController({ kitDir: root, run });
  const result = await c.stop();
  assert.equal(result.phase, "error");
  assert.ok(!calls.some((args) => args.includes("stop")));
});
