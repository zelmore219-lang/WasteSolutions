const fs = require("node:fs/promises");
const path = require("node:path");
const { LocalTestController } = require("../apps/desktop/local-test.cjs");
(async () => {
  const directory = path.resolve(".local/kit-validation/local-test");
  await fs.access(path.join(directory, ".verification-only"));
  const controller = new LocalTestController({ kitDir: directory });
  await controller.prepareState();
  await controller.engine();
  if (!/^corewaste-local-test-[a-f0-9]{12}$/.test(controller.projectName))
    throw Error("Unexpected disposable test project name");
  if (process.argv.includes("--remove-disposable-volumes")) {
    await controller.compose("down", "--volumes", "--remove-orphans");
    console.log(
      "Removed only the disposable verification project and its local test volumes.",
    );
  } else {
    const status = await controller.stop();
    console.log(status.phase);
    if (status.phase !== "stopped") process.exitCode = 1;
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
