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
const https = require('https');
const http = require('http');
const { execFile, spawn } = require('child_process');

const db = require('./db');
const { planChapters, nextChapters, chapterLabel } = require('./readingPlan');

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
    db.init(path.join(app.getPath('userData'), 'reading.db'));
    loadBible();
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
const VERSIONS = {
  WEB: { name: 'World English Bible', file: 'bible.json' },
  BSB: { name: 'Berean Standard Bible', file: 'bible-bsb.json' },
  KJV: { name: 'King James Version', file: 'bible-kjv.json' },
};

function currentVersion() {
  const v = db.getMeta('version');
  return VERSIONS[v] ? v : 'WEB';
}

function loadBible() {
  const file = VERSIONS[currentVersion()].file;
  bible = JSON.parse(fs.readFileSync(path.join(__dirname, 'assets', file), 'utf8'));
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

/**
 * Today's reading follows your progress, not the calendar: it's the next unread
 * chapters in plan order, so a missed day carries over instead of skipping
 * ahead. It's fixed once per day (stored as `plan_cursor`) so the chapters you
 * read today stay on today's list instead of sliding forward.
 */
function todayPlan() {
  const today = todayISO();
  const config = db.getPlanConfig();
  const { all, pace } = planChapters(bible.books, config);
  const sig = JSON.stringify(config);
  const byLabel = new Map(all.map((c) => [chapterLabel(c), c]));

  let cursor = null;
  try { cursor = JSON.parse(db.getMeta('plan_cursor') || 'null'); } catch { cursor = null; }
  let labels;
  if (cursor && cursor.date === today && cursor.sig === sig && Array.isArray(cursor.labels)
      && cursor.labels.every((l) => byLabel.has(l))) {
    labels = cursor.labels;
  } else {
    // Chapters read before today count as done; today's reads stay on today's list.
    const before = new Set(db.getChaptersReadBefore(today));
    labels = nextChapters(all, pace, before).map(chapterLabel);
    db.setMeta('plan_cursor', JSON.stringify({ date: today, sig, labels }));
  }

  const totalDays = Math.max(1, Math.ceil(all.length / pace));
  const readAll = new Set(db.getAllReadChapters());
  const todaySet = new Set(labels);
  let done = 0;
  for (const c of all) {
    const l = chapterLabel(c);
    if (readAll.has(l) && !todaySet.has(l)) done++;
  }
  return {
    day: Math.min(totalDays, Math.floor(done / pace) + 1),
    totalDays,
    finished: labels.length === 0,
    chapters: labels.map((l) => byLabel.get(l)),
  };
}

/** Recompute today's chapters from everything read so far (e.g. after catching up). */
function resetPlanCursor() {
  db.setMeta('plan_cursor', '');
  const config = db.getPlanConfig();
  const { all, pace } = planChapters(bible.books, config);
  const labels = nextChapters(all, pace, new Set(db.getAllReadChapters())).map(chapterLabel);
  db.setMeta('plan_cursor', JSON.stringify({ date: todayISO(), sig: JSON.stringify(config), labels }));
}

function planChapterLabels() {
  return todayPlan().chapters.map(chapterLabel);
}

/** A day is complete when at least that day's target number of chapters (any) is read. */
function isDayComplete(dateISO) {
  let target;
  if (dateISO === todayISO()) {
    target = todayPlan().chapters.length;
  } else {
    const { all, pace } = planChapters(bible.books, db.getPlanConfig());
    target = Math.min(pace, all.length);
  }
  if (!target) return false;
  return db.getChaptersReadOn(dateISO).length >= target;
}

// ---- AI helper ------------------------------------------------------------
function passageText(book, chapter) {
  const b = bible.books.find((x) => x.name === book);
  if (!b) return '';
  const verses = b.chapters[chapter - 1] || [];
  return verses.map((t, i) => `${i + 1} ${t}`).join(' ');
}

const OLLAMA_URL = 'http://127.0.0.1:11434';

const OLLAMA_INSTALLER_URL = 'https://ollama.com/download/OllamaSetup.exe';
const DEFAULT_MODEL = 'llama3.2';

async function ollamaModels() {
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return { running: true, models: [] };
    const j = await r.json();
    return { running: true, models: (j.models || []).map((m) => m.name) };
  } catch {
    return { running: false, models: [] };
  }
}

