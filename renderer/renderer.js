/* global window, document, localStorage */
const svc = window.api;

const OT_BOOKS = 39; // Genesis..Malachi
const FONT_MIN = 16;
const FONT_MAX = 30;
const LS_FONT = 'db_font';
const LS_LAST = 'db_last';

const state = {
  bible: null,
  headings: {},         // book -> chapter -> verse -> heading text
  bookIndex: new Map(), // book name -> index
  plan: null,           // { date, day, chapters: [{book, chapter}] }
  bookIdx: 0,
  chapter: 1,
  fontSize: 19.5,
  bookmarks: new Set(), // refs "Book Chapter:Verse"
  calMonth: { year: new Date().getFullYear(), month: new Date().getMonth() },
  lastStats: null,
};

// ---------- helpers ----------
const $ = (id) => document.getElementById(id);
const label = (bookIdx, chapter) => `${state.bible.books[bookIdx].name} ${chapter}`;
const parseISO = (s) => new Date(s + 'T00:00:00');
const toISO = (d) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};
function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => (t.hidden = true), 2600);
}

// ---------- init ----------
async function init() {
  state.bible = await svc.getBible();
  state.headings = (await svc.getHeadings()) || {};
  state.bible.books.forEach((b, i) => state.bookIndex.set(b.name, i));

  state.fontSize = clampFont(parseFloat(localStorage.getItem(LS_FONT)) || 19.5);
  await loadBookmarks();

  populateBookSelect();
  wireControls();

  state.plan = await svc.getTodayPlan();

  // continue where you left off, else today's first plan chapter, else Genesis 1
  const last = readLastPosition();
  if (last) {
    state.bookIdx = last.bookIdx;
    state.chapter = last.chapter;
  } else {
    const first = state.plan.chapters[0];
    if (first && state.bookIndex.has(first.book)) {
      state.bookIdx = state.bookIndex.get(first.book);
      state.chapter = first.chapter;
    }
  }

  renderChapter();
  renderPlanChips();
  await refreshStats();
  await updateTodayStrip();
  await setupModal();

  svc.onDataChanged(async () => {
    await refreshStats();
    await updateTodayStrip();
    await refreshModalDone();
    if (!$('view-plan').hidden) await renderPlanView();
  });
  svc.onNavigate((view) => switchView(view));
}

// ---------- book / chapter selectors ----------
function populateBookSelect() {
  const sel = $('bookSelect');
  sel.innerHTML = '';
  const ot = document.createElement('optgroup');
  ot.label = 'Old Testament';
  const nt = document.createElement('optgroup');
  nt.label = 'New Testament';
  state.bible.books.forEach((b, i) => {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = b.name;
    (i < OT_BOOKS ? ot : nt).appendChild(opt);
  });
  sel.appendChild(ot);
  sel.appendChild(nt);
}

function populateChapterSelect() {
  const sel = $('chapterSelect');
  const count = state.bible.books[state.bookIdx].chapters.length;
  sel.innerHTML = '';
  for (let c = 1; c <= count; c++) {
    const opt = document.createElement('option');
    opt.value = c;
    opt.textContent = c;
    sel.appendChild(opt);
  }
}

function renderChapter() {
  const book = state.bible.books[state.bookIdx];
  if (state.chapter > book.chapters.length) state.chapter = book.chapters.length;
  if (state.chapter < 1) state.chapter = 1;

  $('bookSelect').value = state.bookIdx;
  populateChapterSelect();
  $('chapterSelect').value = state.chapter;
  $('chapterTitle').textContent = `${book.name} ${state.chapter}`;

  const verses = book.chapters[state.chapter - 1] || [];
  const chHeadings = (state.headings[book.name] && state.headings[book.name][state.chapter]) || null;
  const body = $('chapterBody');
  body.style.fontSize = state.fontSize + 'px';
  body.innerHTML = '';
  verses.forEach((text, i) => {
    const verseNo = i + 1;
    const ref = `${book.name} ${state.chapter}:${verseNo}`;
    if (chHeadings && chHeadings[verseNo]) {
      const h = document.createElement('h3');
      h.className = 'section-heading';
      h.textContent = chHeadings[verseNo];
      body.appendChild(h);
    }
    const span = document.createElement('span');
    span.className = 'verse' + (state.bookmarks.has(ref) ? ' bookmarked' : '');
    span.id = 'verse-' + verseNo;
    const num = document.createElement('span');
    num.className = 'verse-num';
    num.textContent = verseNo;
    num.title = 'Click to bookmark';
    num.addEventListener('click', () => toggleBookmark(verseNo, text));
    span.appendChild(num);
    span.appendChild(document.createTextNode(text + ' '));
    body.appendChild(span);
  });
  document.querySelector('.reader').scrollTop = 0;

  saveLastPosition();
  highlightPlanChip();
}

