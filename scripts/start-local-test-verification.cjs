const fs = require("node:fs/promises");
const path = require("node:path");
const {
  LocalTestController,
  VERSION,
} = require("../apps/desktop/local-test.cjs");
(async () => {
  const source = path.resolve(
      ".local/windows-download/CoreWaste-Windows-Local-Test-" +
        VERSION +
        "-x64/local-test",
    ),
    kit = path.resolve(".local/kit-validation/local-test");
  await fs.mkdir(kit, { recursive: true });
  for (const file of [
    "compose.yaml",
    "bootstrap.cjs",
    "checkpoint.cjs",
    "manifest.json",
  ])
    await fs.copyFile(path.join(source, file), path.join(kit, file));
  try {
    await fs.link(
      path.join(source, "images.tar.gz"),
      path.join(kit, "images.tar.gz"),
    );
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const a = await fs.stat(path.join(source, "images.tar.gz")),
      b = await fs.stat(path.join(kit, "images.tar.gz"));
    if (a.ino !== b.ino || a.dev !== b.dev) {
      await fs.unlink(path.join(kit, "images.tar.gz"));
      await fs.link(
        path.join(source, "images.tar.gz"),
        path.join(kit, "images.tar.gz"),
      );
    }
  }
  await fs.writeFile(
    path.join(kit, ".verification-only"),
    "Disposable automated local test kit; not customer data.\n",
    { mode: 0o600 },
  );
  const controller = new LocalTestController({ kitDir: kit });
  const timer = setInterval(
    () => console.log("Test kit phase: " + controller.status.phase),
    5000,
  );
  try {
    const result = await controller.start();
    console.log(result.phase + ": " + result.message);
    if (result.phase !== "ready") process.exitCode = 1;
  } finally {
    clearInterval(timer);
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
