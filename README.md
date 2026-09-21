# Daily Bible

A warm, offline desktop Bible that also reminds you what to read each day. Built
with Electron, vanilla HTML/CSS/JS, and better-sqlite3.

Three public-domain translations are bundled locally, so the app works fully
offline and never calls an external API: the World English Bible (WEB, modern
English), the Berean Standard Bible (BSB, modern English), and the King James
Version (KJV). You can switch between them from the reader. Copyrighted
translations such as the NIV, NKJV, or ESV are not included, since they cannot be
redistributed.

## Features

### Reading

- Daily reading prompt on launch showing today's chapters.
- Read any chapter, with a version picker (WEB, BSB, KJV), a book picker grouped
  by Old and New Testament, a chapter picker, previous/next buttons, and
  left/right arrow keys.
- Focus mode: highlights the section you are reading and dims the rest, following
  your scroll, so it is easy to keep your place.
- Optional AI study helper in a side panel next to the passage: every section has an
  "Explain" button that breaks down that specific passage in the panel, and you can
  ask free-form questions about the chapter. It runs entirely on your own machine
  through a small open-source model via [Ollama](https://ollama.com) — free, offline,
  and no API key. The app can download and set it up for you in one click (a one-time
  ~3.5 GB download), or you can install Ollama yourself and run `ollama pull llama3.2`.
  Explanations are cached per passage so repeat views are instant.
- Section headings above each passage (for example "The Genealogy of Jesus" or
  "Jesus Calms the Storm"). The WEB ships none, so these are the public-domain
  Berean Standard Bible headings, matched to each verse (`assets/headings.json`).
- Full-text search across the whole Bible; click a result to jump to the verse.
- Bookmarks: click a verse number to save it, with a dedicated Bookmarks tab.
- Adjustable reading font size, remembered between launches.
- Continue where you left off; the reader reopens your last chapter.

### Plans and tracking

- Custom reading plans: either describe what you want and let AI build it (for
  example "the New Testament in 60 days"), or use the visual book picker — tap books
  to include them, grouped into collapsible Old Testament / New Testament sections,
  with one-tap presets (Whole Bible, New Testament, Gospels, Old Testament, Torah,
  Psalms & Proverbs) and a live "books · chapters · days" estimate. Choose a pace in
  chapters per day; optionally reorder the books. Falls back to the whole Bible in a
  year if you do not build one.
- Catch up: from Progress, pick a book and chapter under "Already read up to" to mark
  everything up to there as read and jump the reader to the next chapter.
- Plan tab: every book in your plan shown at once as a compact grid of tiles (Old
  Testament, then New Testament), each with its own progress bar. Click a book to open
  a detail panel with its chapter grid, an "open in reader" button, and "mark book
  complete". Below it, an "All books of the Bible" board shows all 66 books and your
  progress on each — finished books turn green — as a whole-Bible tracker.
- Mark a single chapter read, or mark the whole day complete, from the reader or
  the tray.
- Streaks (current and longest), days completed, and chapters read.
- Month calendar marking each day you completed your reading.
- Change the plan start date (Day 1), or reset progress (with a confirmation;
  bookmarks are kept).
- Progress is stored in a local SQLite database.

### Desktop

- Installs as a Windows app with a desktop icon and Start-menu entry.
- Runs in the system tray; closing the window minimizes to the tray.
- Tray menu: Open, Mark Today Complete, Quit.
- Evening reminder notification if the day's reading is not done.
- Optional auto-launch on login (starts hidden in the tray).

## Run from source

```bash
npm install
npm start
```

`npm install` downloads Electron and the matching better-sqlite3 prebuilt binary,
so no C/C++ compiler is required (see `.npmrc`). `npm start` needs Node.js on your
PATH.

## Build a Windows installer

```bash
npm run dist
```

This produces `dist/Daily Bible Setup <version>.exe` (NSIS, unsigned). Because it
is unsigned, Windows SmartScreen may warn on first run; choose "More info" then
"Run anyway". Use `npm run pack` for an unpacked build under `dist/win-unpacked`.

## Project layout

| Path | Purpose |
| --- | --- |
| `main.js` | Electron main process: window, tray, notifications, auto-launch, IPC |
| `preload.js` | Context-isolated bridge exposing a small `window.api` |
| `db.js` | better-sqlite3 persistence: sessions, bookmarks, plan, stats |
| `readingPlan.js` | Maps a date to the chapters scheduled for that day |
| `renderer/` | UI (HTML/CSS/JS): Read, Search, Plan, Bookmarks, Progress |
| `assets/bible.json` | Bundled World English Bible (default version) |
| `assets/bible-bsb.json`, `assets/bible-kjv.json` | BSB and KJV versions |
| `assets/headings.json` | Section headings (Berean Standard Bible) |
| `scripts/build-bible.js` | Regenerates `bible.json` from the WEB source |
| `scripts/build-versions.js` | Regenerates the BSB and KJV version files |
| `scripts/build-headings.js` | Regenerates `headings.json` from the BSB USFM |
| `scripts/make-icon.js`, `scripts/make-ico.js` | Regenerate the app icon |

## Data location

Reading history and bookmarks are stored at:

```
%APPDATA%\Daily Bible\reading.db
```

## Text and licensing

- Bible text: World English Bible (WEB), Berean Standard Bible (BSB), and King
  James Version (KJV) — all public domain.
- Section headings: Berean Standard Bible (BSB), public domain.
- Application code: MIT.

Copyrighted translations such as the NIV, NKJV, or ESV are not included, since
they cannot be redistributed.