function goToChapter(bookIdx, chapter) {
  state.bookIdx = bookIdx;
  state.chapter = chapter;
  renderChapter();
}

function stepChapter(delta) {
  let bi = state.bookIdx;
  let ch = state.chapter + delta;
  const books = state.bible.books;
  if (ch < 1) {
    bi = (bi - 1 + books.length) % books.length;
    ch = books[bi].chapters.length;
  } else if (ch > books[bi].chapters.length) {
    bi = (bi + 1) % books.length;
    ch = 1;
  }
  goToChapter(bi, ch);
}

// ---------- last position + font ----------
function saveLastPosition() {
  try { localStorage.setItem(LS_LAST, JSON.stringify({ bookIdx: state.bookIdx, chapter: state.chapter })); } catch { /* ignore */ }
}
function readLastPosition() {
  try {
    const v = JSON.parse(localStorage.getItem(LS_LAST));
    if (v && Number.isInteger(v.bookIdx) && v.bookIdx >= 0 && v.bookIdx < state.bible.books.length) {
      const maxCh = state.bible.books[v.bookIdx].chapters.length;
      if (v.chapter >= 1 && v.chapter <= maxCh) return v;
    }
  } catch { /* ignore */ }
  return null;
}
function clampFont(v) { return Math.min(FONT_MAX, Math.max(FONT_MIN, v)); }
function setFont(delta) {
  state.fontSize = clampFont(state.fontSize + delta);
  $('chapterBody').style.fontSize = state.fontSize + 'px';
  try { localStorage.setItem(LS_FONT, String(state.fontSize)); } catch { /* ignore */ }
}

// ---------- bookmarks ----------
async function loadBookmarks() {
  const list = await svc.getBookmarks();
  state.bookmarks = new Set(list.map((b) => b.ref));
  return list;
}
async function toggleBookmark(verseNo, text) {
  const book = state.bible.books[state.bookIdx].name;
  const res = await svc.toggleBookmark({ book, chapter: state.chapter, verse: verseNo, text });
  if (res.bookmarked) state.bookmarks.add(res.ref);
  else state.bookmarks.delete(res.ref);
  const el = $('verse-' + verseNo);
  if (el) el.classList.toggle('bookmarked', res.bookmarked);
  toast(res.bookmarked ? `Bookmarked ${res.ref}` : `Removed bookmark`);
}

async function renderBookmarksView() {
  const list = await loadBookmarks();
  const wrap = $('bookmarksList');
  wrap.innerHTML = '';
  $('bookmarksEmpty').hidden = list.length > 0;
  list.forEach((b) => {
    const row = document.createElement('div');
    row.className = 'bookmark';
    const main = document.createElement('div');
    main.className = 'bookmark-main';
    main.innerHTML = `<div class="bookmark-ref">${escapeHtml(b.ref)}</div><div class="bookmark-text">${escapeHtml(b.text)}</div>`;
    main.addEventListener('click', () => openReference(b.book, b.chapter, b.verse));
    const rm = document.createElement('button');
    rm.className = 'bookmark-remove';
    rm.textContent = '×';
    rm.title = 'Remove bookmark';
    rm.addEventListener('click', async () => {
      await svc.removeBookmark(b.ref);
      state.bookmarks.delete(b.ref);
      renderBookmarksView();
    });
    row.appendChild(main);
    row.appendChild(rm);
    wrap.appendChild(row);
  });
}

// ---------- open a reference (from search / bookmarks) ----------
function openReference(book, chapter, verse) {
  if (!state.bookIndex.has(book)) return;
  goToChapter(state.bookIndex.get(book), chapter);
  switchView('read');
  if (verse) flashVerse(verse);
}
function flashVerse(verseNo) {
  requestAnimationFrame(() => {
    const el = $('verse-' + verseNo);
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1300);
  });
}

