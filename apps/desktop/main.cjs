const { app, BrowserWindow, session, ipcMain, Menu } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { validateTarget, readTarget, saveTarget } = require("./connection.cjs");
const { LocalTestController, LOCAL_URL } = require("./local-test.cjs");
const setupFile = path.join(__dirname, "setup.html"),
  setupUrl = pathToFileURL(setupFile).href;
const localTest = (process.argv || []).includes("--local-test");
const development = !app.isPackaged && process.env.NODE_ENV === "development";
const kitDir = localTest
  ? path.join(
      process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath),
      "local-test",
    )
  : null;
const local = localTest ? new LocalTestController({ kitDir }) : null;
let window, officeWindow, allowedOrigin;
function setupAuthority(event) {
  if (
    event.sender !== window.webContents ||
    event.senderFrame?.url.split("?")[0] !== setupUrl
  )
    throw Error("Connection settings are only available on the setup screen.");
}
function localAuthority(event) {
  setupAuthority(event);
  if (!localTest) throw Error("Local testing controls are not enabled.");
}
function guard(contents, origin) {
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  const check = (event, next) => {
    try {
      if (!origin() || new URL(next).origin !== origin())
        event.preventDefault();
    } catch {
      event.preventDefault();
    }
  };
  contents.on("will-navigate", check);
  contents.on("will-redirect", check);
}
async function showSetup(message = "") {
  allowedOrigin = undefined;
  await window.loadFile(setupFile, { query: { message } });
}
async function connect(target) {
  const url = validateTarget(target, development, localTest);
  if (localTest) {
    if (url !== LOCAL_URL)
      throw Error(
        "The local test client connects only to its bundled app address.",
      );
    if (local.status.phase !== "ready" || !(await local.ready()))
      throw Error(
        "Start the local test system and wait for Ready before opening the app.",
      );
    if (officeWindow && !officeWindow.isDestroyed()) {
      officeWindow.focus();
      return;
    }
    officeWindow = new BrowserWindow({
      width: 1440,
      height: 960,
      minWidth: 900,
      minHeight: 650,
      title: "CoreWaste — Local Test",
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
      },
    });
    guard(officeWindow.webContents, () => new URL(LOCAL_URL).origin);
    await officeWindow.loadURL(LOCAL_URL);
    return;
  }
  allowedOrigin = new URL(url).origin;
  try {
    await window.loadURL(url);
  } catch {
    await showSetup(
      "Could not connect. Check the address, internet connection, and whether your CoreWaste server is running.",
    );
  }
}
app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler(
    (_contents, _permission, callback) => callback(false),
  );
  session.defaultSession.setPermissionCheckHandler(() => false);
  window = new BrowserWindow({
    width: localTest ? 1050 : 1440,
    height: 960,
    minWidth: 900,
    minHeight: 650,
    title: localTest
      ? "CoreWaste Local Test Controls"
      : "CoreWaste Test Client",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });
  guard(window.webContents, () => allowedOrigin);
  if (localTest)
    window.on("closed", () => {
      if (officeWindow && !officeWindow.isDestroyed()) officeWindow.close();
    });
  ipcMain.handle("corewaste:connection", (event) => {
    setupAuthority(event);
    return {
      url: localTest ? LOCAL_URL : readTarget(app.getPath("userData")),
      local_test: localTest,
    };
  });
  ipcMain.handle("corewaste:connect", async (event, target) => {
    setupAuthority(event);
    try {
      const url = validateTarget(target, development, localTest);
      if (localTest) await connect(url);
      else {
        saveTarget(app.getPath("userData"), url);
        setTimeout(() => void connect(url).catch(() => {}), 50);
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, message: error.message };
    }
  });
  ipcMain.handle("corewaste:local-status", (event) => {
    localAuthority(event);
    return local.status;
  });
  ipcMain.handle("corewaste:local-start", async (event) => {
    localAuthority(event);
    void local.start();
    return local.status;
  });
  ipcMain.handle("corewaste:local-stop", async (event) => {
    localAuthority(event);
    return local.stop();
  });
  ipcMain.handle("corewaste:local-logins", async (event) => {
    localAuthority(event);
    return local.logins();
  });
  ipcMain.handle("corewaste:local-codes", async (event) => {
    localAuthority(event);
    return local.codes();
  });
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "Connection",
        submenu: [
          {
            label: localTest ? "Show local test controls" : "Change server…",
            click: () => (localTest ? window.focus() : showSetup()),
          },
          { role: "quit" },
        ],
      },
      {
        label: "View",
        submenu: [
          { role: "reload" },
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { role: "togglefullscreen" },
        ],
      },
      {
        label: "Edit",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "selectAll" },
        ],
      },
    ]),
  );
  const target =
    process.env.COREWASTE_WEB_URL || readTarget(app.getPath("userData"));
  if (localTest || !target) await showSetup();
  else {
    try {
      await connect(target);
    } catch (error) {
      await showSetup(error.message);
    }
  }
});
app.on("window-all-closed", () => app.quit());
