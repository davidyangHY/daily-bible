/* global window, document, localStorage */
const svc = window.api;

const OT_BOOKS = 39; // Genesis..Malachi
const FONT_MIN = 16;
const FONT_MAX = 30;
const LS_FONT = 'db_font';
const LS_LAST = 'db_last';
const LS_FOCUS = 'db_focus';
const LS_AIPANEL = 'db_aipanel';
let scrollRaf = 0;

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
  focus: false,
  aiReady: false,
  planSelected: null,   // book name selected in the Plan overview
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
  try { state.focus = localStorage.getItem(LS_FOCUS) === '1'; } catch { state.focus = false; }
  await loadBookmarks();
  await setupVersions();

  populateBookSelect();
  wireControls();
  $('focusToggle').classList.toggle('is-on', state.focus);

  // Study helper panel: open by default (unless the user closed it last time).
  let aiOpen = true;
  try { aiOpen = localStorage.getItem(LS_AIPANEL) !== '0'; } catch { /* ignore */ }
  if (aiOpen) openAiPanel();

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
  populateCatchup();
  renderPlanChips();
  await refreshStats();
  await updateTodayStrip();

  svc.onDataChanged(async () => {
    await refreshStats();
    await updateTodayStrip();
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
  let section = document.createElement('div');
  section.className = 'rsection';
  body.appendChild(section);
  verses.forEach((text, i) => {
    const verseNo = i + 1;
    const ref = `${book.name} ${state.chapter}:${verseNo}`;
    if (chHeadings && chHeadings[verseNo]) {
      if (section.childNodes.length > 0) {
        section = document.createElement('div');
        section.className = 'rsection';
        body.appendChild(section);
      }
      section.dataset.label = chHeadings[verseNo];
      const h = document.createElement('h3');
      h.className = 'section-heading';
      h.textContent = chHeadings[verseNo];
      section.appendChild(h);
    }
    const span = document.createElement('span');
    span.className = 'verse' + (state.bookmarks.has(ref) ? ' bookmarked' : '');
    span.id = 'verse-' + verseNo;
    const num = document.createElement('span');
    num.className = 'verse-num';
    num.textContent = verseNo;
    num.title = 'Click to bookmark';
    num.addEventListener('click', (e) => { e.stopPropagation(); toggleBookmark(verseNo, text); });
    span.appendChild(num);
    span.appendChild(document.createTextNode(text + ' '));
    if (!section.dataset.from) section.dataset.from = String(verseNo);
    section.dataset.to = String(verseNo);
    section.appendChild(span);
  });
  document.querySelectorAll('#chapterBody .rsection').forEach((s) => {
    const explain = document.createElement('button');
    explain.className = 'rsection-explain';
    explain.innerHTML = '✦ Explain';
    explain.title = 'Explain this section with the study helper';
    explain.addEventListener('click', (e) => { e.stopPropagation(); explainSection(s); });
    s.appendChild(explain);
    s.addEventListener('click', () => { if (state.focus) setActiveSection(s); });
  });
  document.querySelector('.reader').scrollTop = 0;

  applyFocus();
  saveLastPosition();
  highlightPlanChip();
}

// ---------- versions ----------
async function setupVersions() {
  const info = await svc.getVersions();
  const sel = $('versionSelect');
  sel.innerHTML = '';
  info.available.forEach((v) => {
    const o = document.createElement('option');
    o.value = v.id;
    o.textContent = v.id;
    o.title = v.name;
    sel.appendChild(o);
  });
  sel.value = info.current;
}

async function changeVersion(id) {
  await svc.setVersion(id);
  state.bible = await svc.getBible();
  renderChapter();
  toast(`Switched to ${id}`);
}

// ---------- focus mode ----------
function applyFocus() {
  document.body.classList.toggle('focus-on', state.focus);
  if (state.focus) updateActiveSection();
  else document.querySelectorAll('#chapterBody .rsection.active').forEach((s) => s.classList.remove('active'));
}

function setActiveSection(target) {
  document.querySelectorAll('#chapterBody .rsection').forEach((s) => s.classList.toggle('active', s === target));
}

function updateActiveSection() {
  const reader = document.querySelector('.reader');
  const sections = [...document.querySelectorAll('#chapterBody .rsection')];
  if (!sections.length) return;
  const line = reader.getBoundingClientRect().top + reader.clientHeight * 0.28;
  let active = sections[0];
  for (const s of sections) {
    if (s.getBoundingClientRect().top <= line) active = s;
    else break;
  }
  sections.forEach((s) => s.classList.toggle('active', s === active));
}

function toggleFocus() {
  state.focus = !state.focus;
  $('focusToggle').classList.toggle('is-on', state.focus);
  try { localStorage.setItem(LS_FOCUS, state.focus ? '1' : '0'); } catch { /* ignore */ }
  applyFocus();
}

// ---------- AI study helper ----------
function currentBookName() {
  return state.bible.books[state.bookIdx].name;
}

function isAiPanelOpen() { return document.body.classList.contains('ai-open'); }
function openAiPanel() {
  document.body.classList.add('ai-open');
  $('studyBtn').classList.add('is-on');
  try { localStorage.setItem(LS_AIPANEL, '1'); } catch { /* ignore */ }
  refreshAiPanel();
}
function closeAiPanel() {
  document.body.classList.remove('ai-open');
  $('studyBtn').classList.remove('is-on');
  try { localStorage.setItem(LS_AIPANEL, '0'); } catch { /* ignore */ }
}
function toggleAiPanel() { isAiPanelOpen() ? closeAiPanel() : openAiPanel(); }

async function refreshAiPanel() {
  const st = await svc.aiStatus();
  state.aiReady = !!st.ready;
  $('aiSetup').hidden = st.ready;
  $('aiMain').hidden = !st.ready;
  if (!st.ready) showSetup(st);
}

function showSetup(st) {
  $('aiSetup').hidden = false;
  renderOllamaPanel(st.ollama);
}

function renderOllamaPanel(oll) {
  const running = !!(oll && oll.running);
  const hasModels = running && oll.models.length > 0;
  $('aiOllamaRunning').hidden = !hasModels;
  $('aiOllamaMissing').hidden = running;

  const installBtn = $('aiOllamaInstall');
  if (!running) {
    installBtn.hidden = false;
    installBtn.textContent = 'Install automatically';
  } else if (!hasModels) {
    installBtn.hidden = false;
    installBtn.textContent = 'Download model (llama3.2)';
    $('aiOllamaMsg').textContent = '';
  } else {
    installBtn.hidden = true;
    const sel = $('aiOllamaModel');
    sel.innerHTML = '';
    oll.models.forEach((m) => {
      const o = document.createElement('option');
      o.value = m;
      o.textContent = m;
      sel.appendChild(o);
    });
    if (oll.model && oll.models.includes(oll.model)) sel.value = oll.model;
    $('aiOllamaMsg').textContent = '';
  }
}

async function recheckOllama() {
  renderOllamaPanel((await svc.aiStatus()).ollama);
}

function setInstallUi(s) {
  const box = $('aiInstallBox');
  if (box.hidden) box.hidden = false;
  $('aiInstallBar').style.width = (s.percent || 0) + '%';
  $('aiInstallMsg').textContent = s.message || '';
  $('aiInstallBar').classList.toggle('is-error', s.phase === 'error');
}

async function autoInstallOllama() {
  const btn = $('aiOllamaInstall');
  btn.disabled = true;
  $('aiInstallBox').hidden = false;
  setInstallUi({ percent: 3, message: 'Starting…' });
  const res = await svc.aiAutoSetup();
  btn.disabled = false;
  if (res && res.ok) {
    $('aiInstallBox').hidden = true;
    refreshAiPanel();
  }
  // On failure the progress message already shows the error.
}

async function saveOllamaModel() {
  const model = $('aiOllamaModel').value;
  if (!model) { $('aiOllamaMsg').textContent = 'Pull a model first, then re-check.'; return; }
  await svc.aiSetOllamaModel(model);
  refreshAiPanel();
}

async function openAiSettings() {
  state.aiReady = false;
  $('aiMain').hidden = true;
  showSetup(await svc.aiStatus());
}

function aiCard(label, text) {
  const el = document.createElement('div');
  el.className = 'ai-entry';
  const lab = document.createElement('div');
  lab.className = 'ai-entry-label';
  lab.textContent = label;
  const body = document.createElement('div');
  body.className = 'ai-entry-body';
  body.textContent = text;
  el.appendChild(lab);
  el.appendChild(body);
  return { el, setText: (t) => { body.textContent = t; } };
}

function hidePanelEmpty() {
  const e = $('aiPanelEmpty');
  if (e) e.remove();
}

async function ensureAiReady() {
  if (!isAiPanelOpen()) openAiPanel();
  if (state.aiReady) return true;
  await refreshAiPanel();
  if (!state.aiReady) {
    toast('Set up the study helper first (right panel)');
    return false;
  }
  return true;
}

// Explain one section/paragraph in the right-hand panel.
async function explainSection(sectionEl) {
  const from = parseInt(sectionEl.dataset.from, 10);
  const to = parseInt(sectionEl.dataset.to, 10);
  if (!from) return;
  if (!(await ensureAiReady())) return;

  const book = currentBookName();
  const chapter = state.chapter;
  const label = sectionEl.dataset.label || '';
  const ref = from === to ? `${book} ${chapter}:${from}` : `${book} ${chapter}:${from}–${to}`;

  // Briefly flag which section is being explained.
  document.querySelectorAll('#chapterBody .rsection.explaining').forEach((s) => s.classList.remove('explaining'));
  sectionEl.classList.add('explaining');

  hidePanelEmpty();
  const card = aiCard(label ? `${label} · ${ref}` : ref, 'Thinking…');
  card.el.classList.add('ai-explain');
  $('aiBody').appendChild(card.el);
  card.el.scrollIntoView({ block: 'end' });
  const res = await svc.aiExplainPassage({ book, chapter, from, to, label });
  card.setText(res.error ? '⚠ ' + res.error : res.text);
  card.el.scrollIntoView({ block: 'end' });
}

async function askQuestion() {
  const q = $('aiQuestion').value.trim();
  if (!q) return;
  if (!(await ensureAiReady())) return;
  $('aiQuestion').value = '';
  hidePanelEmpty();
  const book = currentBookName();
  const chapter = state.chapter;
  const qCard = aiCard('You asked', q);
  qCard.el.classList.add('ai-q');
  $('aiBody').appendChild(qCard.el);
  const aCard = aiCard('Answer', 'Thinking…');
  $('aiBody').appendChild(aCard.el);
  aCard.el.scrollIntoView({ block: 'end' });
  const res = await svc.aiAsk({ book, chapter, question: q });
  aCard.setText(res.error ? '⚠ ' + res.error : res.text);
  aCard.el.scrollIntoView({ block: 'end' });
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
  const total = state.plan.chapters.length; // today's goal (any chapters count)
  const readToday = await svc.getChaptersReadToday(); // distinct chapters read today, any book
  const readCount = Math.min(readToday.length, total);
  const status = await svc.getTodayStatus();

  const pct = total ? Math.round((readCount / total) * 100) : 0;
  $('todayProgressBar').style.width = pct + '%';
  $('todayProgressText').textContent = status.complete
    ? "Today's reading complete"
    : `Today's reading · ${readCount}/${total} chapters`;
  $('markCompleteBtn').hidden = status.complete;
  $('todayDoneBadge').hidden = !status.complete;
}

// ---------- reading completion ----------
async function markChapterRead() {
  const ref = label(state.bookIdx, state.chapter);
  await svc.logSession({ date: state.plan.date, chapters: [ref], seconds: 0 });
  await refreshStats();
  await updateTodayStrip();
  toast(`Marked ${ref} as read`);
}

async function markComplete() {
  await svc.markTodayComplete();
  await refreshStats();
  await updateTodayStrip();
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
  if (!$('view-plan').hidden) await renderPlanView();
}

// ---------- plan builder ----------
const planEditor = { order: [], pace: 3 };

function chapterCountOf(name) {
  const i = state.bookIndex.get(name);
  return i == null ? 0 : state.bible.books[i].chapters.length;
}

// The book picker groups by Testament — Old Testament first, then New Testament.
function planGroups() {
  return [
    { name: 'Old Testament', start: 0, end: OT_BOOKS },
    { name: 'New Testament', start: OT_BOOKS, end: state.bible.books.length },
  ];
}
const planCollapsedGroups = new Set(); // section names collapsed in the builder

function groupBookNames(g) {
  return state.bible.books.slice(g.start, g.end).map((b) => b.name);
}

function presetOrder(key) {
  const names = state.bible.books.map((b) => b.name);
  switch (key) {
    case 'whole': return names.slice();
    case 'nt': return names.slice(OT_BOOKS);
    case 'ot': return names.slice(0, OT_BOOKS);
    case 'gospels': return names.slice(OT_BOOKS, OT_BOOKS + 4);
    case 'torah': return names.slice(0, 5);
    case 'wisdom': return ['Psalms', 'Proverbs'].filter((n) => state.bookIndex.has(n));
    case 'clear': return [];
    default: return [];
  }
}

function syncGroupCollapse() {
  // Expand sections that hold selected books; collapse the rest.
  planCollapsedGroups.clear();
  planGroups().forEach((g) => {
    const hasSel = groupBookNames(g).some((n) => planEditor.order.includes(n));
    if (!hasSel) planCollapsedGroups.add(g.name);
  });
}

function openPlanBuilder() {
  const cfg = state.plan && state.plan.config;
  planEditor.order = cfg && cfg.order ? [...cfg.order] : [];
  planEditor.pace = cfg && cfg.pace ? cfg.pace : 3;
  syncGroupCollapse();
  $('planPaceSelect').value = String(planEditor.pace);
  $('planOrderWrap').open = false;
  renderPlanEditor();
  $('planModal').hidden = false;
}

function closePlanBuilder() { $('planModal').hidden = true; }

function renderPlanEditor() {
  renderPlanGroups();
  renderPlanOrder();
  updatePlanSummary();
}

function renderPlanGroups() {
  const wrap = $('planGroups');
  wrap.innerHTML = '';
  const selected = new Set(planEditor.order);
  planGroups().forEach((g) => {
    const names = groupBookNames(g);
    if (!names.length) return;
    const selCount = names.filter((n) => selected.has(n)).length;
    const allOn = selCount === names.length;
    const collapsed = planCollapsedGroups.has(g.name);

    const sec = document.createElement('div');
    sec.className = 'pg' + (collapsed ? '' : ' open') + (selCount ? ' has-sel' : '');

    const head = document.createElement('div');
    head.className = 'pg-head';
    head.innerHTML =
      `<span class="pg-chevron">${collapsed ? '▸' : '▾'}</span>` +
      `<span class="pg-name">${escapeHtml(g.name)}</span>` +
      `<span class="pg-count">${selCount ? selCount + ' / ' + names.length : names.length + ' book' + (names.length === 1 ? '' : 's')}</span>`;
    const allBtn = document.createElement('button');
    allBtn.className = 'pg-all';
    allBtn.textContent = allOn ? 'Remove all' : 'Add all';
    allBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (allOn) names.forEach(removeBookByName);
      else names.forEach(addBookCanonical);
      renderPlanEditor();
    });
    head.appendChild(allBtn);
    head.addEventListener('click', () => {
      if (planCollapsedGroups.has(g.name)) planCollapsedGroups.delete(g.name);
      else planCollapsedGroups.add(g.name);
      renderPlanGroups();
    });
    sec.appendChild(head);

    const grid = document.createElement('div');
    grid.className = 'pg-grid';
    grid.hidden = collapsed;
    names.forEach((name) => {
      const chip = document.createElement('button');
      chip.className = 'bchip' + (selected.has(name) ? ' is-on' : '');
      chip.innerHTML = `<span class="bchip-name">${escapeHtml(name)}</span><span class="bchip-n">${chapterCountOf(name)}</span>`;
      chip.addEventListener('click', () => toggleBook(name));
      grid.appendChild(chip);
    });
    sec.appendChild(grid);
    wrap.appendChild(sec);
  });
  const count = planEditor.order.length;
  $('planPickCount').textContent = count ? `(${count} book${count === 1 ? '' : 's'} selected)` : '';
}

