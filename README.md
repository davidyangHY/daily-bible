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
- Optional AI study helper: explains the chapter, answers questions, and can build
  a reading plan from a plain-language description. Two providers to choose from:
  - Local (free): a small open-source model via [Ollama](https://ollama.com) —
    no key, offline, runs on your machine (install Ollama and `ollama pull llama3.2`).
  - Claude: `claude-haiku-4-5` via the Anthropic API — higher quality, needs your
    own API key (stored locally), small per-use cost.
  Explanations are cached per chapter so repeat views are instant.
- Section headings above each passage (for example "The Genealogy of Jesus" or
  "Jesus Calms the Storm"). The WEB ships none, so these are the public-domain
  Berean Standard Bible headings, matched to each verse (`assets/headings.json`).
- Full-text search across the whole Bible; click a result to jump to the verse.
- Bookmarks: click a verse number to save it, with a dedicated Bookmarks tab.
- Adjustable reading font size, remembered between launches.
- Continue where you left off; the reader reopens your last chapter.

### Plans and tracking

- Custom reading plans: build your own book-by-book plan (presets for New
  Testament, Gospels, Old Testament, Torah, and Psalms and Proverbs, or pick and
  reorder any books) and choose a pace in chapters per day. Falls back to the
  whole Bible in a year if you do not build one.
- Plan tab: every book in your plan as a collapsible row with a progress bar, a
  clickable chapter grid, per-book "mark complete", and an overall total.
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
