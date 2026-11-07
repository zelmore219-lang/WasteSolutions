const fs = require("node:fs/promises");
const { createReadStream } = require("node:fs");
const { createHash, randomBytes } = require("node:crypto");
const path = require("node:path");
const { spawn } = require("node:child_process");
const net = require("node:net");
const VERSION = "0.2.0",
  LOCAL_URL = "http://127.0.0.1:8088/office";
const imageNames = ["api", "auth", "web", "postgres"].map(
  (name) => "corewaste/local-" + name + ":" + VERSION,
);
async function hashFile(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
function childEnvironment() {
  const env = { ...process.env };
  for (const key of [
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
    "DOCKER_TLS",
    "DOCKER_TLS_VERIFY",
    "DOCKER_CERT_PATH",
  ])
    delete env[key];
  return env;
}
function runProcess(args, { cwd, log, timeout = 600000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.platform === "win32" ? "docker.exe" : "docker",
      args,
      {
        cwd,
        env: childEnvironment(),
        windowsHide: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "",
      done = false;
    const timer = setTimeout(() => {
      child.kill();
      finish(
        new Error(
          "Docker operation timed out. Check Docker Desktop and the local startup log.",
        ),
      );
    }, timeout);
    function finish(error) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(output);
    }
    const record = (chunk) => {
      const text = chunk.toString();
      output = (output + text).slice(-1048576);
      if (log) require("node:fs").appendFileSync(log, text, { mode: 0o600 });
    };
    child.stdout.on("data", record);
    child.stderr.on("data", record);
    child.on("error", () =>
      finish(
        new Error(
          "Docker Desktop could not be started. Install Docker Desktop, select Linux containers, and leave it running.",
        ),
      ),
    );
    child.on("exit", (code) =>
      finish(
        code === 0
          ? null
          : new Error(
              "Docker operation failed. Check Docker Desktop and the private local startup log.",
            ),
      ),
    );
  });
}
async function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const finish = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(500, () => finish(false));
  });
}
class LocalTestController {
  constructor({ kitDir, run = runProcess, portCheck = portOpen } = {}) {
    this.directory = path.resolve(kitDir);
    this.run = run;
    this.portOpen = portCheck;
    this.status = {
      phase: "stopped",
      message:
        "Start the local test system to begin. Docker Desktop with Linux containers is required.",
    };
    this.operation = null;
    this.endpoint = null;
  }
  set(phase, message) {
    this.status = { phase, message };
  }
  async docker(args) {
    return this.run(["--host", this.endpoint, ...args], {
      cwd: this.directory,
      log: path.join(this.directory, ".state", "startup.log"),
    });
  }
  compose(...args) {
    return this.docker([
      "compose",
      "--project-name",
      this.projectName,
      "--env-file",
      ".state/database.env",
      "--file",
      "compose.yaml",
      ...args,
    ]);
  }
  async engine() {
    const candidates =
      process.platform === "win32"
        ? [
            "npipe:////./pipe/dockerDesktopLinuxEngine",
            "npipe:////./pipe/docker_engine",
          ]
        : ["unix:///var/run/docker.sock"];
    for (const endpoint of candidates) {
      try {
        const output = await this.run(
          ["--host", endpoint, "version", "--format", "{{.Server.Os}}"],
          { cwd: this.directory, timeout: 15000 },
        );
        if (output.trim() === "linux") {
          this.endpoint = endpoint;
          return;
        }
      } catch {}
    }
    throw Error(
      "Docker Desktop is unavailable. Start Docker Desktop in Linux-container mode, then try again. Remote Docker engines are not supported.",
    );
  }
  async verify() {
    const manifest = JSON.parse(
      await fs.readFile(path.join(this.directory, "manifest.json"), "utf8"),
    );
    if (
      manifest.version !== VERSION ||
      manifest.mode !== "local-test" ||
      !Array.isArray(manifest.files) ||
      !manifest.images
    )
      throw Error(
        "Local testing files are incomplete or for another version. Extract the full download again.",
      );
    const names = new Set();
    for (const entry of manifest.files) {
      if (
        typeof entry.path !== "string" ||
        !entry.path ||
        entry.path.includes("\\") ||
        entry.path.split("/").some((p) => p === ".." || p === "." || !p) ||
        !/^[a-f0-9]{64}$/.test(entry.sha256)
      )
        throw Error("Invalid local test file manifest");
      const file = path.resolve(this.directory, entry.path);
      if (!file.startsWith(this.directory + path.sep) || names.has(entry.path))
        throw Error("Invalid local test file manifest");
      names.add(entry.path);
      const info = await fs.lstat(file);
      if (
        !info.isFile() ||
        info.size !== entry.bytes ||
        (await hashFile(file)) !== entry.sha256
      )
        throw Error(
          "Local testing files are incomplete or damaged. Extract the full download again.",
        );
    }
    for (const name of [
      "compose.yaml",
      "bootstrap.cjs",
      "checkpoint.cjs",
      "images.tar.gz",
    ])
      if (!names.has(name)) throw Error("Local testing files are incomplete");
    for (const name of imageNames)
      if (!/^sha256:[a-f0-9]{64}$/.test(manifest.images[name] || ""))
        throw Error("Local image manifest is incomplete");
    return manifest;
  }
  async prepareState() {
    const state = path.join(this.directory, ".state");
    await fs.mkdir(state, { recursive: true, mode: 0o700 });
    const file = path.join(state, "database.env");
    try {
      const value = await fs.readFile(file, "utf8");
      if (!/^COREWASTE_LOCAL_DB_PASSWORD=[a-f0-9]{64}\r?\n?$/.test(value))
        throw Error(
          "Invalid saved local database settings. Restore the original .state folder; no data was reset.",
        );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await fs.writeFile(
        file,
        "COREWASTE_LOCAL_DB_PASSWORD=" + randomBytes(32).toString("hex") + "\n",
        { mode: 0o600, flag: "wx" },
      );
    }
    this.projectName =
      "corewaste-local-test-" +
      createHash("sha256")
        .update(await fs.readFile(file))
        .digest("hex")
        .slice(0, 12);
  }
  async ready() {
    try {
      const info = await (
        await fetch("http://127.0.0.1:8088/test-kit-info", {
          signal: AbortSignal.timeout(1500),
        })
      ).json();
      if (
        info.mode !== "local-test" ||
        info.project_id !== "demo-corewaste" ||
        info.version !== VERSION
      )
        return false;
      const health = await fetch("http://127.0.0.1:8088/api/health", {
        signal: AbortSignal.timeout(1500),
      });
      return health.ok;
    } catch {
      return false;
    }
  }
  async start() {
    if (this.operation) return this.operation;
    this.operation = (async () => {
      try {
        this.set("checking", "Checking local test files and Docker Desktop…");
        await this.prepareState();
        await this.engine();
        const running = (
          await this.compose("ps", "--status", "running", "--services")
        ).split(/\s+/);
        for (const [port, service] of [
          [9099, "auth"],
          [8080, "auth"],
          [8088, "web"],
        ])
          if ((await this.portOpen(port)) && !running.includes(service))
            throw Error(
              "Port " +
                port +
                " is already used by another application. Close that application before starting this kit; it has not been stopped.",
            );
        this.set("verifying", "Verifying the local testing download…");
        const manifest = await this.verify();
        let importRequired = false;
        for (const name of imageNames) {
          try {
            if (
              (
                await this.docker([
                  "image",
                  "inspect",
                  name,
                  "--format",
                  "{{.Id}}",
                ])
              ).trim() !== manifest.images[name]
            )
              importRequired = true;
          } catch {
            importRequired = true;
          }
        }
        if (importRequired) {
          this.set(
            "importing",
            "Importing bundled test services. First startup can take several minutes…",
          );
          await this.docker(["image", "load", "--input", "images.tar.gz"]);
        }
        for (const name of imageNames)
          if (
            (
              await this.docker([
                "image",
                "inspect",
                name,
                "--format",
                "{{.Id}}",
              ])
            ).trim() !== manifest.images[name]
          )
            throw Error(
              "A bundled test image failed its identity check. Extract the download again.",
            );
        this.set(
          "starting",
          "Starting the database, local test identity service and CoreWaste…",
        );
        await this.compose(
          "up",
          "--detach",
          "--wait",
          "--wait-timeout",
          "240",
          "--pull",
          "never",
        );
        if (!(await this.ready()))
          throw Error(
            "The local test app did not become healthy. Check the private startup log and Docker Desktop.",
          );
        this.set(
          "ready",
          "Local test system is ready. Show the test sign-ins, then open CoreWaste.",
        );
      } catch (error) {
        this.set(
          "error",
          error.code === "ENOENT"
            ? "Local testing files are missing. Extract the full download, including its local-test folder."
            : error.message,
        );
      } finally {
        this.operation = null;
      }
      return this.status;
    })();
    return this.operation;
  }
  async checkpointIdentity() {
    const id = (
      await this.compose("ps", "--status", "running", "--quiet", "auth")
    ).trim();
    if (!id) return;
    if (!/^[a-f0-9]{12,64}$/.test(id))
      throw Error("Unexpected local test identity container");
    // Run the fixed, manifest-verified loopback snapshot helper in our own container.
    // No proxy settings, TLS checks, arbitrary URLs or caller-provided commands are changed.
    await this.docker(["exec", id, "node", "/home/node/auth/checkpoint.cjs"]);
  }
  async stop() {
    if (this.operation)
      throw Error(
        "Wait for the current local test operation to finish before stopping.",
      );
    this.operation = (async () => {
      try {
        await this.prepareState();
        await this.engine();
        this.set(
          "stopping",
          "Saving test sign-ins and stopping local services…",
        );
        await this.checkpointIdentity();
        await this.compose("stop");
        this.set(
          "stopped",
          "Local services stopped. Test data is preserved for the next start.",
        );
      } catch (error) {
        this.set("error", error.message);
      } finally {
        this.operation = null;
      }
      return this.status;
    })();
    return this.operation;
  }

  async logins() {
    const value = JSON.parse(
      await fs.readFile(
        path.join(this.directory, ".state", "logins.json"),
        "utf8",
      ),
    );
    if (!Array.isArray(value.accounts))
      throw Error("Local sign-ins are not ready. Start the test system first.");
    return value.accounts.map(({ role, email, password, phone }) => ({
      role,
      email,
      password,
      phone,
    }));
  }
  async codes() {
    if (this.status.phase !== "ready")
      throw Error("Start the local test kit before requesting sign-in codes.");
    const response = await fetch(
      "http://127.0.0.1:9099/emulator/v1/projects/demo-corewaste/verificationCodes",
      { signal: AbortSignal.timeout(2000) },
    );
    if (!response.ok)
      throw Error(
        "Local sign-in codes are unavailable. Start the kit and request a code first.",
      );
    const value = await response.json();
    return (value.verificationCodes || [])
      .filter((c) => c.phoneNumber === "+16505550123")
      .map((c) => ({ phone: c.phoneNumber, code: c.code }));
  }
}
module.exports = {
  LocalTestController,
  LOCAL_URL,
  VERSION,
  hashFile,
  childEnvironment,
};
