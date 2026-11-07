const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("corewasteConnection", {
  read: () => ipcRenderer.invoke("corewaste:connection"),
  connect: (url) => ipcRenderer.invoke("corewaste:connect", url),
  localStatus: () => ipcRenderer.invoke("corewaste:local-status"),
  localStart: () => ipcRenderer.invoke("corewaste:local-start"),
  localStop: () => ipcRenderer.invoke("corewaste:local-stop"),
  localLogins: () => ipcRenderer.invoke("corewaste:local-logins"),
  localCodes: () => ipcRenderer.invoke("corewaste:local-codes"),
});
