// Electron shell: main solver window + always-on-top overlay for MapleStory.
// F8 = read the item tooltip under the cursor, F9 = show/hide the overlay.
const { app, BrowserWindow, globalShortcut, ipcMain, desktopCapturer, screen } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PAGE = path.join(__dirname, 'Quanah World Utilities.htm');
const webPreferences = { preload: path.join(__dirname, 'preload.js'), contextIsolation: true };
let mainWin, overlay, hud, dngWin, jewelWin, ocrProc, ocrQueue = [], ocrReady = false;
const delay = ms => new Promise(r => setTimeout(r, ms));

function createWindows() {
  mainWin = new BrowserWindow({ width: 1240, height: 900, title: 'Quanah World Utilities', webPreferences });
  mainWin.setMenuBarVisibility(false);
  mainWin.loadFile(PAGE);

  const { workArea } = screen.getPrimaryDisplay();
  overlay = new BrowserWindow({
    width: 430, height: 260, x: workArea.x + workArea.width - 450, y: workArea.y + 60,
    frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true,
    resizable: false, hasShadow: false, focusable: false, webPreferences
  });
  overlay.setAlwaysOnTop(true, 'screen-saver'); // stays above borderless-fullscreen games
  overlay.loadFile(PAGE, { query: { overlay: '1' } });
  const sendOvState = () => {
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('overlay-state', !!(overlay && !overlay.isDestroyed() && overlay.isVisible()));
  };
  overlay.on('show', sendOvState);
  overlay.on('hide', sendOvState);

  dngWin = new BrowserWindow({
    width: 390, height: 340, x: workArea.x + 20, y: workArea.y + 60, show: false,
    frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true,
    resizable: false, hasShadow: false, focusable: false, webPreferences
  });
  dngWin.setAlwaysOnTop(true, 'screen-saver');
  dngWin.loadFile(PAGE, { query: { dungeon: '1' } });

  jewelWin = new BrowserWindow({
    width: 390, height: 320, x: workArea.x + 20, y: workArea.y + 420, show: false,
    frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true,
    resizable: false, hasShadow: false, focusable: false, webPreferences
  });
  jewelWin.setAlwaysOnTop(true, 'screen-saver');
  jewelWin.loadFile(PAGE, { query: { jewel: '1' } });

  hud = new BrowserWindow({
    width: 320, height: 80, show: false, opacity: 0,
    frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true,
    resizable: false, hasShadow: false, focusable: false, webPreferences
  });
  hud.setAlwaysOnTop(true, 'screen-saver');
  hud.setIgnoreMouseEvents(true);
  hud.loadFile(PAGE, { query: { hud: '1' } });
  hud.once('ready-to-show', () => { if (hud && !hud.isDestroyed()) hud.showInactive(); });

  mainWin.on('closed', () => {
    clearInterval(hoverTimer);
    globalShortcut.unregisterAll();
    if (ocrProc) { try { ocrProc.kill(); } catch (e) {} ocrProc = null; }
    if (hud && !hud.isDestroyed()) hud.destroy();
    if (dngWin && !dngWin.isDestroyed()) dngWin.destroy();
    if (jewelWin && !jewelWin.isDestroyed()) jewelWin.destroy();
    if (overlay && !overlay.isDestroyed()) overlay.destroy();
    overlay = null; hud = null; dngWin = null; jewelWin = null;
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

// Dark-on-light variant for Inventory > Jewels white pill (dark text on white/light-gray background).
function toLightBgBMP(img) {
  const { width: w, height: h } = img.getSize();
  const src = img.toBitmap();
  const rowSize = Math.ceil((w * 3) / 4) * 4;
  const buf = Buffer.alloc(54 + rowSize * h);
  buf.write('BM', 0);
  buf.writeUInt32LE(buf.length, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(w, 18);
  buf.writeInt32LE(-h, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = (y * w + x) * 4;
      const maxC = Math.max(src[si], src[si + 1], src[si + 2]);
      const v = maxC < 155 ? 0 : 255;
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

let hudFade = null, hudTarget = 0;
function fadeHud(to) {
  if (!hud || hud.isDestroyed() || hudTarget === to) return;
  hudTarget = to;
  clearInterval(hudFade);
  const step = to > 0 ? 0.28 : -0.32;
  hudFade = setInterval(() => {
    if (!hud || hud.isDestroyed()) { clearInterval(hudFade); return; }
    const next = Math.max(0, Math.min(1, hud.getOpacity() + step));
    hud.setOpacity(next);
    if ((step > 0 && next >= 1) || (step < 0 && next <= 0)) clearInterval(hudFade);
  }, 12);
}
let lastKeyAt = { f7: 0, f8: 0, f9: 0 };
function triggerF7() {
  const now = Date.now(); if (now - lastKeyAt.f7 < 350) return; lastKeyAt.f7 = now;
  console.log('KEY: F7');
  if (overlay && !overlay.isDestroyed()) overlay.webContents.send('quick-add');
  fadeHud(0);
}
function triggerF8() {
  const now = Date.now(); if (now - lastKeyAt.f8 < 350) return; lastKeyAt.f8 = now;
  scan(false);
}
let lastOverlayPos = null;
function saveOverlayPos(win) {
  if (win && !win.isDestroyed()) {
    const b = win.getBounds();
    lastOverlayPos = { x: b.x, y: b.y };
  }
}
function showOnlyOverlay(target) {
  for (const w of [overlay, dngWin, jewelWin]) {
    if (w && !w.isDestroyed() && w !== target && w.isVisible()) {
      saveOverlayPos(w);
      w.hide();
      if (w === overlay) fadeHud(0);
    }
  }
  if (target && !target.isDestroyed()) {
    if (lastOverlayPos) {
      const b = target.getBounds();
      const wa = screen.getDisplayNearestPoint(lastOverlayPos).workArea;
      const x = Math.max(wa.x, Math.min(wa.x + wa.width - b.width, lastOverlayPos.x));
      const y = Math.max(wa.y, Math.min(wa.y + wa.height - b.height, lastOverlayPos.y));
      target.setBounds({ x, y, width: b.width, height: b.height });
    }
    target.showInactive();
  }
}
function triggerF9() {
  const now = Date.now(); if (now - lastKeyAt.f9 < 350) return; lastKeyAt.f9 = now;
  if (overlay && !overlay.isDestroyed()) {
    if (overlay.isVisible()) { saveOverlayPos(overlay); overlay.hide(); fadeHud(0); }
    else showOnlyOverlay(overlay);
  }
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
    if (!autoScan || !/maplestory/i.test(st.fg || '')) return;
    const pt = screen.getCursorScreenPoint();
    const inWin = w => {
      if (!w || w.isDestroyed() || !w.isVisible()) return false;
      const b = w.getBounds();
      return pt.x >= b.x && pt.x <= b.x + b.width && pt.y >= b.y && pt.y <= b.y + b.height;
    };
    if (inWin(overlay) || inWin(dngWin) || inWin(jewelWin)) {
      lastPt = pt; stillSince = Date.now(); return;
    }
    if (dngWin && !dngWin.isDestroyed() && dngWin.isVisible()) {
      if (!scanning && !dngScanning) checkDungeonScreen();
      return;
    }
    if (jewelWin && !jewelWin.isDestroyed() && jewelWin.isVisible()) {
      if (!scanning && !jwlScanning && Date.now() - lastJwlAt >= 1200) {
        lastJwlAt = Date.now();
        scanJewelScreen('auto');
      }
      return;
    }
    if (!overlay || overlay.isDestroyed() || !overlay.isVisible()) return;
    if (!lastPt || dist(pt, lastPt) > 12) {
      lastPt = pt; stillSince = Date.now();
      if (scannedAt && dist(pt, scannedAt) > 38) { scannedAt = null; fadeHud(0); }
      return;
    }
    if (!scannedAt && Date.now() - stillSince >= 60) {
      scannedAt = pt;
      scan(false);
    }
  });
}, 40);
let dngScanning = false, dngWasBlack = false, lastDngCheckAt = 0, lastDngOcrAt = 0;
let jwlScanning = false, lastJwlAt = 0;
async function checkDungeonScreen() {
  const now = Date.now();
  if (now - lastDngCheckAt < 350 || dngScanning) return;
  lastDngCheckAt = now;
  try {
    const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 160, height: 90 } });
    const src = sources.find(s => s.display_id === String(d.id)) || sources[0];
    if (!src) return;
    const bmp = src.thumbnail.toBitmap();
    let sum = 0;
    for (let i = 0; i < bmp.length; i += 16) sum += bmp[i] + bmp[i + 1] + bmp[i + 2];
    const avg = sum / ((bmp.length / 16) * 3);
    if (avg < 18) { dngWasBlack = true; return; }
    if (dngWasBlack && avg > 38) {
      dngWasBlack = false;
      await delay(300);
      return scanDungeonScreen('room');
    }
    if (now - lastDngOcrAt >= 1200) {
      lastDngOcrAt = now;
      scanDungeonScreen('auto');
    }
  } catch (e) {}
}
const BUFF_TEMPLATES = [
  ['echo', [58,91,139,120,139,158,156,168,174,153,167,178,61,91,137,174,182,189,164,156,141,169,159,142,69,99,145,178,173,169,173,183,198,154,163,176,63,93,136,147,150,154,120,133,147,113,127,144]],
  ['echo', [133,149,171,188,186,174,163,155,146,188,193,189,163,174,190,154,149,148,194,208,225,172,165,160,141,146,154,122,125,130,134,149,165,135,137,140,80,87,95,73,77,84,90,102,118,112,118,128]],
  ['sayram', [178,121,112,100,100,125,119,108,119,183,98,90,186,142,119,150,127,144,159,120,138,196,105,105,161,133,126,183,168,172,175,104,108,153,83,77,89,85,86,108,106,111,127,125,142,104,107,130]],
  ['vip_stat', [130,178,234,89,185,239,95,195,241,90,182,243,128,174,232,121,177,235,112,178,239,120,174,240,111,159,194,75,146,202,97,181,234,90,176,246,82,111,148,75,103,125,84,162,204,59,168,249]],
  ['mpe_atk', [203,218,238,149,162,181,75,82,95,161,173,191,188,203,223,118,127,127,82,132,106,133,137,129,143,153,159,143,152,159,106,192,66,115,141,118,123,131,141,81,104,91,91,147,70,72,139,92]],
  ['mpe_atk', [208,220,238,140,152,168,67,74,88,166,178,195,191,203,218,116,122,120,119,77,92,136,141,135,139,146,150,143,149,156,177,53,59,132,113,114,122,129,138,98,85,89,142,59,77,125,86,108]],
  ['mpe_gold', [204,217,234,169,159,132,184,139,56,193,172,162,203,206,213,150,135,91,180,144,81,159,126,92,146,143,135,152,151,137,200,199,109,164,139,83,127,129,133,111,114,107,176,158,92,200,179,108]],
  ['sparkling', [111,84,71,171,158,129,117,88,84,134,109,119,165,125,135,139,74,68,193,78,143,186,74,120,132,117,106,145,63,88,180,81,151,137,56,79,127,124,135,98,102,106,126,78,102,197,54,110]],
  ['sparkling', [123,160,168,110,181,183,152,164,167,109,138,136,226,226,225,154,151,112,108,183,178,85,127,109,188,187,185,170,171,158,166,195,171,183,184,137,141,145,148,107,110,112,164,151,120,182,152,98]],
  ['sparkling', [115,155,163,105,172,185,140,155,159,94,128,136,217,215,217,111,124,130,92,169,175,65,111,114,182,180,182,153,165,167,131,191,194,138,173,179,135,138,142,91,95,98,129,142,147,126,143,158]],
  ['exp_drop', [133,203,238,31,183,239,58,179,235,52,158,229,119,194,238,59,185,239,59,182,239,73,160,230,103,152,191,62,141,197,47,147,222,68,160,230,79,110,139,54,84,111,61,129,184,43,143,223]],
  ['exp_drop', [198,151,169,206,123,146,203,136,159,204,118,139,196,145,164,202,141,160,201,146,165,199,145,164,166,141,155,162,102,116,197,142,161,203,132,153,106,90,96,95,69,75,151,95,109,204,83,104]],
  ['showa', [206,219,237,152,172,187,65,152,126,213,229,247,206,219,237,106,161,152,155,206,193,169,193,208,178,189,205,142,165,171,179,208,209,171,191,206,100,105,110,118,149,152,176,209,206,163,188,202]],
  ['showa', [208,138,102,203,93,75,154,41,41,207,219,236,173,62,63,134,44,50,126,122,127,210,222,239,114,95,99,112,57,66,141,152,170,174,186,204,127,124,132,88,72,78,151,159,170,150,162,183]]
];
function sampleIconGrid(bmp, w, h, x0, y0, sw, sh) {
  const grid = [];
  for (let gy = 0; gy < 4; gy++) {
    for (let gx = 0; gx < 4; gx++) {
      const px0 = x0 + Math.floor((gx * sw) / 4), py0 = y0 + Math.floor((gy * sh) / 4);
      const pw = Math.max(1, Math.floor(sw / 4)), ph = Math.max(1, Math.floor(sh / 4));
      let r = 0, g = 0, b = 0, n = 0;
      for (let y = py0; y < py0 + ph && y < h; y += 2) {
        for (let x = px0; x < px0 + pw && x < w; x += 2) {
          const i = (y * w + x) * 4;
          b += bmp[i]; g += bmp[i + 1]; r += bmp[i + 2]; n++;
        }
      }
      if (!n) return null;
      grid.push(Math.round(r / n), Math.round(g / n), Math.round(b / n));
    }
  }
  return grid;
}
function detectBuffBar(img, sf) {
  try {
    const { width: w, height: h } = img.getSize();
    const bmp = img.toBitmap();
    const px = (x, y) => { const i = (y * w + x) * 4; return [bmp[i + 2], bmp[i + 1], bmp[i]]; };
    const found = new Set();
    const minY = 2, maxY = Math.min(h - 40, Math.round(h * 0.22));
    const minX = Math.max(0, Math.round(w * 0.30));
    const sizes = sf >= 1.5 ? [Math.round(32 * sf), 64, 32] : [Math.round(32 * sf), 32, 64];
    const seenSizes = [...new Set(sizes.filter(s => s >= 26 && s <= 76))];
    for (const box of seenSizes) {
      let rowHits = 0;
      for (let y = minY; y < maxY; y += 2) {
        let x = w - box - 4;
        let rowBoxes = [];
        while (x >= minX) {
          const [rT, gT, bT] = px(x + Math.floor(box / 2), y);
          const [rI, gI, bI] = px(x + Math.floor(box / 2), Math.min(h - 1, y + Math.floor(box * 0.35)));
          const [rL, gL, bL] = px(x + 1, Math.min(h - 1, y + Math.floor(box * 0.35)));
          if (Math.max(rT, gT, bT) < 60 && Math.max(rL, gL, bL) < 75 && Math.max(rI, gI, bI) > 65) {
            rowBoxes.push(x);
            x -= box + 2;
          } else { x -= 2; }
        }
        if (rowBoxes.length >= 2) {
          rowHits++;
          for (const bx of rowBoxes) {
            const g = sampleIconGrid(bmp, w, h, bx + Math.round(box * 0.12), y + Math.round(box * 0.12), Math.round(box * 0.76), Math.round(box * 0.58));
            if (!g) continue;
            let bestId = null, bestDiff = 24;
            for (const [id, tpl] of BUFF_TEMPLATES) {
              let diff = 0;
              for (let k = 0; k < 48; k++) diff += Math.abs(g[k] - tpl[k]);
              diff /= 48;
              if (diff < bestDiff) { bestDiff = diff; bestId = id; }
            }
            if (bestId) found.add(bestId);
          }
          y += box;
        }
      }
      if (rowHits > 0) break;
    }
    return [...found];
  } catch (e) { return []; }
}
function detectJewelInventory(img) {
  try {
    const { width: w, height: h } = img.getSize();
    const bmp = img.toBitmap();
    const px = (x, y) => { const i = (y * w + x) * 4; return [bmp[i + 2], bmp[i + 1], bmp[i]]; };
    const isCell = (r, g, b) => Math.min(r, g, b) >= 200 && Math.max(r, g, b) <= 233 && Math.max(r, g, b) - Math.min(r, g, b) < 16;
    const isGap = (r, g, b) => Math.min(r, g, b) >= 235 && Math.max(r, g, b) - Math.min(r, g, b) < 16;
    const hasRowGaps = (grp, ry) => {
      if (ry < 4 || ry >= h) return false;
      let ok = 0;
      for (let c = 0; c < 7; c++) {
        const gx = Math.round((grp[c].x1 + grp[c + 1].x0) / 2);
        if (isGap(...px(gx, ry))) ok++;
      }
      return ok >= 5;
    };
    // Locate any 8-column row of the Inventory > Jewels grid (works at any UI scale)
    for (let y = Math.round(h * 0.08); y < Math.round(h * 0.80); y += 4) {
      let runs = [], cur = null;
      for (let x = 0; x < w; x++) {
        const [r, g, b] = px(x, y);
        if (isCell(r, g, b)) { if (!cur) cur = { x0: x, x1: x }; else cur.x1 = x; }
        else if (cur) {
          const rw = cur.x1 - cur.x0 + 1;
          if (rw >= 28 && rw <= 115) runs.push(cur);
          cur = null;
        }
      }
      if (runs.length < 8) continue;
      for (let i = 0; i <= runs.length - 8; i++) {
        const grp = runs.slice(i, i + 8);
        const widths = grp.map(g => g.x1 - g.x0 + 1);
        const avgW = widths.reduce((a, b) => a + b, 0) / 8;
        if (!widths.every(cw => Math.abs(cw - avgW) <= Math.max(4, avgW * 0.15))) continue;
        const stepX = (grp[7].x0 - grp[0].x0) / 7;
        if (stepX < avgW || stepX > avgW * 1.35) continue;
        if (!hasRowGaps(grp, y)) continue;
        // Find top of this cell, then walk up by stepX to Row 0
        let cellTop = y;
        while (cellTop > 4 && isCell(...px(grp[0].x0 + 2, cellTop - 1))) cellTop--;
        while (cellTop - stepX > 10 && hasRowGaps(grp, Math.round(cellTop - stepX * 0.5))) {
          cellTop = Math.round(cellTop - stepX);
        }
        const rowY = cellTop;
        const counts = { total: 0, red: 0, blue: 0, green: 0, purple: 0, gray: 0, prismatic: 0 };
        const rows = [];
        for (let rIdx = 0; rIdx < 8; rIdx++) {
          const cy0 = Math.round(rowY + rIdx * stepX);
          if (cy0 + avgW >= h) break;
          const rowCols = [];
          for (let cIdx = 0; cIdx < 8; cIdx++) {
            const cx0 = Math.round(grp[0].x0 + cIdx * stepX);
            let warm = 0, cool = 0, red = 0, green = 0, blue = 0, purple = 0, dark = 0, bright = 0;
            const pad = Math.round(avgW * 0.18), end = Math.round(avgW * 0.82);
            for (let yy = cy0 + pad; yy < cy0 + end; yy += 2) {
              for (let xx = cx0 + pad; xx < cx0 + end; xx += 2) {
                const [r, g, b] = px(xx, yy);
                const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
                if (mn > 235 && mx - mn < 15) bright++;
                if (mx < 120 && mx - mn < 26) dark++;
                if (r - b > 35) warm++;
                if (b - r > 35) cool++;
                if (r - g > 55 && r - b > 55) red++;
                else if (g - r > 45 && g - b > 28) green++;
                else if (b - r > 55 && b - g > 20) blue++;
                else if (r - g > 40 && b - g > 40) purple++;
              }
            }
            if (dark < 6 && warm < 6 && cool < 6 && red < 6 && green < 6 && blue < 6 && purple < 6) { rowCols.push('.'); continue; }
            if (bright > 18 && dark < 28 && red < 6 && green < 6 && blue < 6 && purple < 6) { rowCols.push('.'); continue; }
            counts.total++;
            if (warm >= 15 && cool >= 15 && Math.min(warm, cool) >= 0.35 * Math.max(warm, cool)) { counts.prismatic++; rowCols.push('P'); continue; }
            const best = [['red', red], ['green', green], ['blue', blue], ['purple', purple]].sort((a, b) => b[1] - a[1])[0];
            if (best[1] >= 6) { counts[best[0]]++; rowCols.push(best[0][0].toUpperCase()); }
            else if (dark >= 6) { counts.gray++; rowCols.push('X'); }
            else rowCols.push('.');
          }
          if (rowCols.some(c => c !== '.')) rows.push(rowCols.join(''));
        }
        // Crop the bottom Dust pill below the 8x8 grid
        const pillY = Math.min(h - 10, Math.round(rowY + 8 * stepX + avgW * 0.05));
        const pillH = Math.min(h - pillY, Math.round(avgW * 1.2));
        const pillX = Math.max(0, Math.round(grp[0].x0 - avgW * 0.2));
        const pillW = Math.min(w - pillX, Math.round(4.5 * stepX));
        const dustCrop = pillH > 12 && pillW > 40 ? img.crop({ x: pillX, y: pillY, width: pillW, height: pillH }) : null;
        return { counts: { ...counts, rows }, dustCrop };
      }
    }
    return null;
  } catch (e) { return null; }
}
async function captureScreenOcrText(mode = 'dungeon') {
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const sf = d.scaleFactor || 1;
  const sources = await desktopCapturer.getSources({
    types: ['screen'], thumbnailSize: { width: Math.round(d.size.width * sf), height: Math.round(d.size.height * sf) }
  });
  const src = sources.find(s => s.display_id === String(d.id)) || sources[0];
  if (!src) return null;
  const rawImg = src.thumbnail;
  const detectedBuffs = mode === 'dungeon' ? detectBuffBar(rawImg, sf) : undefined;
  let jewelInv = undefined;
  let invDustText = '';
  if (mode === 'jewel') {
    const inv = detectJewelInventory(rawImg, sf);
    if (inv) {
      jewelInv = inv.counts;
      if (inv.dustCrop) {
        const dc = inv.dustCrop.getSize();
        const z = inv.dustCrop.resize({ width: Math.round(dc.width * 3), quality: 'best' });
        invDustText = await recognizeBMP(toLightBgBMP(z));
      }
    }
  }
  let img = rawImg;
  if (sf < 2) { const s = img.getSize(); img = img.resize({ width: Math.min(2560, Math.round(s.width * 1.5)), quality: 'best' }); }
  let text = await recognizeBMP(toHighContrastBMP(img));
  if (invDustText) text = `INV_DUST:${invDustText}\n` + text;
  let ttText = '';
  if (mode === 'jewel') {
    const pt = screen.getCursorScreenPoint(), rs = rawImg.getSize();
    const jb = jewelWin && !jewelWin.isDestroyed() ? jewelWin.getBounds() : null;
    const inOverlay = jb && pt.x >= jb.x && pt.x <= jb.x + jb.width && pt.y >= jb.y && pt.y <= jb.y + jb.height;
    const cx = Math.round((pt.x - d.bounds.x) * sf), cy = Math.round((pt.y - d.bounds.y) * sf);
    const tx0 = Math.max(0, cx - Math.round(120 * sf)), ty0 = Math.max(0, cy - Math.round(80 * sf));
    const tx1 = Math.min(rs.width, cx + Math.round(280 * sf)), ty1 = Math.min(rs.height, cy + Math.round(280 * sf));
    if (!inOverlay && tx1 - tx0 > 40 && ty1 - ty0 > 40) {
      let ttCrop = rawImg.crop({ x: tx0, y: ty0, width: tx1 - tx0, height: ty1 - ty0 });
      // Tighten onto the dark tooltip box if present so surrounding white Inventory grid doesn't distract OCR
      const cw = ttCrop.getSize().width, ch = ttCrop.getSize().height, tb = ttCrop.toBitmap();
      let minX = cw, maxX = -1, minY = ch, maxY = -1;
      for (let yy = 0; yy < ch; yy += 2) {
        let darkRun = 0, runStart = 0;
        for (let xx = 0; xx < cw; xx++) {
          const i = (yy * cw + xx) * 4;
          const isDark = tb[i] < 95 && tb[i + 1] < 95 && tb[i + 2] < 95;
          if (isDark) { if (!darkRun) runStart = xx; darkRun++; }
          else {
            if (darkRun >= Math.round(70 * sf)) {
              minX = Math.min(minX, runStart); maxX = Math.max(maxX, xx - 1);
              minY = Math.min(minY, yy); maxY = Math.max(maxY, yy);
            }
            darkRun = 0;
          }
        }
        if (darkRun >= Math.round(70 * sf)) {
          minX = Math.min(minX, runStart); maxX = Math.max(maxX, cw - 1);
          minY = Math.min(minY, yy); maxY = Math.max(maxY, yy);
        }
      }
      if (maxX - minX >= Math.round(70 * sf) && maxY - minY >= Math.round(50 * sf)) {
        const px0 = Math.max(0, minX - 4), py0 = Math.max(0, minY - 4);
        const pw = Math.min(cw - px0, maxX - minX + 8), ph = Math.min(ch - py0, maxY - minY + 8);
        ttCrop = ttCrop.crop({ x: px0, y: py0, width: pw, height: ph });
      }
      const ts = ttCrop.getSize();
      const ttZoom = ttCrop.resize({ width: Math.round(ts.width * (sf < 2 ? 3 : 2)), quality: 'best' });
      ttText = await recognizeBMP(toHighContrastBMP(ttZoom));
      if (ttText) text = text + '\nTT_JWL:\n' + ttText;
    }
  }
  if (mode === 'jewel' && !invDustText && !/3[0O]{4}/.test(text)) {
    const rs = rawImg.getSize();
    const crop = rawImg.crop({ x: 0, y: Math.round(rs.height * 0.12), width: rs.width, height: Math.round(rs.height * 0.68) });
    const cs = crop.getSize();
    const zoomed = crop.resize({ width: Math.min(3840, Math.round(cs.width * 2.5)), quality: 'best' });
    const extra = await recognizeBMP(toHighContrastBMP(zoomed));
    if (extra) text = text + '\n' + extra;
  }
  if (mode === 'jewel') console.log('JWL_SCAN:', { jewelInv, invDustText, ttText });
  return mode === 'dungeon' ? { text, detectedBuffs } : { text, jewelInv };
}
async function scanSideOverlay(win, channel, getLock, setLock, trigger = 'manual', mode = 'dungeon') {
  if (getLock() || !win || win.isDestroyed()) return;
  setLock(true);
  try {
    const res = await captureScreenOcrText(mode);
    if (!res) return;
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, { status: 'done', text: res.text, detectedBuffs: res.detectedBuffs, jewelInv: res.jewelInv, trigger, at: Date.now() });
    }
  } catch (e) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, { status: 'error', error: String(e && e.message || e) });
  } finally { setLock(false); }
}
const scanDungeonScreen = (trigger = 'manual') =>
  scanSideOverlay(dngWin, 'dng-scan-result', () => dngScanning, v => { dngScanning = v; }, trigger, 'dungeon');
