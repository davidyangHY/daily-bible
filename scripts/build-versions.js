#!/usr/bin/env node
/*
 * Builds the additional public-domain translations bundled alongside the WEB:
 *   assets/bible-bsb.json  (Berean Standard Bible)
 *   assets/bible-kjv.json  (King James Version)
 *
 * Each is written in the same lean shape as assets/bible.json:
 *   { translation, abbreviation, license, books: [ { name, chapters: [ [verse, ...] ] } ] }
 * Book names are normalized to the canonical WEB names (by canonical order), so
 * the app's book index, reading plan, and headings line up across versions.
 *
 * Run: node scripts/build-versions.js
 */
const fs = require('fs');
const path = require('path');

const ASSETS = path.join(__dirname, '..', 'assets');
const canonNames = JSON.parse(fs.readFileSync(path.join(ASSETS, 'bible.json'), 'utf8')).books.map((b) => b.name);

async function main() {
  await buildBSB();
  await buildKJV();
}

async function buildBSB() {
  console.log('BSB: downloading bereanbible.com/bsb.txt ...');
  const res = await fetch('https://bereanbible.com/bsb.txt');
  if (!res.ok) throw new Error(`BSB download failed: ${res.status}`);
  const text = await res.text();

  const order = []; // book display names in first-seen order
  const byBook = new Map(); // name -> chapters map (Map<chapter, Map<verse,text>>)
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^(.+?) (\d+):(\d+)\t(.*)$/);
    if (!m) continue;
    const [, book, ch, vs, txt] = m;
    if (!byBook.has(book)) { byBook.set(book, new Map()); order.push(book); }
    const chapters = byBook.get(book);
    const c = parseInt(ch, 10);
    if (!chapters.has(c)) chapters.set(c, new Map());
    chapters.get(c).set(parseInt(vs, 10), txt.trim());
  }
  writeVersion('bible-bsb.json', 'Berean Standard Bible', 'BSB', 'Public Domain', order, byBook);
}

async function buildKJV() {
  console.log('KJV: downloading thiagobodruk/bible en_kjv.json ...');
  const res = await fetch('https://raw.githubusercontent.com/thiagobodruk/bible/master/json/en_kjv.json');
  if (!res.ok) throw new Error(`KJV download failed: ${res.status}`);
  let raw = await res.text();
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); // strip BOM
  const arr = JSON.parse(raw); // [{ name, chapters: [ [verse,...] ], abbrev }]

  if (arr.length !== 66) throw new Error(`KJV: expected 66 books, got ${arr.length}`);
  const books = arr.map((b, i) => ({ name: canonNames[i], chapters: b.chapters.map((ch) => ch.map(cleanKjv)) }));
  writeOut('bible-kjv.json', { translation: 'King James Version', abbreviation: 'KJV', license: 'Public Domain', books });
}

// The thiagobodruk KJV encodes marginal notes and supplied words in braces:
//   {word}                -> supplied word (keep, drop braces)
//   {phrase: Heb. note}   -> translator's marginal note (remove)
function cleanKjv(v) {
  return String(v)
    .replace(/\{[^{}]*:[^{}]*\}/g, '') // remove marginal notes (contain a colon)
    .replace(/[{}]/g, '')              // unwrap remaining supplied-word braces
    .replace(/\s+([,.;:!?])/g, '$1')   // tidy spacing before punctuation
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function writeVersion(file, translation, abbr, license, order, byBook) {
  if (order.length !== 66) throw new Error(`${abbr}: expected 66 books, got ${order.length}`);
  const books = order.map((displayName, i) => {
    const chaptersMap = byBook.get(displayName);
    const chapterNums = [...chaptersMap.keys()].sort((a, b) => a - b);
    const chapters = chapterNums.map((cn) => {
      const versesMap = chaptersMap.get(cn);
      const verseNums = [...versesMap.keys()].sort((a, b) => a - b);
      return verseNums.map((vn) => versesMap.get(vn));
    });
    return { name: canonNames[i], chapters };
  });
  writeOut(file, { translation, abbreviation: abbr, license, books });
}

function writeOut(file, obj) {
  const dest = path.join(ASSETS, file);
  fs.writeFileSync(dest, JSON.stringify(obj));
  const chapters = obj.books.reduce((n, b) => n + b.chapters.length, 0);
  const kb = (fs.statSync(dest).size / 1024 / 1024).toFixed(1);
  console.log(`  wrote ${file}: ${obj.books.length} books, ${chapters} chapters, ${kb} MB`);
}

main().catch((e) => { console.error(e); process.exit(1); });