// ---- Ollama auto-install -----------------------------------------------------
function sendInstallProgress(phase, percent, message) {
  if (mainWindow) {
    mainWindow.webContents.send('ai:install-progress', {
      phase,
      percent: Math.max(0, Math.min(100, Math.round(percent || 0))),
      message: message || '',
    });
  }
}

/** GET a URL to a file, following redirects, reporting fraction complete. */
function downloadFile(url, dest, onProgress, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('Too many redirects.'));
    const file = fs.createWriteStream(dest);
    const req = https.get(url, { headers: { 'User-Agent': 'DailyBible' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        file.close();
        fs.unlink(dest, () => {});
        return downloadFile(res.headers.location, dest, onProgress, redirects + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        file.close();
        fs.unlink(dest, () => {});
        return reject(new Error(`Download failed (HTTP ${res.statusCode}).`));
      }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let done = 0;
      res.on('data', (c) => {
        done += c.length;
        if (total) onProgress(done / total);
      });
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve()));
      file.on('error', (e) => { fs.unlink(dest, () => {}); reject(e); });
    });
    req.on('error', (e) => { file.close(); fs.unlink(dest, () => {}); reject(e); });
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitForOllama(timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if ((await ollamaModels()).running) return true;
    await sleep(2500);
  }
  return false;
}

/** Download and silently install Ollama. Resolves once its local server responds. */
async function installOllama() {
  const dest = path.join(app.getPath('temp'), 'OllamaSetup.exe');
  sendInstallProgress('downloading', 0, 'Downloading Ollama (about 1.5 GB)…');
  await downloadFile(OLLAMA_INSTALLER_URL, dest, (f) =>
    sendInstallProgress('downloading', f * 100, `Downloading Ollama… ${Math.round(f * 100)}%`)
  );
  sendInstallProgress('installing', 100, 'Installing Ollama…');
  await new Promise((resolve) => {
    // Ollama uses an Inno Setup installer (installs per-user, no admin needed).
    execFile(dest, ['/VERYSILENT', '/NORESTART', '/SUPPRESSMSGBOXES'], { windowsHide: true }, () => resolve());
  });
  sendInstallProgress('starting', 100, 'Starting Ollama…');
  const up = await waitForOllama(120000);
  fs.unlink(dest, () => {});
  if (!up) throw new Error("Ollama installed but didn't start. Open it once, then click Re-check.");
}

/** Pull a model via Ollama's streaming API, reporting download progress. */
function pullModel(model) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ name: model, stream: true });
    const req = http.request(
      `${OLLAMA_URL}/api/pull`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      (res) => {
        let buf = '';
        let failed = null;
        res.on('data', (chunk) => {
          buf += chunk.toString();
          let nl;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            try {
              const j = JSON.parse(line);
              if (j.error) { failed = j.error; sendInstallProgress('error', 0, j.error); }
              else if (j.total && j.completed != null) {
                sendInstallProgress('pulling', (j.completed / j.total) * 100, `Downloading ${model}… ${Math.round((j.completed / j.total) * 100)}%`);
              } else if (j.status) {
                sendInstallProgress('pulling', 100, j.status);
              }
            } catch { /* ignore partial lines */ }
          }
        });
        res.on('end', () => (failed ? reject(new Error(failed)) : resolve()));
      }
    );
    req.on('error', (e) => reject(e));
    req.write(body);
    req.end();
  });
}

