// Electron shell: main solver window + always-on-top overlay for MapleStory.
// F8 = read the item tooltip under the cursor, F9 = show/hide the overlay.
const { app, BrowserWindow, globalShortcut, ipcMain, desktopCapturer, screen } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PAGE = path.join(__dirname, '3L Set Solver.htm');
const webPreferences = { preload: path.join(__dirname, 'preload.js'), contextIsolation: true };
let mainWin, overlay, hud, ocrProc, ocrQueue = [], ocrReady = false;
const delay = ms => new Promise(r => setTimeout(r, ms));

function createWindows() {
  mainWin = new BrowserWindow({ width: 1240, height: 900, title: 'Quanah World Utilities', webPreferences });
  mainWin.setMenuBarVisibility(false);
  mainWin.loadFile(PAGE);

  const { workArea } = screen.getPrimaryDisplay();
  overlay = new BrowserWindow({
    width: 390, height: 260, x: workArea.x + workArea.width - 410, y: workArea.y + 60,
    frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true,
    resizable: false, hasShadow: false, focusable: false, webPreferences
  });
  overlay.setAlwaysOnTop(true, 'screen-saver'); // stays above borderless-fullscreen games
  overlay.loadFile(PAGE, { query: { overlay: '1' } });

  hud = new BrowserWindow({
    width: 320, height: 80, show: false,
    frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true,
    resizable: false, hasShadow: false, focusable: false, webPreferences
  });
  hud.setAlwaysOnTop(true, 'screen-saver');
  hud.setIgnoreMouseEvents(true);
  hud.loadFile(PAGE, { query: { hud: '1' } });

  mainWin.on('closed', () => {
    clearInterval(hoverTimer);
    globalShortcut.unregisterAll();
    if (ocrProc) { try { ocrProc.kill(); } catch (e) {} ocrProc = null; }
    if (hud && !hud.isDestroyed()) hud.destroy();
    if (overlay && !overlay.isDestroyed()) overlay.destroy();
    overlay = null; hud = null;
    app.quit();
  });
}

// Convert Electron NativeImage (BGRA) to a high-contrast black-on-white BMP for fast, accurate OCR.
function toHighContrastBMP(img) {
  const { width: w, height: h } = img.getSize();
  const src = img.toBitmap(); // BGRA, top-down
  const rowSize = Math.ceil((w * 3) / 4) * 4;
  const buf = Buffer.alloc(54 + rowSize * h);
  buf.write('BM', 0);
  buf.writeUInt32LE(buf.length, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(w, 18);
  buf.writeInt32LE(-h, 22); // negative = top-down
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = (y * w + x) * 4;
      const minC = Math.min(src[si], src[si + 1], src[si + 2]);
      const v = minC > 112 ? 0 : 255; // neutral light tooltip text -> black, colored/dark bg -> white
      const di = 54 + y * rowSize + x * 3;
      buf[di] = buf[di + 1] = buf[di + 2] = v;
    }
  }
  return buf;
}

