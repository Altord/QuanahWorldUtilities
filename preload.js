const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('quanah', {
  scan: () => ipcRenderer.invoke('scan'),
  setAuto: on => ipcRenderer.send('set-auto', on),
  resize: h => ipcRenderer.send('overlay-resize', h),
  showHud: (w, h) => ipcRenderer.send('hud-show', w, h),
  hideHud: () => ipcRenderer.send('hud-hide'),
  hideOverlay: () => ipcRenderer.send('overlay-hide'),
  showOverlay: () => ipcRenderer.send('overlay-show'),
  isOverlayOpen: () => ipcRenderer.invoke('overlay-visible'),
  onOverlayState: cb => ipcRenderer.on('overlay-state', (_e, open) => cb(open)),
  showMain: () => ipcRenderer.send('main-show'),
  notifySync: () => ipcRenderer.send('sync-state'),
  onSync: cb => ipcRenderer.on('sync-state', () => cb()),
  onQuickAdd: cb => ipcRenderer.on('quick-add', () => cb()),
  onScan: cb => ipcRenderer.on('scan-result', (_e, msg) => cb(msg)),
  openDungeonOverlay: () => ipcRenderer.send('dng-overlay-show'),
  hideDungeonOverlay: () => ipcRenderer.send('dng-overlay-hide'),
  resizeDungeonOverlay: h => ipcRenderer.send('dng-overlay-resize', h),
  scanDungeon: () => ipcRenderer.invoke('dng-scan'),
  onDungeonScan: cb => ipcRenderer.on('dng-scan-result', (_e, msg) => cb(msg)),
  openJewelOverlay: () => ipcRenderer.send('jwl-overlay-show'),
  hideJewelOverlay: () => ipcRenderer.send('jwl-overlay-hide'),
  resizeJewelOverlay: h => ipcRenderer.send('jwl-overlay-resize', h),
  scanJewel: () => ipcRenderer.invoke('jwl-scan'),
  onJewelScan: cb => ipcRenderer.on('jwl-scan-result', (_e, msg) => cb(msg)),
  syncTabOverlay: tab => ipcRenderer.send('sync-tab-overlay', tab)
});