// ---------- search ----------
function runSearch() {
  const q = $('searchInput').value.trim();
  const results = $('searchResults');
  const meta = $('searchMeta');
  if (q.length < 2) {
    meta.textContent = 'Type at least 2 characters.';
    results.innerHTML = '';
    return;
  }
  const ql = q.toLowerCase();
  const CAP = 300;
  const found = [];
  const books = state.bible.books;
  outer:
  for (let bi = 0; bi < books.length; bi++) {
    const chs = books[bi].chapters;
    for (let ci = 0; ci < chs.length; ci++) {
      const vs = chs[ci];
      for (let vi = 0; vi < vs.length; vi++) {
        if (vs[vi].toLowerCase().includes(ql)) {
          found.push({ book: books[bi].name, chapter: ci + 1, verse: vi + 1, text: vs[vi] });
          if (found.length >= CAP) break outer;
        }
      }
    }
  }
  meta.textContent = found.length
    ? `${found.length}${found.length >= CAP ? '+' : ''} verse${found.length === 1 ? '' : 's'} for “${q}”`
    : `No verses found for “${q}”.`;

  const re = new RegExp(escapeRegex(escapeHtml(q)), 'gi');
  results.innerHTML = '';
  found.forEach((r) => {
    const div = document.createElement('div');
    div.className = 'result';
    const text = escapeHtml(r.text).replace(re, (m) => `<mark>${m}</mark>`);
    div.innerHTML = `<div class="result-ref">${escapeHtml(r.book)} ${r.chapter}:${r.verse}</div><div class="result-text">${text}</div>`;
    div.addEventListener('click', () => openReference(r.book, r.chapter, r.verse));
    results.appendChild(div);
  });
}

// ---------- today's plan + strip ----------
function renderPlanChips() {
  const wrap = $('planChips');
  wrap.innerHTML = '';
  state.plan.chapters.forEach((c) => {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.textContent = `${c.book} ${c.chapter}`;
    chip.dataset.book = c.book;
    chip.dataset.chapter = c.chapter;
    chip.addEventListener('click', () => {
      if (state.bookIndex.has(c.book)) goToChapter(state.bookIndex.get(c.book), c.chapter);
    });
    wrap.appendChild(chip);
  });
  highlightPlanChip();
}

function highlightPlanChip() {
  const cur = label(state.bookIdx, state.chapter);
  document.querySelectorAll('#planChips .chip').forEach((chip) => {
    chip.classList.toggle('is-current', `${chip.dataset.book} ${chip.dataset.chapter}` === cur);
  });
}

async function updateTodayStrip() {
  const planLabels = state.plan.chapters.map((c) => `${c.book} ${c.chapter}`);
  const readList = new Set(await svc.getChaptersReadToday());
  const readCount = planLabels.filter((l) => readList.has(l)).length;
  const total = planLabels.length;
  const status = await svc.getTodayStatus();

  const pct = total ? Math.round((readCount / total) * 100) : 0;
  $('todayProgressBar').style.width = (status.complete ? 100 : pct) + '%';
  $('todayProgressText').textContent = status.complete
    ? "Today's reading complete"
    : `Today's plan · ${readCount}/${total} chapters read`;
  $('markCompleteBtn').hidden = status.complete;
  $('todayDoneBadge').hidden = !status.complete;
}

// ---------- reading completion ----------
async function markChapterRead() {
  const ref = label(state.bookIdx, state.chapter);
  await svc.logSession({ date: state.plan.date, chapters: [ref], seconds: 0 });
  await refreshStats();
  await updateTodayStrip();
  await refreshModalDone();
  toast(`Marked ${ref} as read`);
}

async function markComplete() {
  await svc.markTodayComplete();
  await refreshStats();
  await updateTodayStrip();
  await refreshModalDone();
  toast("Today marked complete ✓");
}

async function resetProgress() {
  const ok = await showConfirm({
    title: 'Reset all progress?',
    message:
      'This clears your streak, calendar and reading history, and restarts the plan at Day 1. Your bookmarks are kept.',
    confirmLabel: 'Reset progress',
    danger: true,
  });
  if (!ok) return;
  await svc.resetProgress();
  await reloadPlanAndStats();
  toast('Progress reset — starting at Day 1');
}

async function applyStartDate() {
  const val = $('startDateInput').value;
  if (!val) {
    toast('Pick a start date first');
    return;
  }
  await svc.setPlanStart(val);
  await reloadPlanAndStats();
  toast(`Start date updated — you're on Day ${state.plan.day}`);
}