// Find the item icon box in the tooltip and classify its top jewel sockets: prismatic, red, green, gray, purple, blue.
function detectSockets(img, sf) {
  try {
    const { width: w, height: h } = img.getSize();
    const src = img.toBitmap();
    const px = (x, y) => { const i = (y * w + x) * 4; return [src[i + 2], src[i + 1], src[i]]; }; // RGB
    // Top of the icon box is neutral slate-gray (~80..175) with low saturation
    const isBoxBg = (r, g, b) => r >= 65 && r <= 215 && g >= 70 && g <= 220 && b >= 75 && b <= 225 && Math.max(r, g, b) - Math.min(r, g, b) < 26;
    const minRun = Math.round(75 * sf), maxRun = Math.round(180 * sf);
    for (let y = 0; y < h; y += Math.max(1, Math.round(sf))) {
      let run = 0, start = 0;
      for (let x = 0; x < w; x++) {
        const [r, g, b] = px(x, y);
        if (isBoxBg(r, g, b)) { if (!run) start = x; run++; }
        else {
          if (run >= minRun && run <= maxRun) {
            const yTop = Math.min(h - 1, y + Math.round(run * 0.14));
            const yBot = Math.min(h - 1, y + Math.round(run * 0.88));
            const [r2, g2, b2] = px(start + 4, yTop);
            const [r3, g3, b3] = px(start + run - 5, yTop);
            const [r4, g4, b4] = px(start + 6, yBot);
            const [r5, g5, b5] = px(start + run - 7, yBot);
            const [rl, gl, bl] = px(Math.max(0, start - 6), yTop);
            const [rr, gr, br] = px(Math.min(w - 1, start + run + 5), yTop);
            if (isBoxBg(r2, g2, b2) && isBoxBg(r3, g3, b3) && isBoxBg(r4, g4, b4) && isBoxBg(r5, g5, b5) && Math.max(rl, gl, bl) < 75 && Math.max(rr, gr, br) < 75) {
              const out = readBoxSockets(px, w, h, start, y, run);
              console.log('SOCK_DBG:', { bx: start, by: y, bw: run, out });
              if (out.length) return out;
            }
          }
          run = 0;
        }
      }
    }
    return null;
  } catch (e) { return null; }
}

function readBoxSockets(px, w, h, bx, by, bw) {
  const y0 = Math.min(h - 1, by + Math.round(bw * 0.04)), y1 = Math.min(h - 1, by + Math.round(bw * 0.21));
  const ySep1 = Math.min(h - 1, by + Math.round(bw * 0.15)); // strictly above item sprites (e.g. Pants waistband)
  const xStart = Math.max(0, bx + Math.round(bw * 0.08)), xEnd = Math.min(w - 1, bx + Math.round(bw * 0.92));
  // Find distinct horizontal socket clusters using only the upper socket band so sprites below don't bridge them
  const clusters = [];
  let cur = null, gap = 0;
  for (let x = xStart; x <= xEnd; x++) {
    let active = false;
    for (let y = y0; y <= ySep1; y++) {
      const [r, g, b] = px(x, y);
      if (Math.max(r, g, b) < 48 || Math.max(r, g, b) - Math.min(r, g, b) > 30) { active = true; break; }
    }
    if (active) {
      if (!cur) cur = { x0: x, x1: x }; else cur.x1 = x;
      gap = 0;
    } else if (cur) {
      if (++gap >= Math.max(4, Math.round(bw * 0.04))) { clusters.push(cur); cur = null; }
    }
  }
  if (cur) clusters.push(cur);
  const out = [];
  for (const c of clusters) {
    if (c.x1 - c.x0 < Math.max(6, Math.round(bw * 0.06))) continue;
    let warm = 0, cool = 0, red = 0, green = 0, blue = 0, purple = 0, dark = 0;
    for (let y = y0; y <= y1; y++) {
      for (let x = c.x0; x <= c.x1; x++) {
        const [r, g, b] = px(x, y);
        if (Math.max(r, g, b) < 48) dark++;
        if (r - b > 35) warm++;
        if (b - r > 35) cool++;
        if (r - g > 55 && r - b > 55) red++;
        else if (g - r > 45 && g - b > 28) green++;
        else if (b - r > 55 && b - g > 20) blue++;
        else if (r - g > 40 && b - g > 40) purple++;
      }
    }
    if (dark < 6 && warm < 4 && cool < 4 && red < 4 && green < 4 && blue < 4 && purple < 4) continue;
    if (warm >= 3 && cool >= 3) { out.push('prismatic'); continue; }
    const best = [['red', red], ['green', green], ['blue', blue], ['purple', purple]].sort((a, b) => b[1] - a[1])[0];
    out.push(best[1] >= 4 ? best[0] : 'gray');
  }
  return out.slice(0, 3);
}