/** Path to an installed ollama.exe, or null. */
function ollamaExePath() {
  const local = process.env.LOCALAPPDATA || '';
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const candidates = [
    path.join(local, 'Programs', 'Ollama', 'ollama.exe'),
    path.join(pf, 'Ollama', 'ollama.exe'),
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function isProcessRunning(imageName) {
  return new Promise((resolve) => {
    execFile('tasklist', ['/FI', `IMAGENAME eq ${imageName}`, '/NH'], { windowsHide: true }, (err, out) => {
      resolve(!err && String(out).toLowerCase().includes(imageName.toLowerCase()));
    });
  });
}

let ollamaFirstWait = 0; // when we first saw Ollama installed but its server down
let ollamaLastKick = 0;

/** Ollama is installed but not serving: start it, unless it is already starting. */
async function kickOllamaStart() {
  if (Date.now() - ollamaLastKick < 20000) return;
  ollamaLastKick = Date.now();
  // At login Ollama launches itself; if its process exists, just wait for it.
  if ((await isProcessRunning('ollama.exe')) || (await isProcessRunning('ollama app.exe'))) return;
  const exe = ollamaExePath();
  if (!exe) return;
  const appExe = path.join(path.dirname(exe), 'ollama app.exe');
  try {
    const child = fs.existsSync(appExe)
      ? spawn(appExe, [], { detached: true, stdio: 'ignore', windowsHide: true })
      : spawn(exe, ['serve'], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  } catch { /* ignore */ }
}

/** The stored model if still installed, else llama3.2, else whatever is available. */
function pickModel(models) {
  const stored = db.getMeta('ollama_model');
  if (stored && models.includes(stored)) return stored;
  return models.find((m) => m === DEFAULT_MODEL || m.startsWith(DEFAULT_MODEL + ':')) || models[0] || '';
}

/**
 * Where the local AI stands. Never suggests installing when Ollama is already
 * installed — it starts it and uses whatever model is available.
 *   ready    — serving, model selected
 *   nomodel  — serving, but no model pulled yet
 *   starting — installed, server coming up
 *   stopped  — installed, but it didn't come up after a while
 *   missing  — not installed
 */
async function aiStatus() {
  const oll = await ollamaModels();
  const installed = !!ollamaExePath();
  const none = { running: false, models: [], model: '' };
  if (oll.running) {
    ollamaFirstWait = 0;
    if (installed) db.setMeta('ollama_installed', '1');
    if (!oll.models.length) return { state: 'nomodel', ollama: { running: true, models: [], model: '' }, ready: false };
    const model = pickModel(oll.models);
    if (model !== db.getMeta('ollama_model')) db.setMeta('ollama_model', model);
    return { state: 'ready', ollama: { running: true, models: oll.models, model }, ready: true };
  }
  if (installed) {
    if (!ollamaFirstWait) ollamaFirstWait = Date.now();
    kickOllamaStart().catch(() => {});
    const state = Date.now() - ollamaFirstWait < 90000 ? 'starting' : 'stopped';
    return { state, ollama: none, ready: false };
  }
  return { state: 'missing', installedBefore: db.getMeta('ollama_installed') === '1', ollama: none, ready: false };
}

/** One-click setup: install Ollama only if it isn't installed, pull a model if none, select it. */
async function autoSetupOllama() {
  try {
    let oll = await ollamaModels();
    if (!oll.running) {
      if (ollamaExePath()) {
        sendInstallProgress('starting', 100, 'Starting Ollama…');
        await kickOllamaStart();
        if (!(await waitForOllama(60000))) throw new Error("Ollama is installed but didn't start. Open it once, then click Re-check.");
      } else {
        await installOllama();
      }
      db.setMeta('ollama_installed', '1');
      oll = await ollamaModels();
    }
    if (!oll.models.length) {
      sendInstallProgress('pulling', 0, `Downloading ${DEFAULT_MODEL} (about 2 GB)…`);
      await pullModel(DEFAULT_MODEL);
      oll = await ollamaModels();
    }
    const chosen = pickModel(oll.models) || DEFAULT_MODEL;
    db.setMeta('ollama_model', chosen);
    sendInstallProgress('done', 100, 'Ready.');
    return { ok: true, model: chosen };
  } catch (e) {
    sendInstallProgress('error', 0, (e && e.message) || 'Setup failed.');
    return { ok: false, error: (e && e.message) || 'Setup failed.' };
  }
}

async function callAI(system, userText, maxTokens) {
  let model = db.getMeta('ollama_model');
  if (!model) {
    const st = await aiStatus(); // auto-selects an available model
    model = st.ollama.model;
  }
  if (!model) return { error: 'The local model is still starting — try again in a moment.' };
  try {
    const r = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        messages: [{ role: 'system', content: system }, { role: 'user', content: userText }],
        options: { num_predict: maxTokens },
      }),
      signal: AbortSignal.timeout(120000),
    });
    if (!r.ok) return { error: `Local model error (${r.status}).` };
    const j = await r.json();
    const text = ((j.message && j.message.content) || '').trim();
    return text ? { text } : { error: 'The local model returned an empty response.' };
  } catch {
    return { error: "Couldn't reach Ollama. Make sure it's installed and running (ollama.com)." };
  }
}