function renderPlanOrder() {
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
  $('planOrderWrap').hidden = planEditor.order.length === 0;
  $('planOrderCount').textContent = planEditor.order.length ? `(${planEditor.order.length})` : '';
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
  const save = $('planSave');
  if (!total) {
    $('planSummary').textContent = 'No books selected yet';
    if (save) save.disabled = true;
    return;
  }
  if (save) save.disabled = false;
  const pace = planEditor.pace;
  const days = Math.max(1, Math.ceil(total / pace));
  const weeks = Math.round(days / 7);
  const dur = days >= 14 ? ` · about ${weeks} week${weeks === 1 ? '' : 's'}` : '';
  const books = planEditor.order.length;
  $('planSummary').textContent =
    `${books} book${books === 1 ? '' : 's'} · ${total} chapters · ${days} day${days === 1 ? '' : 's'} at ${pace}/day${dur}`;
}

function addBookCanonical(name) {
  if (planEditor.order.includes(name)) return;
  const bi = state.bookIndex.get(name);
  const arr = planEditor.order;
  let pos = arr.length;
  for (let i = 0; i < arr.length; i++) {
    if (state.bookIndex.get(arr[i]) > bi) { pos = i; break; }
  }
  arr.splice(pos, 0, name);
}
function removeBookByName(name) {
  const i = planEditor.order.indexOf(name);
  if (i >= 0) planEditor.order.splice(i, 1);
}
function toggleBook(name) {
  if (planEditor.order.includes(name)) removeBookByName(name);
  else addBookCanonical(name);
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
  syncGroupCollapse();
  renderPlanEditor();
}