// Re-fetch the plan and refresh everything that depends on it.
async function reloadPlanAndStats() {
  state.plan = await svc.getTodayPlan();
  renderPlanChips();
  await refreshStats();
  await updateTodayStrip();
  await refreshModalDone();
  if (!$('view-plan').hidden) await renderPlanView();
}

// ---------- plan builder ----------
const planEditor = { order: [], pace: 3 };
const planExpanded = new Set(); // book names currently expanded in the Plan view

function chapterCountOf(name) {
  const i = state.bookIndex.get(name);
  return i == null ? 0 : state.bible.books[i].chapters.length;
}

function presetOrder(key) {
  const names = state.bible.books.map((b) => b.name);
  switch (key) {
    case 'nt': return names.slice(OT_BOOKS);
    case 'ot': return names.slice(0, OT_BOOKS);
    case 'gospels': return names.slice(OT_BOOKS, OT_BOOKS + 4);
    case 'torah': return names.slice(0, 5);
    case 'wisdom': return ['Psalms', 'Proverbs'].filter((n) => state.bookIndex.has(n));
    default: return [];
  }
}

function populatePlanBookSelect() {
  const sel = $('planBookSelect');
  sel.innerHTML = '';
  const ot = document.createElement('optgroup');
  ot.label = 'Old Testament';
  const nt = document.createElement('optgroup');
  nt.label = 'New Testament';
  state.bible.books.forEach((b, i) => {
    const opt = document.createElement('option');
    opt.value = b.name;
    opt.textContent = b.name;
    (i < OT_BOOKS ? ot : nt).appendChild(opt);
  });
  sel.appendChild(ot);
  sel.appendChild(nt);
}

function openPlanBuilder() {
  const cfg = state.plan && state.plan.config;
  planEditor.order = cfg && cfg.order ? [...cfg.order] : [];
  planEditor.pace = cfg && cfg.pace ? cfg.pace : 3;
  populatePlanBookSelect();
  $('planPaceSelect').value = String(planEditor.pace);
  renderPlanEditor();
  $('planModal').hidden = false;
}

function closePlanBuilder() { $('planModal').hidden = true; }

function renderPlanEditor() {
  const wrap = $('planOrder');
  wrap.innerHTML = '';
  planEditor.order.forEach((name, idx) => {
    const row = document.createElement('div');
    row.className = 'plan-row';
    row.innerHTML =
      `<span class="plan-row-idx">${idx + 1}</span>` +
      `<span class="plan-row-name">${escapeHtml(name)}</span>` +
      `<span class="plan-row-meta">${chapterCountOf(name)} ch</span>`;
    const btns = document.createElement('span');
    btns.className = 'plan-row-btns';
    btns.appendChild(iconBtn('↑', 'Move up', idx === 0, () => movePlanBook(idx, -1)));
    btns.appendChild(iconBtn('↓', 'Move down', idx === planEditor.order.length - 1, () => movePlanBook(idx, 1)));
    btns.appendChild(iconBtn('✕', 'Remove', false, () => removePlanBook(idx), 'rm'));
    row.appendChild(btns);
    wrap.appendChild(row);
  });
  $('planOrderEmpty').hidden = planEditor.order.length > 0;
  $('planOrderCount').textContent = planEditor.order.length ? `(${planEditor.order.length} books)` : '';
  updatePlanSummary();
}

function iconBtn(label, title, disabled, onClick, extra = '') {
  const b = document.createElement('button');
  b.className = 'plan-icon-btn' + (extra ? ' ' + extra : '');
  b.textContent = label;
  b.title = title;
  b.disabled = disabled;
  if (!disabled) b.addEventListener('click', onClick);
  return b;
}

function updatePlanSummary() {
  const total = planEditor.order.reduce((n, name) => n + chapterCountOf(name), 0);
  if (!total) { $('planSummary').textContent = 'No books selected yet'; return; }
  const pace = planEditor.pace;
  const days = Math.max(1, Math.ceil(total / pace));
  $('planSummary').textContent = `${total} chapters · ${days} day${days === 1 ? '' : 's'} at ${pace}/day`;
}

