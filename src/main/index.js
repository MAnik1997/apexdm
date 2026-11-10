const {
  app, BrowserWindow, Tray, Menu, ipcMain, dialog, shell, clipboard, Notification, nativeImage, screen, session,
} = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Library, normalizeSettings } = require('./library');
const { DownloadEngine } = require('./engine');
const { createNodeTransport } = require('./transport');
const { IntegrationServer } = require('./server');
const { formatSpeed } = require('../shared/format');

const { version } = require('../../package.json');
const root = path.join(__dirname, '..', '..');
const extensionDir = path.join(root, 'extension');
const preload = path.join(__dirname, '..', 'preload.js');

app.setName('ApexDM');
if (process.platform === 'win32') app.setAppUserModelId('com.apexdm.desktop');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => reveal());
  app.whenReady().then(start).catch((error) => {
    dialog.showErrorBox('ApexDM', error.message || 'ApexDM could not start.');
    app.quit();
  });
}

let win = null;
let tray = null;
let captureWin = null;
let captureReady = false;
let library = null;
let engine = null;
let server = null;
let lastClip = '';
let diskFree = null;
let logPath = '';
let quitting = false;
const proxyCache = new Map();

function log(error) {
  const line = `[${new Date().toISOString()}] ${error?.stack || error}\n`;
  if (!logPath) return;
  fs.appendFile(logPath, line, () => {});
}

function reveal() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function iconPath(name) {
  const file = path.join(root, 'assets', name);
  return fs.existsSync(file) ? file : '';
}

function toPublic(item) {
  return {
    id: item.id,
    url: item.url,
    finalUrl: item.finalUrl,
    filename: item.filename,
    directory: item.directory,
    finalPath: item.finalPath,
    category: item.category,
    status: item.status,
    error: item.error,
    size: item.size,
    downloaded: item.downloaded,
    connections: item.connections,
    segments: (item.segments || []).map((seg) => ({
      id: seg.id,
      start: seg.start,
      end: seg.end,
      received: seg.received,
      done: Boolean(seg.done),
    })),
    mode: item.mode,
    mime: item.mime,
    referrer: item.referrer,
    hasCookies: Boolean(item.cookies),
    source: item.source,
    priority: item.priority || 0,
    createdAt: item.createdAt,
    startedAt: item.startedAt,
    completedAt: item.completedAt,
    speed: item.speed || 0,
    scan: item.scan || null,
  };
}

function publicState() {
  const seen = server?.lastSeen || 0;
  return {
    items: library.items.map(toPublic),
    settings: { ...library.settings, schedule: { ...library.settings.schedule } },
    speed: engine.globalSpeed || 0,
    samples: engine.samples.slice(),
    holding: engine.holding,
    diskFree,
    version,
    port: server?.port || library.settings.port,
    extensionLastSeen: seen || null,
    extensionDir,
    downloadDir: library.settings.downloadDir,
  };
}

function broadcast() {
  const payload = publicState();
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('state', payload);
  }
  syncCapture(payload);
  if (tray) {
    const waiting = payload.items.filter((item) => item.status === 'awaiting').length;
    const active = payload.items.filter((item) => item.status === 'downloading').length;
    if (waiting) tray.setToolTip(`ApexDM — ${waiting} waiting for a choice`);
    else if (active) tray.setToolTip(`ApexDM — ${active} downloading · ${formatSpeed(payload.speed)}`);
    else tray.setToolTip('ApexDM');
  }
}

function windowOptions(extra) {
  const icon = iconPath('icon.png');
  return {
    backgroundColor: '#101114',
    icon: icon || undefined,
    autoHideMenuBar: true,
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
    ...extra,
  };
}

function createMainWindow() {
  win = new BrowserWindow(windowOptions({
    width: 1180,
    height: 760,
    minWidth: 980,
    minHeight: 640,
    show: false,
    title: 'ApexDM',
  }));
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.on('close', (event) => {
    if (!quitting && tray) {
      event.preventDefault();
      win.hide();
    }
  });
  win.on('focus', () => win.flashFrame(false));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });
  win.webContents.on('console-message', (event) => {
    const level = event.level;
    const message = event.message || '';
    if (level === 'warning' || level === 'error' || level >= 2) log(message);
  });
}

