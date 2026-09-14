const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  Notification,
  nativeImage,
} = require('electron');
const path = require('path');
const fs = require('fs');

const db = require('./db');
const { getPlanForDate } = require('./readingPlan');

const ICON_PATH = path.join(__dirname, 'assets', 'icon.png');
const NOTIFY_HOUR = 20; // 8pm

let mainWindow = null;
let tray = null;
let bible = null;
let headings = {};
let isQuitting = false;
let lastNotifiedDate = null;

// ---- single instance -------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  main();
}

function main() {
  app.setName('Daily Bible');
  app.setAppUserModelId('com.dyang.dailybible');

  app.whenReady().then(() => {
    loadBible();
    db.init(path.join(app.getPath('userData'), 'reading.db'));
    registerIpc();
    enableAutoLaunch();
    createWindow();
    createTray();
    startNotificationTimer();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else showWindow();
    });
  });

  // Minimize to tray instead of quitting.
  app.on('window-all-closed', (e) => {
    // keep running in the tray; do nothing (no app.quit)
  });

  app.on('before-quit', () => {
    isQuitting = true;
  });
}

// ---- data ------------------------------------------------------------------
function loadBible() {
  const raw = fs.readFileSync(path.join(__dirname, 'assets', 'bible.json'), 'utf8');
  bible = JSON.parse(raw);
  try {
    headings = JSON.parse(fs.readFileSync(path.join(__dirname, 'assets', 'headings.json'), 'utf8'));
  } catch {
    headings = {};
  }
}

function todayISO() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function todayPlan() {
  const start = db.getPlanStart(todayISO());
  const config = db.getPlanConfig();
  return getPlanForDate(bible.books, new Date(), start, config);
}

function planChapterLabels() {
  return todayPlan().chapters.map((c) => `${c.book} ${c.chapter}`);
}

// ---- window ----------------------------------------------------------------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 800,
    minWidth: 720,
    minHeight: 560,
    show: false,
    backgroundColor: '#0f1117',
    icon: ICON_PATH,
    title: 'Daily Bible',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.maximize();
    mainWindow.show();
  });

  // Close button -> hide to tray instead of quitting.
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

function showWindow() {
  if (!mainWindow) return createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// ---- tray ------------------------------------------------------------------
function createTray() {
  let img = nativeImage.createFromPath(ICON_PATH);
  const trayImg = img.resize({ width: 18, height: 18 });
  tray = new Tray(trayImg);
  tray.setToolTip('Daily Bible');
  rebuildTrayMenu();
  tray.on('click', () => showWindow());
}

function rebuildTrayMenu() {
  const done = db.isDateComplete(todayISO());
  const menu = Menu.buildFromTemplate([
    { label: 'Open', click: () => showWindow() },
    {
      label: done ? "Today ✓ Complete" : 'Mark Today Complete',
      enabled: !done,
      click: () => {
        markTodayComplete();
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
}

// ---- reading completion ----------------------------------------------------
function markTodayComplete(extra = {}) {
  const date = todayISO();
  db.logSession({
    date,
    chapters: extra.chapters && extra.chapters.length ? extra.chapters : planChapterLabels(),
    seconds: extra.seconds || 0,
  });
  rebuildTrayMenu();
  if (mainWindow) mainWindow.webContents.send('data:changed');
}

// ---- notifications ---------------------------------------------------------
function startNotificationTimer() {
  // Check once a minute whether it's past 8pm and today's reading is unread.
  setInterval(checkNotify, 60 * 1000);
  checkNotify();
}

function checkNotify() {
  const now = new Date();
  const date = todayISO();
  if (now.getHours() < NOTIFY_HOUR) return;
  if (lastNotifiedDate === date) return;
  if (db.isDateComplete(date)) return;

  lastNotifiedDate = date;
  const n = new Notification({
    title: "Today's reading isn't done",
    body: "You haven't completed today's Bible reading yet. Tap to open.",
    icon: ICON_PATH,
    silent: false,
  });
  n.on('click', () => showWindow());
  n.show();
}

// ---- auto launch -----------------------------------------------------------
function enableAutoLaunch() {
  try {
    app.setLoginItemSettings({
      openAtLogin: true,
      openAsHidden: true, // start in tray on login
    });
  } catch (err) {
    console.error('setLoginItemSettings failed:', err);
  }
}

// ---- IPC -------------------------------------------------------------------
function registerIpc() {
  ipcMain.handle('bible:get', () => bible);
  ipcMain.handle('headings:get', () => headings);
  ipcMain.handle('plan:today', () => ({
    date: todayISO(),
    start: db.getPlanStart(todayISO()),
    config: db.getPlanConfig(),
    ...todayPlan(),
  }));
  ipcMain.handle('plan:setStart', (_e, dateISO) => {
    const res = db.setPlanStart(dateISO);
    rebuildTrayMenu();
    if (mainWindow) mainWindow.webContents.send('data:changed');
    return res;
  });
  ipcMain.handle('plan:save', (_e, cfg) => {
    const res = db.setPlanConfig({ order: cfg.order, pace: cfg.pace, start: todayISO() });
    rebuildTrayMenu();
    if (mainWindow) mainWindow.webContents.send('data:changed');
    return res;
  });
  ipcMain.handle('plan:clear', () => {
    const res = db.clearPlanConfig(todayISO());
    rebuildTrayMenu();
    if (mainWindow) mainWindow.webContents.send('data:changed');
    return res;
  });
  ipcMain.handle('stats:get', () => db.getStats(todayISO()));
  ipcMain.handle('today:status', () => ({
    date: todayISO(),
    complete: db.isDateComplete(todayISO()),
  }));
  ipcMain.handle('session:log', (_e, payload) => {
    db.logSession({
      date: payload.date || todayISO(),
      chapters: payload.chapters || [],
      seconds: payload.seconds || 0,
    });
    rebuildTrayMenu();
    return { ok: true };
  });
  ipcMain.handle('today:complete', () => {
    markTodayComplete();
    return { ok: true };
  });
  ipcMain.handle('today:chapters', () => db.getChaptersReadOn(todayISO()));
  ipcMain.handle('chapters:read', () => db.getAllReadChapters());
  ipcMain.handle('chapters:markRead', (_e, labels) => {
    const r = db.markChaptersRead(labels, todayISO());
    rebuildTrayMenu();
    if (mainWindow) mainWindow.webContents.send('data:changed');
    return r;
  });
  ipcMain.handle('chapters:unmarkRead', (_e, labels) => {
    const r = db.removeReadChapters(labels);
    rebuildTrayMenu();
    if (mainWindow) mainWindow.webContents.send('data:changed');
    return r;
  });

  ipcMain.handle('bookmark:toggle', (_e, payload) => db.toggleBookmark(payload));
  ipcMain.handle('bookmark:remove', (_e, ref) => db.removeBookmark(ref));
  ipcMain.handle('bookmark:list', () => db.getBookmarks());

  ipcMain.handle('progress:reset', () => {
    const res = db.resetProgress(todayISO());
    rebuildTrayMenu();
    if (mainWindow) mainWindow.webContents.send('data:changed');
    return res;
  });
}