/** Verse text for a range within a chapter, numbered. */
function passageTextRange(book, chapter, from, to) {
  const b = bible.books.find((x) => x.name === book);
  if (!b) return '';
  const verses = b.chapters[chapter - 1] || [];
  const out = [];
  for (let v = from; v <= to; v++) if (verses[v - 1] != null) out.push(`${v} ${verses[v - 1]}`);
  return out.join(' ');
}

/** Explain one section (verse range) of a chapter. */
async function aiExplainPassage(book, chapter, from, to, label) {
  from = parseInt(from, 10);
  to = parseInt(to, 10);
  if (!(from >= 1) || !(to >= from)) return { error: 'Passage not found.' };
  const version = currentVersion();
  const key = `${version}|${book}|${chapter}|${from}-${to}|explain|ollama`;
  const cached = db.getAiCache(key);
  if (cached) return { text: cached, cached: true };
  const text = passageTextRange(book, chapter, from, to);
  if (!text) return { error: 'Passage not found.' };
  const ref = from === to ? `${book} ${chapter}:${from}` : `${book} ${chapter}:${from}-${to}`;
  const system =
    'You are a concise, accurate Bible study helper for a general reader. Be clear and non-denominational. Do not use markdown headings.';
  const user =
    `Passage: ${ref}${label ? ` — "${label}"` : ''} (${version})\n\n${text}\n\n` +
    'In under about 140 words, explain this passage for someone reading it now: ' +
    'what is happening and what it means. Then add 1-2 short "- " bullets on key themes or helpful context. Use plain text.';
  const res = await callAI(system, user, 600);
  if (res.text) db.setAiCache(key, res.text);
  return res;
}

async function aiAsk(book, chapter, question) {
  const q = String(question || '').trim();
  if (!q) return { error: 'Ask a question first.' };
  const text = passageText(book, chapter);
  const system =
    "You are a concise, accurate Bible study helper. Answer the user's question about the passage. " +
    'If it cannot be answered from the passage or general Bible knowledge, say so briefly. Do not use markdown headings.';
  const user = `Passage: ${book} ${chapter}\n\n${text}\n\nQuestion: ${q}`;
  return callAI(system, user, 700);
}

function extractJson(s) {
  const m = String(s).match(/\{[\s\S]*\}/);
  return m ? m[0] : s;
}