function placeCapture(window) {
  const area = screen.getPrimaryDisplay().workArea;
  window.setBounds({
    x: area.x + area.width - 416,
    y: area.y + area.height - 396,
    width: 400,
    height: 380,
  });
}

function ensureCapture() {
  if (captureWin && !captureWin.isDestroyed()) return captureWin;
  captureReady = false;
  captureWin = new BrowserWindow(windowOptions({
    width: 400,
    height: 380,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
  }));
  captureWin.loadFile(path.join(__dirname, '..', 'renderer', 'capture.html'));
  captureWin.once('ready-to-show', () => {
    captureReady = true;
    const waiting = library.items.some((item) => item.status === 'awaiting');
    if (waiting) {
      placeCapture(captureWin);
      captureWin.showInactive();
    }
  });
  captureWin.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      captureWin.hide();
      if (win && !win.isVisible()) reveal();
    }
  });
  captureWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  return captureWin;
}

let lastAwaiting = 0;
function syncCapture(state) {
  const waiting = state.items.filter((item) => item.status === 'awaiting').length;
  if (waiting > lastAwaiting && win && !win.isDestroyed() && !win.isFocused()) win.flashFrame(true);
  lastAwaiting = waiting;
  if (!waiting) {
    if (captureWin && !captureWin.isDestroyed() && captureWin.isVisible()) captureWin.hide();
    return;
  }
  const window = ensureCapture();
  if (!captureReady) return;
  if (!window.isVisible()) {
    placeCapture(window);
    window.showInactive();
  }
}

function createTray() {
  const file = iconPath('icon-32.png') || iconPath('icon.png');
  if (!file) return;
  const image = nativeImage.createFromPath(file);
  if (image.isEmpty()) return;
  tray = new Tray(image);
  tray.setToolTip('ApexDM');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open ApexDM', click: () => reveal() },
    { label: 'Pause all', click: () => engine.pauseAll().then(broadcast) },
    { label: 'Resume all', click: () => { engine.resumeAll(); broadcast(); } },
    { type: 'separator' },
    { label: 'Quit ApexDM', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', () => reveal());
}

function installMenu() {
  const send = (name) => {
    if (win && !win.isDestroyed()) {
      reveal();
      win.webContents.send('shortcut', name);
    }
  };
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'File',
      submenu: [
        { label: 'Add download', accelerator: 'CommandOrControl+N', click: () => send('add') },
        { label: 'Pause all', click: () => engine.pauseAll().then(broadcast) },
        { label: 'Resume all', click: () => { engine.resumeAll(); broadcast(); } },
        { type: 'separator' },
        { label: 'Quit ApexDM', accelerator: 'CommandOrControl+Q', click: () => { quitting = true; app.quit(); } },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
      ],
    },
  ]));
}

async function lookupProxy(url) {
  let host = '';
  try { host = new URL(url).host; } catch { return null; }
  const cached = proxyCache.get(host);
  if (cached && Date.now() - cached.at < 30000) return cached.value;
  let value = null;
  try {
    const result = await session.defaultSession.resolveProxy(url);
    const first = String(result || '').split(';')[0].trim();
    if (/^PROXY\s+/i.test(first)) value = first.replace(/^PROXY\s+/i, '');
    else if (/^SOCKS/i.test(first)) {
      const error = new Error('This network uses a SOCKS proxy. ApexDM can use a direct connection or an HTTP proxy.');
      error.fatal = true;
      throw error;
    }
  } catch (error) {
    if (error.fatal) throw error;
    value = null;
  }
  proxyCache.set(host, { at: Date.now(), value });
  return value;
}

function looksLikeFile(url) {
  try {
    const parsed = new URL(url);
    if (/\.[a-z0-9]{1,8}$/i.test(parsed.pathname)) return true;
    const hinted = parsed.searchParams.get('filename') || parsed.searchParams.get('file') || '';
    return /\.[a-z0-9]{1,8}$/i.test(hinted);
  } catch {
    return false;
  }
}

let clipError = '';