const scanJewelScreen = (trigger = 'manual') =>
  scanSideOverlay(jewelWin, 'jwl-scan-result', () => jwlScanning, v => { jwlScanning = v; }, trigger, 'jewel');
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
    const nextH = Math.min(Math.ceil(h), maxH);
    if (b.height !== nextH || b.width !== 430) overlay.setBounds({ x: b.x, y: b.y, width: 430, height: nextH });
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
    fadeHud(1);
  });
  ipcMain.on('hud-hide', () => fadeHud(0));
  ipcMain.on('overlay-hide', () => { if (overlay && !overlay.isDestroyed() && overlay.isVisible()) saveOverlayPos(overlay); if (overlay) overlay.hide(); fadeHud(0); });
  ipcMain.on('main-show', () => { if (mainWin) { mainWin.show(); mainWin.focus(); } });
  ipcMain.on('sync-state', e => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.webContents !== e.sender) w.webContents.send('sync-state');
    }
  });
  ipcMain.on('overlay-show', () => showOnlyOverlay(overlay));
  ipcMain.handle('overlay-visible', () => !!(overlay && !overlay.isDestroyed() && overlay.isVisible()));
  const resizeSideOverlay = (win, h) => {
    if (!win || win.isDestroyed() || !(h > 0)) return;
    const b = win.getBounds();
    const wa = screen.getDisplayNearestPoint({ x: b.x, y: b.y }).workArea;
    const maxH = Math.max(220, wa.y + wa.height - b.y - 12);
    win.setBounds({ x: b.x, y: b.y, width: 390, height: Math.min(Math.ceil(h), maxH) });
  };
  ipcMain.on('dng-overlay-show', () => showOnlyOverlay(dngWin));
  ipcMain.on('dng-overlay-hide', () => { if (dngWin && !dngWin.isDestroyed()) { if (dngWin.isVisible()) saveOverlayPos(dngWin); dngWin.hide(); } });
  ipcMain.on('dng-overlay-resize', (_e, h) => resizeSideOverlay(dngWin, h));
  ipcMain.handle('dng-scan', () => scanDungeonScreen('manual'));
  ipcMain.on('jwl-overlay-show', () => showOnlyOverlay(jewelWin));
  ipcMain.on('jwl-overlay-hide', () => { if (jewelWin && !jewelWin.isDestroyed()) { if (jewelWin.isVisible()) saveOverlayPos(jewelWin); jewelWin.hide(); } });
  ipcMain.on('jwl-overlay-resize', (_e, h) => resizeSideOverlay(jewelWin, h));
  ipcMain.handle('jwl-scan', () => scanJewelScreen('manual'));
  ipcMain.on('sync-tab-overlay', (_e, tab) => {
    const anyOpen = [overlay, dngWin, jewelWin].some(w => w && !w.isDestroyed() && w.isVisible());
    if (!anyOpen) return;
    if (tab === 'solver') showOnlyOverlay(overlay);
    else if (tab === 'dungeon') showOnlyOverlay(dngWin);
    else if (tab === 'jewels') showOnlyOverlay(jewelWin);
  });
});
app.on('will-quit', () => { globalShortcut.unregisterAll(); if (ocrProc) ocrProc.kill(); });
app.on('window-all-closed', () => app.quit());
