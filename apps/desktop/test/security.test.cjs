const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
test('desktop starts in setup and rejects settings IPC and cross-origin navigation from remote pages', async () => {
  const handlers = new Map();
  const events = new Map();
  const loads = [];
  let ready;
  let instance;
  let options;
  class BrowserWindow {
    constructor(value) {
      options = value; instance = this;
      this.webContents = {
        setWindowOpenHandler: fn => { this.popup = fn; },
        on: (name, fn) => events.set(name, fn),
      };
    }
    async loadFile(file, opts) { loads.push({ file, opts }); }
    async loadURL(url) { loads.push({ url }); }
  }
  const directory = path.resolve(__dirname, '..');
  const electron = {
    app: { isPackaged: true, whenReady: () => ({ then: fn => { ready = fn; } }), on: () => {}, getPath: () => '/unused', quit: () => {} },
    BrowserWindow,
    session: { defaultSession: { setPermissionRequestHandler: () => {}, setPermissionCheckHandler: () => {} } },
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    Menu: { setApplicationMenu: () => {}, buildFromTemplate: value => value },
  };
  vm.runInNewContext(fs.readFileSync(path.join(directory, 'main.cjs'), 'utf8'), {
    __dirname: directory,
    process: { env: {} },
    setTimeout: () => {},
    require: name => name === 'electron' ? electron : name === './connection.cjs'
      ? { ...require('../connection.cjs'), readTarget: () => '', saveTarget: () => {} } : require(name),
  });
  await ready();
  assert.equal(loads[0].file, path.join(directory, 'setup.html'));
  assert.equal(options.webPreferences.nodeIntegration, false);
  assert.equal(options.webPreferences.contextIsolation, true);
  assert.equal(options.webPreferences.sandbox, true);
  assert.equal(options.webPreferences.webSecurity, true);
  assert.equal(instance.popup().action, 'deny');
  const remote = { sender: instance.webContents, senderFrame: { url: 'https://evil.example' } };
  assert.throws(() => handlers.get('corewaste:connection')(remote), /only available/);
  await assert.rejects(handlers.get('corewaste:connect')(remote, 'https://evil.example'), /only available/);
  const local = { sender: instance.webContents, senderFrame: { url: pathToFileURL(path.join(directory, 'setup.html')).href + '?message=' } };
  assert.equal(handlers.get('corewaste:connection')(local).url, '');
  assert.equal((await handlers.get('corewaste:connect')(local, 'http://localhost:5173')).ok, false);
  let blocked = false;
  events.get('will-navigate')({ preventDefault: () => { blocked = true; } }, 'https://evil.example');
  assert.equal(blocked, true);
});