async function watchClipboard() {
  if (!library.settings.clipboardWatch) return;
  let text = '';
  try {
    text = String(await clipboard.readText() || '').trim();
    clipError = '';
  } catch (error) {
    if (clipError !== error.message) {
      clipError = error.message || 'clipboard';
      log(error);
    }
    return;
  }
  if (!text || text === lastClip) return;
  lastClip = text;
  if (!/^https?:\/\/\S+$/i.test(text) || text.length > 8000) return;
  if (library.settings.clipboardFilesOnly && !looksLikeFile(text)) return;
  const exists = library.items.some((item) => item.url === text && !['completed', 'cancelled', 'error'].includes(item.status));
  if (exists) return;
  try {
    engine.add({
      url: text,
      source: 'clipboard',
      status: library.settings.clipboardConfirm ? 'awaiting' : 'queued',
    });
  } catch (error) {
    log(error);
  }
}

const defenderCandidates = [
  'C:\\Program Files\\Windows Defender\\MpCmdRun.exe',
  'C:\\Program Files\\Microsoft Defender\\MpCmdRun.exe',
];

function scanFile(file) {
  return new Promise((resolve) => {
    const exe = defenderCandidates.find((candidate) => fs.existsSync(candidate));
    if (!exe || !fs.existsSync(file)) return resolve('skipped');
    const child = spawn(exe, ['-Scan', '-ScanType', '3', '-File', file], { windowsHide: true });
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.on('error', () => finish('skipped'));
    child.on('close', (code) => {
      if (code === 0) finish('clean');
      else if (code === 2) finish('threat');
      else finish('skipped');
    });
    setTimeout(() => {
      try { child.kill(); } catch { /* already finished */ }
      finish('skipped');
    }, 120000);
  });
}

async function scanItem(item) {
  item.scan = 'scanning';
  broadcast();
  item.scan = await scanFile(item.finalPath);
  library.save();
  broadcast();
  if (item.scan === 'threat' && Notification.isSupported()) {
    new Notification({ title: 'Defender found a threat', body: item.filename });
  }
}

async function readFree() {
  try {
    const stats = await fs.promises.statfs(library.settings.downloadDir);
    diskFree = Number(stats.bavail) * Number(stats.bsize);
  } catch {
    diskFree = null;
  }
}

async function applySettings(patch) {
  const previousPort = library.settings.port;
  let downloadDir = library.settings.downloadDir;
  if (typeof patch.downloadDir === 'string' && patch.downloadDir.trim()) {
    downloadDir = path.resolve(patch.downloadDir.trim());
    fs.mkdirSync(downloadDir, { recursive: true });
  }
  const schedule = patch.schedule
    ? { ...library.settings.schedule, ...patch.schedule }
    : library.settings.schedule;
  const next = normalizeSettings({
    ...library.settings,
    ...patch,
    downloadDir,
    schedule,
    token: library.settings.token,
  });
  if (next.port !== previousPort && server) {
    await server.close();
    try {
      await server.listen(next.port);
    } catch (error) {
      await server.listen(previousPort);
      throw new Error(`Port ${next.port} is already in use.`);
    }
  }
  library.settings = next;
  library.save();
}

function sendShortcut(name) {
  if (win && !win.isDestroyed()) win.webContents.send('shortcut', name);
}

