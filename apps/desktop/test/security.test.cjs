const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
test("desktop starts in setup and rejects settings IPC and cross-origin navigation from remote pages", async () => {
  const handlers = new Map();
  const events = new Map();
  const loads = [];
  let ready;
  let instance;
  let options;
  class BrowserWindow {
    constructor(value) {
      options = value;
      instance = this;
      this.webContents = {
        setWindowOpenHandler: (fn) => {
          this.popup = fn;
        },
        on: (name, fn) => events.set(name, fn),
      };
    }
    async loadFile(file, opts) {
      loads.push({ file, opts });
    }
    async loadURL(url) {
      loads.push({ url });
    }
  }
  const directory = path.resolve(__dirname, "..");
  const electron = {
    app: {
      isPackaged: true,
      whenReady: () => ({
        then: (fn) => {
          ready = fn;
        },
      }),
      on: () => {},
      getPath: () => "/unused",
      quit: () => {},
    },
    BrowserWindow,
    session: {
      defaultSession: {
        setPermissionRequestHandler: () => {},
        setPermissionCheckHandler: () => {},
      },
    },
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    Menu: { setApplicationMenu: () => {}, buildFromTemplate: (value) => value },
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(directory, "main.cjs"), "utf8"),
    {
      __dirname: directory,
      process: { env: {} },
      setTimeout: () => {},
      require: (name) =>
        name === "electron"
          ? electron
          : name === "./hosted.cjs"
            ? require("../hosted.cjs")
            : name === "./local-test.cjs"
              ? require("../local-test.cjs")
              : name === "./connection.cjs"
                ? {
                    ...require("../connection.cjs"),
                    readTarget: () => "",
                    saveTarget: () => {},
                  }
                : require(name),
    },
  );
  await ready();
  assert.equal(loads[0].file, path.join(directory, "setup.html"));
  assert.equal(options.webPreferences.nodeIntegration, false);
  assert.equal(options.webPreferences.contextIsolation, true);
  assert.equal(options.webPreferences.sandbox, true);
  assert.equal(options.webPreferences.webSecurity, true);
  assert.equal(instance.popup().action, "deny");
  const remote = {
    sender: instance.webContents,
    senderFrame: { url: "https://evil.example" },
  };
  assert.throws(
    () => handlers.get("corewaste:connection")(remote),
    /only available/,
  );
  await assert.rejects(
    handlers.get("corewaste:connect")(remote, "https://evil.example"),
    /only available/,
  );
  const local = {
    sender: instance.webContents,
    senderFrame: {
      url: pathToFileURL(path.join(directory, "setup.html")).href + "?message=",
    },
  };
  assert.equal(
    handlers.get("corewaste:connection")(local).url,
    "https://wastesoloutions.web.app/office",
  );
  assert.equal(
    (await handlers.get("corewaste:connect")(local, "http://localhost:5173"))
      .ok,
    false,
  );
  let blocked = false;
  events.get("will-navigate")(
    {
      preventDefault: () => {
        blocked = true;
      },
    },
    "https://evil.example",
  );
  assert.equal(blocked, true);
});

test("local testing IPC is confined to its controls frame and the office window has no privileged preload", async () => {
  const handlers = new Map(),
    windows = [];
  let ready,
    starts = 0,
    secretReads = 0;
  class BrowserWindow {
    constructor(options) {
      this.options = options;
      this.webContents = { setWindowOpenHandler: () => {}, on: () => {} };
      windows.push(this);
    }
    on() {}
    async loadFile() {}
    async loadURL(url) {
      this.url = url;
    }
    isDestroyed() {
      return false;
    }
    focus() {}
    close() {}
  }
  class LocalTestController {
    constructor() {
      this.status = { phase: "stopped" };
    }
    start() {
      starts++;
      this.status.phase = "ready";
    }
    async ready() {
      return true;
    }
    async logins() {
      secretReads++;
      return [
        {
          role: "owner",
          email: "owner@example.test",
          password: "local-fixture-only",
        },
      ];
    }
    async codes() {
      secretReads++;
      return [{ phone: "+16505550123", code: "123456" }];
    }
  }
  const electron = {
    app: {
      isPackaged: true,
      whenReady: () => ({
        then: (fn) => {
          ready = fn;
        },
      }),
      on: () => {},
      getPath: () => "/unused",
      quit: () => {},
    },
    BrowserWindow,
    session: {
      defaultSession: {
        setPermissionRequestHandler: () => {},
        setPermissionCheckHandler: () => {},
      },
    },
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    Menu: { setApplicationMenu: () => {}, buildFromTemplate: (v) => v },
  };
  const directory = path.resolve(__dirname, "..");
  vm.runInNewContext(
    fs.readFileSync(path.join(directory, "main.cjs"), "utf8"),
    {
      __dirname: directory,
      process: {
        argv: ["electron", "--local-test"],
        execPath: "/fixture/CoreWaste.exe",
        env: {},
      },
      setTimeout: () => {},
      require: (name) =>
        name === "electron"
          ? electron
          : name === "./hosted.cjs"
            ? require("../hosted.cjs")
            : name === "./local-test.cjs"
              ? {
                  LocalTestController,
                  LOCAL_URL: "http://127.0.0.1:8088/office",
                }
              : name === "./connection.cjs"
                ? { ...require("../connection.cjs"), readTarget: () => "" }
                : require(name),
    },
  );
  await ready();
  const file = pathToFileURL(path.join(directory, "setup.html")).href;
  const trusted = {
    sender: windows[0].webContents,
    senderFrame: { url: file },
  };
  const remote = {
    sender: windows[0].webContents,
    senderFrame: { url: "https://remote.example/office" },
  };
  for (const name of [
    "corewaste:local-start",
    "corewaste:local-stop",
    "corewaste:local-logins",
    "corewaste:local-codes",
  ])
    await assert.rejects(
      Promise.resolve().then(() => handlers.get(name)(remote)),
      /only available/,
    );
  assert.equal(starts, 0);
  assert.equal(secretReads, 0);
  await handlers.get("corewaste:local-start")(trusted);
  assert.equal(starts, 1);
  const open = await handlers.get("corewaste:connect")(
    trusted,
    "http://127.0.0.1:8088/office",
  );
  assert.equal(open.ok, true);
  assert.equal(windows.length, 2);
  assert.equal(windows[1].options.webPreferences.preload, undefined);
  assert.equal(windows[1].options.webPreferences.sandbox, true);
  const office = {
    sender: windows[1].webContents,
    senderFrame: { url: "http://127.0.0.1:8088/office" },
  };
  await assert.rejects(
    handlers.get("corewaste:local-logins")(office),
    /only available/,
  );
  assert.equal(secretReads, 0);
  assert.equal(
    (await handlers.get("corewaste:local-codes")(trusted))[0].code,
    "123456",
  );
  assert.equal(secretReads, 1);
});
