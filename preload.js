const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('quanah', {
  scan: () => ipcRenderer.invoke('scan'),
  setAuto: on => ipcRenderer.send('set-auto', on),
  resize: h => ipcRenderer.send('overlay-resize', h),
  showHud: (w, h) => ipcRenderer.send('hud-show', w, h),
  hideHud: () => ipcRenderer.send('hud-hide'),
  hideOverlay: () => ipcRenderer.send('overlay-hide'),
  showOverlay: () => ipcRenderer.send('overlay-show'),
  showMain: () => ipcRenderer.send('main-show'),
  notifySync: () => ipcRenderer.send('sync-state'),
  onSync: cb => ipcRenderer.on('sync-state', () => cb()),
  onScan: cb => ipcRenderer.on('scan-result', (_e, msg) => cb(msg))
});
