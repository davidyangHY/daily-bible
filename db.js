/*
 * SQLite persistence (better-sqlite3).
 *   sessions  — one row per completed reading session
 *   bookmarks — saved verses
 * The database file lives in the app's userData directory.
 */
const Database = require('better-sqlite3');

let db;

function init(dbPath) {
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      date       TEXT    NOT NULL,          -- local calendar day, YYYY-MM-DD
      chapters   TEXT    NOT NULL,          -- JSON array of "Book Chapter" strings
      seconds    INTEGER NOT NULL DEFAULT 0,
      created_at TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_date ON sessions(date);

    CREATE TABLE IF NOT EXISTS bookmarks (
      ref        TEXT PRIMARY KEY,          -- "Book Chapter:Verse"
      book       TEXT    NOT NULL,
      chapter    INTEGER NOT NULL,
      verse      INTEGER NOT NULL,
      text       TEXT    NOT NULL,
      created_at TEXT    NOT NULL
    );

    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
  `);
  return db;
}

/* ---------------- settings / meta ---------------- */

function getMeta(key) {
  const row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key);
  return row ? row.value : null;
}

function setMeta(key, value) {
  db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
}

/** The date the reading plan starts from (Day 1). Defaults to `today` on first use. */
function getPlanStart(today) {
  let start = getMeta('plan_start');
  if (!start) {
    start = today;
    setMeta('plan_start', start);
  }
  return start;
}

/** Change the plan start date (Day 1). Expects "YYYY-MM-DD". */
function setPlanStart(dateISO) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) throw new Error('Invalid date');
  setMeta('plan_start', dateISO);
  return { ok: true, planStart: dateISO };
}

/**
 * Custom plan config, or null when using the default (whole Bible in a year).
 * @returns {{ order: string[], pace: number } | null}
 */
function getPlanConfig() {
  const booksRaw = getMeta('plan_books');
  const pace = parseInt(getMeta('plan_pace'), 10);
  let order = null;
  if (booksRaw) {
    try { order = JSON.parse(booksRaw); } catch { order = null; }
  }
  if (!order || !order.length) return null;
  return { order, pace: pace > 0 ? pace : 3 };
}

/** Save a custom plan (ordered book names + chapters/day) and start it today. */
function setPlanConfig({ order, pace, start }) {
  setMeta('plan_books', JSON.stringify(order || []));
  setMeta('plan_pace', String(pace || 3));
  if (start) setMeta('plan_start', start);
  return { ok: true };
}

/** Revert to the default whole-Bible plan. */
function clearPlanConfig(start) {
  setMeta('plan_books', '');
  setMeta('plan_pace', '');
  if (start) setMeta('plan_start', start);
  return { ok: true };
}

/** Wipe reading history and restart the plan at Day 1 (today). Bookmarks are kept. */
function resetProgress(today) {
  db.prepare(`DELETE FROM sessions`).run();
  setMeta('plan_start', today);
  return { ok: true, planStart: today };
}

/* ---------------- sessions ---------------- */

function logSession({ date, chapters, seconds }) {
  const info = db
    .prepare(`INSERT INTO sessions (date, chapters, seconds, created_at) VALUES (?, ?, ?, ?)`)
    .run(date, JSON.stringify(chapters || []), Math.max(0, Math.round(seconds || 0)), new Date().toISOString());
  return info.lastInsertRowid;
}

function isDateComplete(date) {
  return !!db.prepare(`SELECT 1 FROM sessions WHERE date = ? LIMIT 1`).get(date);
}

function getCompletedDates() {
  return db.prepare(`SELECT DISTINCT date FROM sessions ORDER BY date ASC`).all().map((r) => r.date);
}

/** All distinct "Book Chapter" strings ever read. */
function getAllReadChapters() {
  const set = new Set();
  for (const r of db.prepare(`SELECT chapters FROM sessions`).all()) {
    try { JSON.parse(r.chapters).forEach((c) => set.add(c)); } catch { /* ignore */ }
  }
  return [...set];
}

/** Mark a set of "Book Chapter" labels as read (logged under `today`). */
function markChaptersRead(labels, today) {
  if (!labels || !labels.length) return { ok: false };
  logSession({ date: today, chapters: labels, seconds: 0 });
  return { ok: true };
}

/** Remove a set of "Book Chapter" labels from all reading history. */
function removeReadChapters(labels) {
  const set = new Set(labels);
  const rows = db.prepare(`SELECT id, chapters FROM sessions`).all();
  const upd = db.prepare(`UPDATE sessions SET chapters = ? WHERE id = ?`);
  const tx = db.transaction(() => {
    for (const r of rows) {
      let arr;
      try { arr = JSON.parse(r.chapters); } catch { arr = []; }
      const filtered = arr.filter((c) => !set.has(c));
      if (filtered.length !== arr.length) upd.run(JSON.stringify(filtered), r.id);
    }
  });
  tx();
  return { ok: true };
}

/** Distinct "Book Chapter" strings read on a given date. */
function getChaptersReadOn(date) {
  const rows = db.prepare(`SELECT chapters FROM sessions WHERE date = ?`).all(date);
  const set = new Set();
  for (const r of rows) {
    try {
      JSON.parse(r.chapters).forEach((c) => set.add(c));
    } catch { /* ignore */ }
  }
  return [...set];
}

function getStats(today) {
  const completedList = getCompletedDates();
  const completed = new Set(completedList);
  const totalSessions = db.prepare(`SELECT COUNT(*) n FROM sessions`).get().n;
  const first = completedList[0] || null;

  // distinct chapters ever read
  const chapterSet = new Set();
  for (const r of db.prepare(`SELECT chapters FROM sessions`).all()) {
    try { JSON.parse(r.chapters).forEach((c) => chapterSet.add(c)); } catch { /* ignore */ }
  }

  // current streak (allow today to still be pending)
  let streak = 0;
  const cursor = new Date(today + 'T00:00:00');
  if (!completed.has(today)) cursor.setDate(cursor.getDate() - 1);
  while (completed.has(toISODate(cursor))) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }

  // longest streak across all history
  let longest = 0;
  let run = 0;
  let prev = null;
  for (const d of completedList) {
    if (prev && dayDiff(prev, d) === 1) run++;
    else run = 1;
    if (run > longest) longest = run;
    prev = d;
  }

  return {
    streak,
    longestStreak: longest,
    chaptersRead: chapterSet.size,
    totalSessions,
    daysCompleted: completed.size,
    firstDate: first,
    completedDates: completedList,
  };
}

/* ---------------- bookmarks ---------------- */

function toggleBookmark({ book, chapter, verse, text }) {
  const ref = `${book} ${chapter}:${verse}`;
  const exists = db.prepare(`SELECT 1 FROM bookmarks WHERE ref = ?`).get(ref);
  if (exists) {
    db.prepare(`DELETE FROM bookmarks WHERE ref = ?`).run(ref);
    return { ref, bookmarked: false };
  }
  db.prepare(
    `INSERT INTO bookmarks (ref, book, chapter, verse, text, created_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(ref, book, chapter, verse, text, new Date().toISOString());
  return { ref, bookmarked: true };
}

function removeBookmark(ref) {
  db.prepare(`DELETE FROM bookmarks WHERE ref = ?`).run(ref);
  return { ok: true };
}

function getBookmarks() {
  return db.prepare(`SELECT ref, book, chapter, verse, text, created_at FROM bookmarks ORDER BY created_at DESC`).all();
}

/* ---------------- helpers ---------------- */

function toISODate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function dayDiff(aISO, bISO) {
  const a = new Date(aISO + 'T00:00:00');
  const b = new Date(bISO + 'T00:00:00');
  return Math.round((b - a) / 86400000);
}

module.exports = {
  init,
  logSession,
  isDateComplete,
  getCompletedDates,
  getChaptersReadOn,
  getAllReadChapters,
  markChaptersRead,
  removeReadChapters,
  getStats,
  toggleBookmark,
  removeBookmark,
  getBookmarks,
  getMeta,
  setMeta,
  getPlanStart,
  setPlanStart,
  getPlanConfig,
  setPlanConfig,
  clearPlanConfig,
  resetProgress,
};
