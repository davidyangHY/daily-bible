/*
 * Reading plan: distributes all 1,189 chapters of the Bible evenly across a
 * 365-day year. Day 1 is the plan's start date, so a fresh start begins at the
 * beginning of the plan (not the current day-of-year). The plan repeats
 * annually after 365 days.
 */

/** Build a flat, canonical list of { book, chapter } from bible metadata. */
function buildChapterList(books) {
  const list = [];
  for (const b of books) {
    for (let c = 1; c <= b.chapters.length; c++) {
      list.push({ book: b.name, chapter: c });
    }
  }
  return list;
}

/** Build a flat chapter list following a custom ordered list of book names. */
function buildChapterListFromOrder(books, order) {
  const byName = new Map(books.map((b) => [b.name, b]));
  const list = [];
  for (const name of order) {
    const b = byName.get(name);
    if (!b) continue;
    for (let c = 1; c <= b.chapters.length; c++) list.push({ book: b.name, chapter: c });
  }
  return list;
}

/** Whole days between two local dates (b - a). */
function daysBetween(aISO, bDate) {
  const a = new Date(aISO + 'T00:00:00');
  const b = new Date(bDate.getFullYear(), bDate.getMonth(), bDate.getDate());
  return Math.floor((b - a) / 86400000);
}

/**
 * Returns the chapters scheduled for `date`.
 * - Default (config null): whole Bible, evenly across 365 days.
 * - Custom (config = { order, pace }): the selected books in order, `pace`
 *   chapters per day; the plan length is ceil(chapters / pace) days.
 * In both cases the schedule repeats once it reaches the end.
 *
 * @param {Array}  books    bible.books (each has { name, chapters: [...] })
 * @param {Date}   date     the day to look up (defaults to now)
 * @param {string} startISO plan start date "YYYY-MM-DD" (Day 1)
 * @param {object} config   { order: string[], pace: number } | null
 * @returns {{ day:number, totalDays:number, chapters: Array<{book,chapter}> }}
 */
function getPlanForDate(books, date = new Date(), startISO = null, config = null) {
  const custom = config && Array.isArray(config.order) && config.order.length;
  const all = custom ? buildChapterListFromOrder(books, config.order) : buildChapterList(books);
  const total = all.length || 1;

  let elapsed = startISO ? daysBetween(startISO, date) : 0;
  if (elapsed < 0) elapsed = 0;

  if (custom) {
    const pace = Math.max(1, config.pace || 3);
    const totalDays = Math.max(1, Math.ceil(total / pace));
    const dayIndex = ((elapsed % totalDays) + totalDays) % totalDays;
    const start = dayIndex * pace;
    const end = Math.min(start + pace, total);
    return { day: dayIndex + 1, totalDays, chapters: all.slice(start, end) };
  }

  const DAYS = 365;
  const dayIndex = ((elapsed % DAYS) + DAYS) % DAYS;
  const start = Math.floor((dayIndex * total) / DAYS);
  const end = Math.floor(((dayIndex + 1) * total) / DAYS);
  return { day: dayIndex + 1, totalDays: DAYS, chapters: all.slice(start, end) };
}

module.exports = { getPlanForDate, buildChapterList, buildChapterListFromOrder };
