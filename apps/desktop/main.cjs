const { app, BrowserWindow, session, ipcMain, Menu } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { validateTarget, readTarget, saveTarget } = require('./connection.cjs');
const setupFile = path.join(__dirname, 'setup.html');
const setupUrl = pathToFileURL(setupFile).href;
let window;
let allowedOrigin;
const development = !app.isPackaged && process.env.NODE_ENV === 'development';
async function showSetup(message = '') {
  allowedOrigin = undefined;
  await window.loadFile(setupFile, { query: { message } });
}
async function connect(target) {
  const url = validateTarget(target, development);
  allowedOrigin = new URL(url).origin;
  try { await window.loadURL(url); }
  catch { await showSetup('Could not connect. Check the address, internet connection, and whether your CoreWaste server is running.'); }
}
app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  window = new BrowserWindow({
    width: 1440, height: 960, minWidth: 900, minHeight: 650, title: 'CoreWaste Test Client',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const guard = (event, next) => {
    try { if (!allowedOrigin || new URL(next).origin !== allowedOrigin) event.preventDefault(); }
    catch { event.preventDefault(); }
  };
  window.webContents.on('will-navigate', guard);
  window.webContents.on('will-redirect', guard);
  ipcMain.handle('corewaste:connection', (event) => {
    if (event.sender !== window.webContents || event.senderFrame?.url.split('?')[0] !== setupUrl) throw new Error('Connection settings are only available on the setup screen.');
    return { url: readTarget(app.getPath('userData')) };
  });
  ipcMain.handle('corewaste:connect', async (event, target) => {
    if (event.sender !== window.webContents || event.senderFrame?.url.split('?')[0] !== setupUrl) throw new Error('Connection settings are only available on the setup screen.');
    try {
      const url = validateTarget(target, development);
      saveTarget(app.getPath('userData'), url);
      // Wait until the IPC response is delivered before navigating away from setup.
      setTimeout(() => connect(url), 50);
      return { ok: true };
    } catch (error) { return { ok: false, message: error.message }; }
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Connection', submenu: [{ label: 'Change server…', click: () => showSetup() }, { role: 'quit' }] },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
  ]));
  const target = process.env.COREWASTE_WEB_URL || readTarget(app.getPath('userData'));
  if (target) { try { await connect(target); } catch (error) { await showSetup(error.message); } }
  else await showSetup();
});
app.on('window-all-closed', () => app.quit());
