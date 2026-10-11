/*
 * Reading plan: an ordered list of chapters plus a daily pace.
 * - Default (no custom plan): the whole Bible in canonical order, at the pace
 *   that finishes it within a year.
 * - Custom: the chosen books in order, at the chosen chapters per day.
 *
 * The plan follows your progress rather than the calendar: each day's reading
 * is the next unread chapters in plan order, so a missed day never skips ahead.
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

const chapterLabel = (c) => `${c.book} ${c.chapter}`;

/**
 * The plan's full chapter list and daily pace.
 * @param {Array}  books   bible.books (each has { name, chapters: [...] })
 * @param {object} config  { order: string[], pace: number } | null
 * @returns {{ all: Array<{book,chapter}>, pace: number }}
 */
function planChapters(books, config = null) {
  const custom = config && Array.isArray(config.order) && config.order.length;
  const all = custom ? buildChapterListFromOrder(books, config.order) : buildChapterList(books);
  const pace = custom ? Math.max(1, config.pace || 3) : Math.max(1, Math.ceil(all.length / 365));
  return { all, pace };
}

/**
 * The next `pace` chapters in plan order that aren't in `readSet`.
 * Empty when the whole plan has been read.
 */
function nextChapters(all, pace, readSet) {
  const out = [];
  for (const c of all) {
    if (!readSet.has(chapterLabel(c))) {
      out.push(c);
      if (out.length >= pace) break;
    }
  }
  return out;
}

module.exports = { planChapters, nextChapters, chapterLabel, buildChapterList, buildChapterListFromOrder };