function addPlanBook() {
  const name = $('planBookSelect').value;
  if (!name) return;
  if (planEditor.order.includes(name)) { toast(`${name} is already in your plan`); return; }
  planEditor.order.push(name);
  renderPlanEditor();
}
function movePlanBook(idx, dir) {
  const j = idx + dir;
  if (j < 0 || j >= planEditor.order.length) return;
  const o = planEditor.order;
  [o[idx], o[j]] = [o[j], o[idx]];
  renderPlanEditor();
}
function removePlanBook(idx) {
  planEditor.order.splice(idx, 1);
  renderPlanEditor();
}
function applyPreset(key) {
  planEditor.order = presetOrder(key);
  renderPlanEditor();
}

async function savePlan() {
  if (!planEditor.order.length) { toast('Add at least one book first'); return; }
  await svc.savePlan({ order: planEditor.order, pace: planEditor.pace });
  await reloadPlanAndStats();
  jumpToPlanStart();
  closePlanBuilder();
  toast('Plan saved — starting today at Day 1');
}
async function useDefaultPlan() {
  await svc.clearPlan();
  await reloadPlanAndStats();
  jumpToPlanStart();
  closePlanBuilder();
  toast('Using the whole Bible (1 year)');
}
function jumpToPlanStart() {
  const first = state.plan.chapters[0];
  if (first && state.bookIndex.has(first.book)) {
    goToChapter(state.bookIndex.get(first.book), first.chapter);
    switchView('read');
  }
}

// ---------- plan view (books + per-book progress) ----------
function planBookOrder() {
  const cfg = state.plan && state.plan.config;
  return cfg && cfg.order && cfg.order.length ? cfg.order : state.bible.books.map((b) => b.name);
}

async function renderPlanView() {
  const readSet = new Set(await svc.getReadChapters());
  const order = planBookOrder();
  const isCustom = !!(state.plan && state.plan.config && state.plan.config.order && state.plan.config.order.length);

  let total = 0;
  let read = 0;
  order.forEach((name) => {
    const idx = state.bookIndex.get(name);
    if (idx == null) return;
    const n = state.bible.books[idx].chapters.length;
    total += n;
    for (let c = 1; c <= n; c++) if (readSet.has(`${name} ${c}`)) read++;
  });
  const pctAll = total ? Math.round((read / total) * 100) : 0;
  $('planViewSub').textContent =
    `${isCustom ? 'Custom plan' : 'Whole Bible'} · ${order.length} books · ${read} / ${total} chapters read · ${pctAll}%`;

  const wrap = $('planBooks');
  wrap.innerHTML = '';
  order.forEach((name) => {
    const idx = state.bookIndex.get(name);
    if (idx == null) return;
    const n = state.bible.books[idx].chapters.length;
    let rc = 0;
    for (let c = 1; c <= n; c++) if (readSet.has(`${name} ${c}`)) rc++;
    const pct = Math.round((rc / n) * 100);
    const complete = rc === n;

    const card = document.createElement('div');
    card.className = 'book-card' + (complete ? ' complete' : '');

    const expanded = planExpanded.has(name);

    const head = document.createElement('div');
    head.className = 'book-card-head';
    head.innerHTML =
      `<div class="book-title-wrap"><span class="book-chevron">${expanded ? '▾' : '▸'}</span>` +
      `<span class="book-name">${escapeHtml(name)}</span>` +
      `<span class="book-progress-text">${rc} / ${n} chapters${complete ? ' ✓' : ''}</span></div>`;
    const btn = document.createElement('button');
    btn.className = 'btn btn-sm' + (complete ? '' : ' btn-success');
    btn.textContent = complete ? 'Clear' : 'Mark complete';
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const labels = [];
      for (let c = 1; c <= n; c++) labels.push(`${name} ${c}`);
      if (complete) await svc.unmarkChapters(labels);
      else await svc.markChaptersRead(labels);
      await renderPlanView();
      await refreshStats();
      await updateTodayStrip();
      toast(complete ? `Cleared ${name}` : `Marked ${name} complete`);
    });
    head.appendChild(btn);
    card.appendChild(head);

    const bar = document.createElement('div');
    bar.className = 'book-bar';
    bar.innerHTML = `<div class="book-bar-fill" style="width:${pct}%"></div>`;
    card.appendChild(bar);

    const dots = document.createElement('div');
    dots.className = 'chapter-dots';
    dots.hidden = !expanded;
    for (let c = 1; c <= n; c++) {
      const dot = document.createElement('button');
      dot.className = 'cdot' + (readSet.has(`${name} ${c}`) ? ' done' : '');
      dot.textContent = c;
      dot.title = `Open ${name} ${c}`;
      dot.addEventListener('click', () => openReference(name, c));
      dots.appendChild(dot);
    }
    card.appendChild(dots);

    head.addEventListener('click', () => {
      const nowOn = !planExpanded.has(name);
      if (nowOn) planExpanded.add(name);
      else planExpanded.delete(name);
      dots.hidden = !nowOn;
      const chev = head.querySelector('.book-chevron');
      if (chev) chev.textContent = nowOn ? '▾' : '▸';
    });

    wrap.appendChild(card);
  });
}

