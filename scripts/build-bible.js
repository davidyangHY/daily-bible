#!/usr/bin/env node
/*
 * Builds assets/bible.json (bundled, offline) from the public-domain
 * World English Bible (WEB) served by getBible.net.
 *
 * The source format is verbose; we flatten it to:
 *   { translation, abbreviation, license, books: [ { name, chapters: [ [verse, ...] ] } ] }
 *
 * Run:  npm run build:bible   (add --force to overwrite an existing file)
 */
const fs = require('fs');
const path = require('path');

const SOURCE_URL = 'https://api.getbible.net/v2/web.json';
const OUT = path.join(__dirname, '..', 'assets', 'bible.json');

async function main() {
  const force = process.argv.includes('--force');
  if (fs.existsSync(OUT) && !force) {
    console.log(`assets/bible.json already exists (${fmtBytes(fs.statSync(OUT).size)}). Use --force to rebuild.`);
    return;
  }

  console.log(`Downloading WEB from ${SOURCE_URL} ...`);
  const res = await fetch(SOURCE_URL);
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  const raw = await res.json();

  const books = raw.books.map((b) => ({
    name: b.name,
    chapters: b.chapters.map((c) => c.verses.map((v) => v.text.trim())),
  }));

  const out = {
    translation: raw.translation || 'World English Bible',
    abbreviation: (raw.abbreviation || 'WEB').toUpperCase(),
    license: raw.distribution_license || 'Public Domain',
    books,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out));
  const chapters = books.reduce((n, b) => n + b.chapters.length, 0);
  console.log(`Wrote ${OUT}`);
  console.log(`  ${books.length} books, ${chapters} chapters, ${fmtBytes(fs.statSync(OUT).size)}`);
}

function fmtBytes(n) {
  return n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : (n / 1e3).toFixed(0) + ' KB';
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
