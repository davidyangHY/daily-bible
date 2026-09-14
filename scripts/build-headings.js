#!/usr/bin/env node
/*
 * Builds assets/headings.json — public-domain section headings ("The Genealogy
 * of Jesus", etc.) extracted from the Berean Standard Bible (BSB) USFM.
 *
 * The World English Bible ships no editorial section headings, so we overlay the
 * BSB's (both use standard versification, so they align to WEB verse numbers).
 *
 * Prep: download and unzip the BSB USFM, then point this script at the folder:
 *   1) https://ebible.org/Scriptures/engbsb_usfm.zip  -> unzip
 *   2) node scripts/build-headings.js <path-to-usfm-folder>
 *
 * Output shape: { "<Book>": { "<chapter>": { "<verse>": "<heading>" } } }
 * Book names match assets/bible.json (WEB), keyed by canonical order.
 */
const fs = require('fs');
const path = require('path');

// 66-book canonical USFM codes, in order (index 0..65).
const CODES = [
  'GEN','EXO','LEV','NUM','DEU','JOS','JDG','RUT','1SA','2SA','1KI','2KI','1CH','2CH','EZR','NEH','EST',
  'JOB','PSA','PRO','ECC','SNG','ISA','JER','LAM','EZK','DAN','HOS','JOL','AMO','OBA','JON','MIC','NAM',
  'HAB','ZEP','HAG','ZEC','MAL',
  'MAT','MRK','LUK','JHN','ACT','ROM','1CO','2CO','GAL','EPH','PHP','COL','1TH','2TH','1TI','2TI','TIT',
  'PHM','HEB','JAS','1PE','2PE','1JN','2JN','3JN','JUD','REV',
];

function cleanHeading(s) {
  return s
    .replace(/\\f.*?\\f\*/g, '')      // footnotes
    .replace(/\\x.*?\\x\*/g, '')      // cross-refs
    .replace(/\|[^\\]*?\\w\*/g, '\\w*') // strong tags inside \w
    .replace(/\\\+?[a-z0-9]+\*?/gi, '') // any remaining markers
    .replace(/\s+/g, ' ')
    .trim();
}

function main() {
  const srcDir = process.argv[2] || path.join(process.cwd(), 'bsb_usfm');
  if (!fs.existsSync(srcDir)) {
    console.error(`USFM folder not found: ${srcDir}\nDownload https://ebible.org/Scriptures/engbsb_usfm.zip, unzip it, and pass the folder path.`);
    process.exit(1);
  }

  // Map WEB book names by canonical index (from bundled bible.json).
  const bible = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'assets', 'bible.json'), 'utf8'));
  const nameByIndex = bible.books.map((b) => b.name);

  const codeToName = {};
  CODES.forEach((code, i) => { codeToName[code] = nameByIndex[i]; });

  const out = {};
  let total = 0;
  const files = fs.readdirSync(srcDir).filter((f) => f.endsWith('.usfm'));

  for (const file of files) {
    const text = fs.readFileSync(path.join(srcDir, file), 'utf8');
    const lines = text.split(/\r?\n/);

    const idLine = lines.find((l) => l.startsWith('\\id '));
    if (!idLine) continue;
    const code = idLine.split(/\s+/)[1];
    const book = codeToName[code];
    if (!book) continue; // skip front matter / non-canonical

    let chapter = 0;
    let pending = null;
    for (const ln of lines) {
      if (ln.startsWith('\\c ')) {
        chapter = parseInt(ln.slice(3), 10) || chapter;
        pending = null;
      } else if (/^\\s\d?\s/.test(ln) || /^\\ms\d?\s/.test(ln)) {
        const txt = cleanHeading(ln.replace(/^\\m?s\d?\s/, ''));
        if (txt) pending = pending ? `${pending} — ${txt}` : txt;
      } else if (ln.startsWith('\\v ')) {
        if (pending) {
          const verse = parseInt(ln.slice(3), 10);
          if (verse) {
            out[book] = out[book] || {};
            out[book][chapter] = out[book][chapter] || {};
            out[book][chapter][verse] = pending;
            total++;
          }
          pending = null;
        }
      }
    }
  }

  const dest = path.join(__dirname, '..', 'assets', 'headings.json');
  fs.writeFileSync(dest, JSON.stringify(out));
  const kb = (fs.statSync(dest).size / 1024).toFixed(0);
  console.log(`Wrote ${dest}`);
  console.log(`  ${total} headings across ${Object.keys(out).length} books, ${kb} KB`);
}

main();
