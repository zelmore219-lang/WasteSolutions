const fs = require("node:fs/promises");
const { createReadStream, createWriteStream } = require("node:fs");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");
const { pipeline } = require("node:stream/promises");
const { createGzip } = require("node:zlib");
const {
  LocalTestController,
  VERSION,
  hashFile,
  childEnvironment,
} = require("../apps/desktop/local-test.cjs");
async function main() {
  const kit = path.resolve(
      ".local/windows-download/CoreWaste-Windows-Local-Test-" +
        VERSION +
        "-x64",
    ),
    localDir = path.join(kit, "local-test");
  await fs.mkdir(localDir, { recursive: true });
  // Strict copy list excludes every .env, test database, generated identity and private workspace file.
  for (const file of ["compose.yaml", "bootstrap.cjs", "checkpoint.cjs"])
    await fs.copyFile(
      path.join("distribution/local-test", file),
      path.join(localDir, file),
    );
  const controller = new LocalTestController({ kitDir: localDir });
  await controller.engine();
  const names = ["api", "auth", "web", "postgres"].map(
      (name) => "corewaste/local-" + name + ":" + VERSION,
    ),
    images = {};
  for (const name of names) {
    const output = execFileSync(
      "docker",
      [
        "--host",
        controller.endpoint,
        "image",
        "inspect",
        name,
        "--format",
        "{{.Id}}",
      ],
      { env: childEnvironment(), encoding: "utf8" },
    ).trim();
    if (!/^sha256:[a-f0-9]{64}$/.test(output))
      throw Error("Unexpected local test image identity");
    images[name] = output;
  }
  const archive = path.join(localDir, "images.tar.gz"),
    imageRecord = JSON.stringify(images);
  let reusable = false;
  try {
    const previous = JSON.parse(
      await fs.readFile(path.join(localDir, "manifest.json"), "utf8"),
    );
    const entry = previous.files.find((f) => f.path === "images.tar.gz");
    reusable =
      JSON.stringify(previous.images) === imageRecord &&
      entry &&
      (await hashFile(archive)) === entry.sha256;
  } catch {}
  if (!reusable) {
    console.log("Saving four verified local test service images…");
    const child = spawn(
      "docker",
      ["--host", controller.endpoint, "image", "save", ...names],
      { env: childEnvironment(), stdio: ["ignore", "pipe", "inherit"] },
    );
    const exited = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0 ? resolve() : reject(Error("Image archive export failed")),
      );
    });
    await Promise.all([
      pipeline(
        child.stdout,
        createGzip({ level: 1 }),
        createWriteStream(archive + ".tmp"),
      ),
      exited,
    ]);
    await fs.rename(archive + ".tmp", archive);
  }
  const files = [];
  for (const file of [
    "compose.yaml",
    "bootstrap.cjs",
    "checkpoint.cjs",
    "images.tar.gz",
  ]) {
    const target = path.join(localDir, file);
    files.push({
      path: file,
      bytes: (await fs.stat(target)).size,
      sha256: await hashFile(target),
    });
  }
  await fs.writeFile(
    path.join(localDir, "manifest.json"),
    JSON.stringify(
      { mode: "local-test", version: VERSION, images, files },
      null,
      2,
    ) + "\n",
  );
  if (!process.argv.includes("--services-only")) {
    const runtime = path.resolve(".local/windows-test/win-unpacked");
    if (!(await fs.stat(path.join(runtime, "CoreWaste.exe"))).isFile())
      throw Error("Build the Windows desktop client first");
    // Do not copy release outputs or arbitrary workspaces into the kit.
    for (const file of await fs.readdir(runtime))
      await fs.cp(path.join(runtime, file), path.join(kit, file), {
        recursive: true,
      });
    await fs.copyFile(
      "distribution/local-test/START-HERE.txt",
      path.join(kit, "START-HERE.txt"),
    );
    await fs.writeFile(
      path.join(kit, "Start-CoreWaste.cmd"),
      '@echo off\r\nstart "" "%~dp0CoreWaste.exe" --local-test\r\n',
    );
    await fs.writeFile(
      path.join(kit, "Open-Hosted-CoreWaste.cmd"),
      '@echo off\r\nstart "" "%~dp0CoreWaste.exe"\r\n',
    );
    console.log("Prepared Windows local test kit at " + kit);
  }
  console.log(
    "Service archive and manifest ready; no generated logins or database data included.",
  );
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