async function capture() {
  const pt = screen.getCursorScreenPoint();
  const d = screen.getDisplayNearestPoint(pt);
  const sf = d.scaleFactor;
  const sources = await desktopCapturer.getSources({
    types: ['screen'], thumbnailSize: { width: Math.round(d.size.width * sf), height: Math.round(d.size.height * sf) }
  });
  const src = sources.find(s => s.display_id === String(d.id)) || sources[0];
  const img = src.thumbnail, size = img.getSize();
  // Tooltips open left or right of the cursor and extend downward; capture downward from the cursor.
  const halfW = Math.round(520 * sf);
  const cx = Math.round((pt.x - d.bounds.x) * sf), cy = Math.round((pt.y - d.bounds.y) * sf);
  const x0 = Math.max(0, cx - halfW), x1 = Math.min(size.width, cx + halfW);
  const y0 = Math.max(0, cy - Math.round(280 * sf)), y1 = Math.min(size.height, cy + Math.round(1050 * sf));
  let crop = img.crop({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
  const sockets = detectSockets(crop, sf);
  if (sf < 2) { const s = crop.getSize(); crop = crop.resize({ width: s.width * 2, quality: 'best' }); }
  return { bmp: toHighContrastBMP(crop), sockets };
}

function startOcrWorker() {
  if (ocrProc) return;
  const ocrScript = path.join(__dirname, 'lib', 'ocr.ps1').replace('app.asar', 'app.asar.unpacked');
  ocrProc = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ocrScript], {
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let buf = '';
  ocrProc.stdout.on('data', chunk => {
    buf += chunk.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.ready) { ocrReady = true; continue; }
        const cb = ocrQueue.shift();
        if (cb) cb(msg.error ? new Error(msg.error) : null, msg.fg !== undefined ? msg : (msg.text || ''));
      } catch (e) {}
    }
  });
  ocrProc.on('exit', () => {
    ocrProc = null; ocrReady = false;
    while (ocrQueue.length) ocrQueue.shift()(new Error('OCR worker exited'));
  });
}

function recognizeBMP(bmp) {
  startOcrWorker();
  const tmp = path.join(app.getPath('userData'), 'scan.bmp');
  fs.writeFileSync(tmp, bmp);
  return new Promise((resolve, reject) => {
    ocrQueue.push((err, text) => err ? reject(err) : resolve(text));
    ocrProc.stdin.write(tmp + '\n');
  });
}

function getForegroundState() {
  if (!ocrProc || !ocrReady) return Promise.resolve({ fg: '' });
  return new Promise(resolve => {
    ocrQueue.push((err, res) => resolve(err || !res ? { fg: '' } : res));
    ocrProc.stdin.write('CHECK_FG\n');
  });
}

let lastKeyAt = { f7: 0, f8: 0, f9: 0 };
function triggerF7() {
  const now = Date.now(); if (now - lastKeyAt.f7 < 350) return; lastKeyAt.f7 = now;
  console.log('KEY: F7');
  if (overlay && !overlay.isDestroyed()) overlay.webContents.send('quick-add');
  if (hud && !hud.isDestroyed()) hud.hide();
}
function triggerF8() {
  const now = Date.now(); if (now - lastKeyAt.f8 < 350) return; lastKeyAt.f8 = now;
  scan(false);
}
function triggerF9() {
  const now = Date.now(); if (now - lastKeyAt.f9 < 350) return; lastKeyAt.f9 = now;
  if (overlay && !overlay.isDestroyed()) overlay.isVisible() ? overlay.hide() : overlay.showInactive();
}

let scanning = false, autoScan = true;
let lastPt = null, stillSince = 0, scannedAt = null;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

