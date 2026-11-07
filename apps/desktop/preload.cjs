const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('corewasteConnection', {
  read: () => ipcRenderer.invoke('corewaste:connection'),
  connect: (url) => ipcRenderer.invoke('corewaste:connect', url),
});