// Reusable "Are you sure?" dialog. Resolves true/false.
function showConfirm({ title, message, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    $('confirmTitle').textContent = title;
    $('confirmMsg').textContent = message;
    const ok = $('confirmOk');
    const cancel = $('confirmCancel');
    ok.textContent = confirmLabel;
    ok.className = 'btn ' + (danger ? 'btn-danger-solid' : 'btn-primary');
    const modal = $('confirmModal');
    modal.hidden = false;
    const done = (val) => {
      modal.hidden = true;
      ok.onclick = null;
      cancel.onclick = null;
      resolve(val);
    };
    ok.onclick = () => done(true);
    cancel.onclick = () => done(false);
  });
}

// ---------- stats + calendar ----------
async function refreshStats() {
  const stats = await svc.getStats();
  $('streakNum').textContent = stats.streak;
  $('statStreak').textContent = stats.streak;
  $('statLongest').textContent = stats.longestStreak;
  $('statDays').textContent = stats.daysCompleted;
  $('statChapters').textContent = stats.chaptersRead;

  // plan progress
  const day = state.plan ? state.plan.day : 1;
  const totalDays = state.plan ? state.plan.totalDays || 365 : 365;
  const pct = Math.round((day / totalDays) * 100);
  $('planProgressLabel').textContent = `Day ${day} of ${totalDays} · ${pct}%`;
  $('planProgressBar').style.width = pct + '%';
  if (state.plan) {
    $('startDateInput').value = state.plan.start;
    $('startDateInput').max = state.plan.date;
  }

  $('calendarNote').textContent = `${stats.daysCompleted} day${stats.daysCompleted === 1 ? '' : 's'} completed · ${stats.totalSessions} session${stats.totalSessions === 1 ? '' : 's'}`;
  buildCalendar(stats);
}

function buildCalendar(stats) {
  state.lastStats = stats;
  renderMonth();
}

function renderMonth() {
  const stats = state.lastStats;
  if (!stats) return;
  const completed = new Set(stats.completedDates);
  const todayStr = state.plan ? state.plan.date : toISO(new Date());
  const first = stats.firstDate || todayStr;
  const { year, month } = state.calMonth;

  $('calMonthLabel').textContent = new Date(year, month, 1).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  });

  const grid = $('monthGrid');
  grid.innerHTML = '';
  const firstDow = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  for (let i = 0; i < firstDow; i++) {
    const c = document.createElement('div');
    c.className = 'mcell blank';
    grid.appendChild(c);
  }
  for (let d = 1; d <= daysInMonth; d++) {
    const iso = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const cell = document.createElement('div');
    cell.className = 'mcell';
    const num = document.createElement('span');
    num.className = 'mday';
    num.textContent = d;
    cell.appendChild(num);
    if (completed.has(iso)) {
      cell.classList.add('done');
      const chk = document.createElement('span');
      chk.className = 'mcheck';
      chk.textContent = '✓';
      cell.appendChild(chk);
      cell.title = `${iso} — reading done`;
    } else if (iso < todayStr && iso >= first) {
      cell.classList.add('miss');
      cell.title = `${iso} — missed`;
    } else {
      cell.title = iso;
    }
    if (iso === todayStr) cell.classList.add('today');
    grid.appendChild(cell);
  }
  const total = firstDow + daysInMonth;
  const trailing = (7 - (total % 7)) % 7;
  for (let i = 0; i < trailing; i++) {
    const c = document.createElement('div');
    c.className = 'mcell blank';
    grid.appendChild(c);
  }
}