async function generateAiPlan() {
  const prompt = $('aiPlanPrompt').value.trim();
  if (!prompt) return;
  const msg = $('aiPlanMsg');
  msg.textContent = 'Generating…';
  const res = await svc.aiPlan(prompt);
  if (res.error) {
    msg.textContent = /local model|Ollama/i.test(res.error)
      ? res.error + ' Set up the study helper first (✦ Helper on any chapter).'
      : res.error;
    return;
  }
  planEditor.order = res.order;
  planEditor.pace = res.pace;
  $('planPaceSelect').value = String(res.pace);
  syncGroupCollapse();
  renderPlanEditor();
  const chapters = res.order.reduce((n, name) => n + chapterCountOf(name), 0);
  const days = Math.max(1, Math.ceil(chapters / res.pace));
  msg.textContent = `Built a ${res.order.length}-book, ~${days}-day plan below — review and Save.`;
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

// ---------- catch up: mark already-read chapters, resume at the next one ----------
function populateCatchup() {
  const bsel = $('catchupBook');
  bsel.innerHTML = '';
  const ot = document.createElement('optgroup'); ot.label = 'Old Testament';
  const nt = document.createElement('optgroup'); nt.label = 'New Testament';
  state.bible.books.forEach((b, i) => {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = b.name;
    (i < OT_BOOKS ? ot : nt).appendChild(opt);
  });
  bsel.appendChild(ot);
  bsel.appendChild(nt);
  bsel.value = String(state.bookIdx);
  populateCatchupChapters();
}

function populateCatchupChapters() {
  const bi = parseInt($('catchupBook').value, 10);
  const csel = $('catchupChapter');
  csel.innerHTML = '';
  const n = state.bible.books[bi].chapters.length;
  for (let c = 1; c <= n; c++) {
    const o = document.createElement('option');
    o.value = c;
    o.textContent = c;
    csel.appendChild(o);
  }
  csel.value = String(Math.min(state.chapter || 1, n));
}

async function applyCatchup() {
  const bi = parseInt($('catchupBook').value, 10);
  const upTo = parseInt($('catchupChapter').value, 10);
  if (!(upTo >= 1)) return;
  const name = state.bible.books[bi].name;
  const labels = [];
  for (let c = 1; c <= upTo; c++) labels.push(`${name} ${c}`);
  await svc.markChaptersRead(labels);
  await refreshStats();
  await updateTodayStrip();
  if (!$('view-plan').hidden) await renderPlanView();

  const total = state.bible.books[bi].chapters.length;
  if (upTo < total) goToChapter(bi, upTo + 1);
  else if (bi + 1 < state.bible.books.length) goToChapter(bi + 1, 1);
  else goToChapter(bi, total);
  switchView('read');
  toast(`Marked ${name} 1–${upTo} as read — resuming at ${currentBookName()} ${state.chapter}`);
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

  // Split by Testament — Old Testament first, then New Testament.
  const inNT = (name) => { const i = state.bookIndex.get(name); return i != null && i >= OT_BOOKS; };
  const groups = [
    { name: 'Old Testament', books: order.filter((n) => !inNT(n)) },
    { name: 'New Testament', books: order.filter(inNT) },
  ].filter((g) => g.books.length);

  if (state.planSelected && !order.includes(state.planSelected)) state.planSelected = null;

  const wrap = $('planBooks');
  wrap.innerHTML = '';
  groups.forEach((g) => {
    let gTotal = 0;
    let gRead = 0;
    g.books.forEach((name) => {
      const n = state.bible.books[state.bookIndex.get(name)].chapters.length;
      gTotal += n;
      for (let c = 1; c <= n; c++) if (readSet.has(`${name} ${c}`)) gRead++;
    });
    const gComplete = gRead === gTotal;

    const sec = document.createElement('section');
    sec.className = 'plan-section';
    const sh = document.createElement('div');
    sh.className = 'plan-section-head static';
    sh.innerHTML =
      `<span class="ps-name">${escapeHtml(g.name)}</span>` +
      `<span class="ps-count">${g.books.length} book${g.books.length === 1 ? '' : 's'} · ${gRead} / ${gTotal}${gComplete ? ' ✓' : ''}</span>`;
    sec.appendChild(sh);

    const grid = document.createElement('div');
    grid.className = 'book-tiles';
    g.books.forEach((name) => grid.appendChild(buildBookTile(name, readSet)));
    sec.appendChild(grid);
    wrap.appendChild(sec);
  });

  renderPlanDetail(readSet);
}

// A compact tile in the overview grid.
function buildBookTile(name, readSet) {
  const idx = state.bookIndex.get(name);
  const n = state.bible.books[idx].chapters.length;
  let rc = 0;
  for (let c = 1; c <= n; c++) if (readSet.has(`${name} ${c}`)) rc++;
  const pct = Math.round((rc / n) * 100);
  const complete = rc === n;
  const started = rc > 0 && !complete;

  const tile = document.createElement('button');
  tile.className = 'book-tile' +
    (complete ? ' complete' : started ? ' started' : '') +
    (state.planSelected === name ? ' selected' : '');
  tile.innerHTML =
    `<span class="bt-name">${escapeHtml(name)}</span>` +
    `<span class="bt-meta">${complete ? '✓ done' : rc + ' / ' + n}</span>` +
    `<span class="bt-bar"><span class="bt-bar-fill" style="width:${pct}%"></span></span>`;
  tile.addEventListener('click', () => {
    state.planSelected = name;
    renderPlanView();
    const d = $('planDetail');
    if (d) d.scrollIntoView({ block: 'nearest' });
  });
  return tile;
}

// The detail panel for the selected book: chapters + actions.
function renderPlanDetail(readSet) {
  const el = $('planDetail');
  el.innerHTML = '';
  const name = state.planSelected;
  if (!name) { el.hidden = true; return; }
  el.hidden = false;

  const idx = state.bookIndex.get(name);
  const n = state.bible.books[idx].chapters.length;
  let rc = 0;
  for (let c = 1; c <= n; c++) if (readSet.has(`${name} ${c}`)) rc++;
  const pct = Math.round((rc / n) * 100);
  const complete = rc === n;

  const head = document.createElement('div');
  head.className = 'plan-detail-head';
  head.innerHTML =
    `<div><span class="pd-name">${escapeHtml(name)}</span>` +
    `<span class="pd-meta">${rc} / ${n} chapters read · ${pct}%</span></div>`;
  const actions = document.createElement('div');
  actions.className = 'pd-actions';
  const openBtn = document.createElement('button');
  openBtn.className = 'btn btn-sm';
  openBtn.textContent = 'Open in reader';
  openBtn.addEventListener('click', () => openReference(name, 1));
  const markBtn = document.createElement('button');
  markBtn.className = 'btn btn-sm' + (complete ? '' : ' btn-success');
  markBtn.textContent = complete ? 'Clear book' : 'Mark book complete';
  markBtn.addEventListener('click', async () => {
    const labels = [];
    for (let c = 1; c <= n; c++) labels.push(`${name} ${c}`);
    if (complete) await svc.unmarkChapters(labels);
    else await svc.markChaptersRead(labels);
    await renderPlanView();
    await refreshStats();
    await updateTodayStrip();
    toast(complete ? `Cleared ${name}` : `Marked ${name} complete`);
  });
  actions.appendChild(openBtn);
  actions.appendChild(markBtn);
  head.appendChild(actions);
  el.appendChild(head);

  const bar = document.createElement('div');
  bar.className = 'book-bar';
  bar.innerHTML = `<div class="book-bar-fill" style="width:${pct}%"></div>`;
  el.appendChild(bar);

  const dots = document.createElement('div');
  dots.className = 'chapter-dots';
  for (let c = 1; c <= n; c++) {
    const dot = document.createElement('button');
    dot.className = 'cdot' + (readSet.has(`${name} ${c}`) ? ' done' : '');
    dot.textContent = c;
    dot.title = `Open ${name} ${c}`;
    dot.addEventListener('click', () => openReference(name, c));
    dots.appendChild(dot);
  }
  el.appendChild(dots);
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
  $('focusToggle').addEventListener('click', toggleFocus);
  $('versionSelect').addEventListener('change', (e) => changeVersion(e.target.value));
  $('studyBtn').addEventListener('click', toggleAiPanel);
  $('aiPanelClose').addEventListener('click', closeAiPanel);
  $('aiForget').addEventListener('click', openAiSettings);
  $('aiSend').addEventListener('click', askQuestion);
  $('aiQuestion').addEventListener('keydown', (e) => { if (e.key === 'Enter') askQuestion(); });
  $('aiOllamaSave').addEventListener('click', saveOllamaModel);
  $('aiOllamaRecheck').addEventListener('click', recheckOllama);
  $('aiOllamaInstall').addEventListener('click', autoInstallOllama);
  svc.onAiInstallProgress((s) => setInstallUi(s));
  document.querySelector('.reader').addEventListener('scroll', () => {
    if (!state.focus || scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; updateActiveSection(); });
  });
  $('markChapterReadBtn').addEventListener('click', markChapterRead);
  $('markCompleteBtn').addEventListener('click', markComplete);
  $('resetProgressBtn').addEventListener('click', resetProgress);
  $('setStartBtn').addEventListener('click', applyStartDate);
  $('editPlanBtn').addEventListener('click', openPlanBuilder);
  $('editPlanBtn2').addEventListener('click', openPlanBuilder);
  $('planClose').addEventListener('click', closePlanBuilder);
  $('planUseDefault').addEventListener('click', useDefaultPlan);
  $('planSave').addEventListener('click', savePlan);
  $('planPaceSelect').addEventListener('change', (e) => { planEditor.pace = parseInt(e.target.value, 10) || 3; updatePlanSummary(); });
  document.querySelectorAll('.preset').forEach((b) => b.addEventListener('click', () => applyPreset(b.dataset.preset)));
  $('aiPlanBtn').addEventListener('click', generateAiPlan);
  $('aiPlanPrompt').addEventListener('keydown', (e) => { if (e.key === 'Enter') generateAiPlan(); });
  $('catchupBook').addEventListener('change', populateCatchupChapters);
  $('catchupBtn').addEventListener('click', applyCatchup);
  $('calPrev').addEventListener('click', () => shiftMonth(-1));
  $('calNext').addEventListener('click', () => shiftMonth(1));
  $('searchBtn').addEventListener('click', runSearch);
  $('searchInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(); });

  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => switchView(t.dataset.view)));

  document.addEventListener('keydown', (e) => {
    if (!$('confirmModal').hidden || !$('planModal').hidden) return;
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
