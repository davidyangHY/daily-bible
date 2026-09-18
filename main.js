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
const Anthropic = require('@anthropic-ai/sdk');

const AI_MODEL = 'claude-haiku-4-5'; // lightest model; explanations are simple

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

function todayPlan() {
  const start = db.getPlanStart(todayISO());
  const config = db.getPlanConfig();
  return getPlanForDate(bible.books, new Date(), start, config);
}

function planChapterLabels() {
  return todayPlan().chapters.map((c) => `${c.book} ${c.chapter}`);
}

/** The plan's chapter labels for a specific date. */
function dayPlanLabels(dateISO) {
  const start = db.getPlanStart(todayISO());
  const config = db.getPlanConfig();
  const plan = getPlanForDate(bible.books, new Date(dateISO + 'T00:00:00'), start, config);
  return plan.chapters.map((c) => `${c.book} ${c.chapter}`);
}

/** A day is complete when at least the day's target number of chapters (any) is read. */
function isDayComplete(dateISO) {
  const target = dayPlanLabels(dateISO).length;
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

function aiProvider() {
  return db.getMeta('ai_provider') === 'anthropic' ? 'anthropic' : 'ollama'; // default: free local
}

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

async function callClaude(system, userText, maxTokens) {
  const apiKey = db.getMeta('anthropic_key');
  if (!apiKey) return { error: 'No API key set.' };
  try {
    const client = new Anthropic({ apiKey });
    const resp = await client.messages.create({
      model: AI_MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: userText }],
    });
    const text = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    return { text };
  } catch (e) {
    if (e && e.status === 401) return { error: 'Invalid API key.' };
    if (e && e.status === 429) return { error: 'Rate limited — try again in a moment.' };
    return { error: (e && e.message) || 'Request failed.' };
  }
}

async function callOllama(system, userText, maxTokens) {
  const model = db.getMeta('ollama_model');
  if (!model) return { error: 'No local model selected.' };
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

async function callAI(system, userText, maxTokens) {
  return aiProvider() === 'anthropic'
    ? callClaude(system, userText, maxTokens)
    : callOllama(system, userText, maxTokens);
}

async function aiExplain(book, chapter) {
  const version = currentVersion();
  const key = `${version}|${book}|${chapter}|explain|${aiProvider()}`;
  const cached = db.getAiCache(key);
  if (cached) return { text: cached, cached: true };
  const text = passageText(book, chapter);
  if (!text) return { error: 'Passage not found.' };
  const system =
    'You are a concise, accurate Bible study helper for a general reader. Be clear and non-denominational. Do not use markdown headings.';
  const user =
    `Passage: ${book} ${chapter} (${version})\n\n${text}\n\n` +
    'In under about 180 words, give:\n' +
    '1) A 2-3 sentence summary of what happens.\n' +
    '2) 3-4 short bullet points on key themes or meaning.\n' +
    '3) One or two sentences of helpful historical or cultural context.\n' +
    'Use plain text and simple "- " bullets.';
  const res = await callAI(system, user, 700);
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

  // ---- AI helper (local Ollama, or Claude API) ----
  ipcMain.handle('ai:status', async () => {
    const provider = aiProvider();
    const hasKey = !!db.getMeta('anthropic_key');
    const oll = await ollamaModels();
    const model = db.getMeta('ollama_model') || '';
    const ready = provider === 'anthropic' ? hasKey : (oll.running && !!model && oll.models.includes(model));
    return { provider, hasKey, ollama: { running: oll.running, models: oll.models, model }, ready };
  });
  ipcMain.handle('ai:setProvider', (_e, provider) => {
    db.setMeta('ai_provider', provider === 'anthropic' ? 'anthropic' : 'ollama');
    return { ok: true };
  });
  ipcMain.handle('ai:setOllamaModel', (_e, model) => { db.setMeta('ollama_model', String(model || '')); return { ok: true }; });
  ipcMain.handle('ai:setKey', (_e, key) => {
    const k = String(key || '').trim();
    if (!k.startsWith('sk-ant-')) return { ok: false, error: 'That does not look like an Anthropic API key (should start with "sk-ant-").' };
    db.setMeta('anthropic_key', k);
    return { ok: true };
  });
  ipcMain.handle('ai:clearKey', () => { db.setMeta('anthropic_key', ''); return { ok: true }; });
  ipcMain.handle('ai:explain', (_e, { book, chapter }) => aiExplain(book, chapter));
  ipcMain.handle('ai:ask', (_e, { book, chapter, question }) => aiAsk(book, chapter, question));
  ipcMain.handle('ai:plan', (_e, prompt) => aiPlan(prompt));

  ipcMain.handle('progress:reset', () => {
    const res = db.resetProgress(todayISO());
    rebuildTrayMenu();
    if (mainWindow) mainWindow.webContents.send('data:changed');
    return res;
  });
}