async function aiPlan(prompt) {
  const user = String(prompt || '').trim();
  if (!user) return { error: 'Describe the plan you want.' };
  const names = bible.books.map((b) => b.name);
  const counts = bible.books.map((b) => `${b.name}=${b.chapters.length}`).join(', ');
  const system =
    'You build Bible reading plans. Reply with ONLY a JSON object (no prose, no code fences) of the form ' +
    '{"order": [book names in reading order], "pace": integer chapters per day from 1 to 8}. ' +
    `Choose 'order' from exactly these 66 book names, using exact spelling: ${names.join(', ')}. ` +
    "If the user gives a duration, choose 'pace' so total chapters divided by pace is about that many days. " +
    `Book chapter counts: ${counts}.`;
  const res = await callAI(system, user, 500);
  if (res.error) return res;
  let obj;
  try { obj = JSON.parse(extractJson(res.text)); } catch { return { error: 'Could not read the generated plan — try rephrasing.' }; }
  const valid = new Set(names);
  const order = Array.isArray(obj.order) ? obj.order.filter((n) => valid.has(n)) : [];
  let pace = parseInt(obj.pace, 10);
  if (!(pace >= 1)) pace = 3;
  if (pace > 8) pace = 8;
  if (!order.length) return { error: 'The generated plan had no valid books — try rephrasing.' };
  return { order, pace };
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
  const done = isDayComplete(todayISO());
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
  if (isDayComplete(date)) return;

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
  ipcMain.handle('version:get', () => ({
    current: currentVersion(),
    available: Object.entries(VERSIONS).map(([id, v]) => ({ id, name: v.name })),
  }));
  ipcMain.handle('version:set', (_e, id) => {
    if (VERSIONS[id]) {
      db.setMeta('version', id);
      loadBible();
      if (mainWindow) mainWindow.webContents.send('data:changed');
    }
    return { ok: true, current: currentVersion() };
  });
  ipcMain.handle('plan:today', () => ({
    date: todayISO(),
    config: db.getPlanConfig(),
    ...todayPlan(),
  }));
  ipcMain.handle('plan:save', (_e, cfg) => {
    const res = db.setPlanConfig({ order: cfg.order, pace: cfg.pace, start: todayISO() });
    resetPlanCursor();
    rebuildTrayMenu();
    if (mainWindow) mainWindow.webContents.send('data:changed');
    return res;
  });
  ipcMain.handle('plan:clear', () => {
    const res = db.clearPlanConfig(todayISO());
    resetPlanCursor();
    rebuildTrayMenu();
    if (mainWindow) mainWindow.webContents.send('data:changed');
    return res;
  });
  // After catching up, pick today's chapters from everything read so far.
  ipcMain.handle('plan:recompute', () => {
    resetPlanCursor();
    rebuildTrayMenu();
    return { ok: true };
  });
  ipcMain.handle('stats:get', () => {
    const activity = db.getCompletedDates(); // dates with any reading, ascending
    const completed = activity.filter(isDayComplete); // dates whose full plan was read
    const firstDate = activity.length ? activity[0] : null;
    return db.getStats(todayISO(), { completedDates: completed, firstDate });
  });
  ipcMain.handle('today:status', () => ({
    date: todayISO(),
    complete: isDayComplete(todayISO()),
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

  // ---- AI helper (local Ollama only) ----
  ipcMain.handle('ai:status', () => aiStatus());
  ipcMain.handle('ai:setOllamaModel', (_e, model) => { db.setMeta('ollama_model', String(model || '')); return { ok: true }; });
  ipcMain.handle('ai:autoSetup', () => autoSetupOllama());
  ipcMain.handle('ai:explainPassage', (_e, { book, chapter, from, to, label }) => aiExplainPassage(book, chapter, from, to, label));
  ipcMain.handle('ai:ask', (_e, { book, chapter, question }) => aiAsk(book, chapter, question));
  ipcMain.handle('ai:plan', (_e, prompt) => aiPlan(prompt));

  ipcMain.handle('progress:reset', () => {
    const res = db.resetProgress(todayISO());
    resetPlanCursor();
    rebuildTrayMenu();
    if (mainWindow) mainWindow.webContents.send('data:changed');
    return res;
  });
}