function shiftMonth(delta) {
  let { year, month } = state.calMonth;
  month += delta;
  if (month < 0) { month = 11; year--; }
  else if (month > 11) { month = 0; year++; }
  state.calMonth = { year, month };
  renderMonth();
}

// ---------- modal ----------
async function setupModal() {
  const d = parseISO(state.plan.date);
  $('modalDate').textContent = d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  $('modalSub').textContent = `Day ${state.plan.day} · ${state.plan.chapters.length} chapters`;

  const wrap = $('modalChapters');
  wrap.innerHTML = '';
  state.plan.chapters.forEach((c) => {
    const el = document.createElement('button');
    el.className = 'modal-chapter';
    el.textContent = `${c.book} ${c.chapter}`;
    el.addEventListener('click', () => {
      if (state.bookIndex.has(c.book)) goToChapter(state.bookIndex.get(c.book), c.chapter);
      hideModal();
    });
    wrap.appendChild(el);
  });

  $('startReadingBtn').addEventListener('click', () => {
    const first = state.plan.chapters[0];
    if (first && state.bookIndex.has(first.book)) goToChapter(state.bookIndex.get(first.book), first.chapter);
    hideModal();
  });
  $('browseBtn').addEventListener('click', hideModal);

  await refreshModalDone();
  $('modal').hidden = false;
}
async function refreshModalDone() {
  const status = await svc.getTodayStatus();
  $('modalDone').hidden = !status.complete;
  $('startReadingBtn').textContent = status.complete ? 'Read again' : 'Start Reading';
}
function hideModal() { $('modal').hidden = true; }

// ---------- views ----------
function switchView(view) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.view === view));
  ['read', 'search', 'plan', 'bookmarks', 'progress'].forEach((v) => {
    const el = $('view-' + v);
    if (el) el.hidden = v !== view;
  });
  if (view === 'progress') refreshStats();
  if (view === 'plan') renderPlanView();
  if (view === 'bookmarks') renderBookmarksView();
  if (view === 'search') $('searchInput').focus();
}

// ---------- wiring ----------
function wireControls() {
  $('bookSelect').addEventListener('change', (e) => { state.bookIdx = parseInt(e.target.value, 10); state.chapter = 1; renderChapter(); });
  $('chapterSelect').addEventListener('change', (e) => { state.chapter = parseInt(e.target.value, 10); renderChapter(); });
  $('prevChapter').addEventListener('click', () => stepChapter(-1));
  $('nextChapter').addEventListener('click', () => stepChapter(1));
  $('fontDown').addEventListener('click', () => setFont(-1.5));
  $('fontUp').addEventListener('click', () => setFont(1.5));
  $('markChapterReadBtn').addEventListener('click', markChapterRead);
  $('markCompleteBtn').addEventListener('click', markComplete);
  $('resetProgressBtn').addEventListener('click', resetProgress);
  $('setStartBtn').addEventListener('click', applyStartDate);
  $('editPlanBtn').addEventListener('click', openPlanBuilder);
  $('editPlanBtn2').addEventListener('click', openPlanBuilder);
  $('planClose').addEventListener('click', closePlanBuilder);
  $('planAddBtn').addEventListener('click', addPlanBook);
  $('planUseDefault').addEventListener('click', useDefaultPlan);
  $('planSave').addEventListener('click', savePlan);
  $('planPaceSelect').addEventListener('change', (e) => { planEditor.pace = parseInt(e.target.value, 10) || 3; updatePlanSummary(); });
  document.querySelectorAll('.preset').forEach((b) => b.addEventListener('click', () => applyPreset(b.dataset.preset)));
  $('calPrev').addEventListener('click', () => shiftMonth(-1));
  $('calNext').addEventListener('click', () => shiftMonth(1));
  $('searchBtn').addEventListener('click', runSearch);
  $('searchInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(); });

  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => switchView(t.dataset.view)));

  document.addEventListener('keydown', (e) => {
    if (!$('modal').hidden || !$('confirmModal').hidden || !$('planModal').hidden) return;
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
    if (!$('view-read').hidden) {
      if (e.key === 'ArrowLeft') stepChapter(-1);
      if (e.key === 'ArrowRight') stepChapter(1);
    }
  });
}

init().catch((err) => {
  console.error(err);
  document.body.innerHTML = '<pre style="padding:24px;color:#b0472e">Failed to start: ' + err.message + '</pre>';
});