function installIpc() {
  ipcMain.handle('getState', () => publicState());
  ipcMain.handle('add', (_event, payload) => {
    try {
      const result = engine.addMany(payload || {});
      broadcast();
      return { ok: true, count: result.items.length, errors: result.errors };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });
  ipcMain.handle('chooseFolder', async () => {
    const parent = win && !win.isDestroyed() ? win : undefined;
    const result = await dialog.showOpenDialog(parent, { properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled || !result.filePaths[0]) return null;
    return result.filePaths[0];
  });
  ipcMain.handle('settings', async (_event, patch) => {
    try {
      await applySettings(patch || {});
      broadcast();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });
  ipcMain.handle('copy', async (_event, text) => {
    const value = String(text ?? '');
    await clipboard.writeText(value);
    lastClip = value;
    return true;
  });
  ipcMain.handle('action', async (_event, request) => {
    try {
      await runAction(request || {});
      broadcast();
      return { ok: true };
    } catch (error) {
      log(error);
      return { ok: false, error: error.message };
    }
  });
}

async function runAction({ type, id, extra }) {
  switch (type) {
    case 'pause': return engine.pause(id);
    case 'resume': return engine.resume(id);
    case 'retry': return engine.retry(id);
    case 'cancel': return engine.cancel(id);
    case 'accept': return engine.accept(id);
    case 'reject': return engine.reject(id);
    case 'remove': return engine.remove(id, { deleteFile: false });
    case 'deleteFile': return engine.remove(id, { deleteFile: true });
    case 'pauseAll': return engine.pauseAll();
    case 'resumeAll': return engine.resumeAll();
    case 'priority': return engine.nudge(id, Number(extra) || 0);
    case 'updateUrl': return engine.updateUrl(id, extra);
    case 'connections': return engine.setConnections(id, extra);
    case 'hideCapture':
      if (captureWin && !captureWin.isDestroyed()) captureWin.hide();
      reveal();
      return;
    case 'open': {
      const item = engine.must(id);
      const error = await shell.openPath(item.finalPath);
      if (error) throw new Error(error);
      return;
    }
    case 'reveal': {
      const item = engine.must(id);
      if (item.status === 'completed' && fs.existsSync(item.finalPath)) shell.showItemInFolder(item.finalPath);
      else await shell.openPath(item.directory);
      return;
    }
    case 'scan': {
      const item = engine.must(id);
      if (item.status !== 'completed') throw new Error('The file is still downloading.');
      await scanItem(item);
      return;
    }
    case 'regenerateToken':
      library.settings.token = crypto.randomBytes(18).toString('hex');
      library.save();
      return;
    case 'openExtension':
      await shell.openPath(extensionDir);
      return;
    case 'export': {
      const parent = win && !win.isDestroyed() ? win : undefined;
      const result = await dialog.showSaveDialog(parent, {
        defaultPath: 'apexdm-library.json',
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (result.canceled || !result.filePath) return;
      fs.writeFileSync(result.filePath, JSON.stringify(library.items.map(toPublic), null, 2));
      return;
    }
    default:
      throw new Error('Unknown action.');
  }
}

async function start() {
  logPath = path.join(app.getPath('userData'), 'apex.log');
  library = new Library(path.join(app.getPath('userData'), 'library.json'));
  library.load({ downloadDir: app.getPath('downloads') });
  fs.mkdirSync(library.settings.downloadDir, { recursive: true });
  const transport = createNodeTransport({ getProxy: lookupProxy });
  engine = new DownloadEngine({
    library,
    transport,
    onChange: () => broadcast(),
    onComplete: (item) => {
      if (library.settings.notify && Notification.isSupported()) {
        const note = new Notification({ title: 'Download finished', body: item.filename });
        note.on('click', () => {
          reveal();
          shell.showItemInFolder(item.finalPath);
        });
      }
      if (library.settings.scanPrograms && item.category === 'programs') scanItem(item);
    },
    onLog: log,
  });
  server = new IntegrationServer({ engine, library, version });
  try {
    await server.listen(library.settings.port);
    if (server.port !== library.settings.port) {
      library.settings.port = server.port;
      library.save();
    }
  } catch (error) {
    dialog.showErrorBox('ApexDM', `Browser integration could not use port ${library.settings.port}.\n${error.message}\n\nDownloads you add inside ApexDM will still work.`);
  }
  installIpc();
  installMenu();
  createMainWindow();
  createTray();
  ensureCapture();
  engine.start(250);
  clipboard.readText().then((text) => { lastClip = String(text || '').trim(); }).catch(() => {});
  setInterval(() => {
    const dirty = engine.takeDirty();
    if (engine.hasActive() || dirty) broadcast();
  }, 300);
  setInterval(watchClipboard, 1200);
  readFree();
  setInterval(readFree, 8000);
  broadcast();
}

app.on('before-quit', (event) => {
  if (quitting && engine?.stopped) return;
  if (!engine || quitting === 'flushing') return;
  event.preventDefault();
  quitting = 'flushing';
  engine.shutdown().catch((error) => log(error)).finally(() => {
    engine.stopped = true;
    quitting = true;
    app.quit();
  });
});

app.on('window-all-closed', () => {
  if (!tray) app.quit();
});

process.on('unhandledRejection', log);
process.on('uncaughtException', log);