const hoverTimer = setInterval(() => {
  if (scanning || !overlay || overlay.isDestroyed()) return;
  getForegroundState().then(st => {
    if (st.f7) triggerF7();
    if (st.f8) triggerF8();
    if (st.f9) triggerF9();
    if (!autoScan || !overlay || overlay.isDestroyed() || !overlay.isVisible()) return;
    const pt = screen.getCursorScreenPoint();
    const ob = overlay.getBounds();
    if (pt.x >= ob.x && pt.x <= ob.x + ob.width && pt.y >= ob.y && pt.y <= ob.y + ob.height) {
      lastPt = pt; stillSince = Date.now(); return;
    }
    if (!lastPt || dist(pt, lastPt) > 12) {
      lastPt = pt; stillSince = Date.now();
      if (scannedAt && dist(pt, scannedAt) > 38) { scannedAt = null; if (hud && !hud.isDestroyed()) hud.hide(); }
      return;
    }
    if (!scannedAt && Date.now() - stillSince >= 150 && /maplestory/i.test(st.fg || '')) {
      scannedAt = pt;
      scan(false);
    }
  });
}, 60);
async function scan(fromUI = false) {
  if (scanning || !overlay) return;
  scanning = true;
  const pt = screen.getCursorScreenPoint();
  const send = msg => {
    if (overlay && !overlay.isDestroyed()) overlay.webContents.send('scan-result', msg);
    if (hud && !hud.isDestroyed()) hud.webContents.send('scan-result', { ...msg, pt });
  };
  try {
    overlay.showInactive();
    if (fromUI) {
      send({ status: 'waiting' });
      await delay(1500);
    }
    send({ status: 'scanning', manual: fromUI });
    const { bmp, sockets } = await capture();
    const text = await recognizeBMP(bmp);
    console.log('OCR:\n' + text, sockets ? 'SOCKETS: ' + sockets.join(',') : '');
    send({ status: 'done', text, sockets, manual: fromUI });
  } catch (e) {
    send({ status: 'error', error: String(e && e.message || e) });
  } finally { scanning = false; }
}

app.whenReady().then(() => {
  startOcrWorker();
  createWindows();
  globalShortcut.register('F7', triggerF7);
  globalShortcut.register('F8', triggerF8);
  globalShortcut.register('F9', triggerF9);
  ipcMain.handle('scan', () => scan(true));
  ipcMain.on('set-auto', (_e, on) => { autoScan = !!on; scannedAt = null; });
  ipcMain.on('overlay-resize', (_e, h) => {
    if (!overlay || overlay.isDestroyed() || !(h > 0)) return;
    const b = overlay.getBounds();
    const wa = screen.getDisplayNearestPoint({ x: b.x, y: b.y }).workArea;
    const maxH = Math.max(200, wa.y + wa.height - b.y - 12);
    overlay.setBounds({ x: b.x, y: b.y, width: 390, height: Math.min(Math.ceil(h), maxH) });
  });
  ipcMain.on('hud-show', (_e, w, h) => {
    if (!hud || !scannedAt) return;
    const d = screen.getDisplayNearestPoint(scannedAt).workArea;
    const W = Math.min(Math.max(Math.ceil(w), 180), 380), H = Math.min(Math.ceil(h), 240);
    const x = Math.min(d.x + d.width - W - 8, Math.max(d.x + 8, scannedAt.x + 18));
    const y = Math.max(d.y + 8, scannedAt.y - H - 14);
    const nx = Math.round(x), ny = Math.round(y);
    const cur = hud.getBounds();
    if (cur.x !== nx || cur.y !== ny || cur.width !== W || cur.height !== H) {
      hud.setBounds({ x: nx, y: ny, width: W, height: H });
    }
    if (!hud.isVisible()) hud.showInactive();
  });
  ipcMain.on('hud-hide', () => hud && hud.hide());
  ipcMain.on('overlay-hide', () => { if (overlay) overlay.hide(); if (hud) hud.hide(); });
  ipcMain.on('main-show', () => { if (mainWin) { mainWin.show(); mainWin.focus(); } });
  ipcMain.on('sync-state', e => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.webContents !== e.sender) w.webContents.send('sync-state');
    }
  });
  ipcMain.on('overlay-show', () => overlay && overlay.showInactive());
});
app.on('will-quit', () => { globalShortcut.unregisterAll(); if (ocrProc) ocrProc.kill(); });
app.on('window-all-closed', () => app.quit());
