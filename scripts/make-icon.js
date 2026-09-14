#!/usr/bin/env node
/*
 * Generates assets/icon.png — a simple flat "open book" app/tray icon —
 * without any image libraries, by writing raw RGBA pixels into a PNG.
 * Run: node scripts/make-icon.js
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const S = 256;
const buf = Buffer.alloc(S * S * 4); // RGBA

// palette
const BG_TOP = [79, 70, 229];   // indigo-600
const BG_BOT = [124, 58, 237];  // violet-600
const PAGE = [245, 247, 252];
const PAGE_SHADE = [214, 219, 230];
const LINE = [150, 160, 185];

function set(x, y, [r, g, b], a = 255) {
  if (x < 0 || y < 0 || x >= S || y >= S) return;
  const i = (y * S + x) * 4;
  const na = a / 255;
  buf[i] = Math.round(r * na + buf[i] * (1 - na));
  buf[i + 1] = Math.round(g * na + buf[i + 1] * (1 - na));
  buf[i + 2] = Math.round(b * na + buf[i + 2] * (1 - na));
  buf[i + 3] = Math.max(buf[i + 3], Math.round(a));
}

// rounded-rect membership
const R = 52;
function inRounded(x, y) {
  if (x < 0 || y < 0 || x >= S || y >= S) return false;
  const cx = Math.min(Math.max(x, R), S - 1 - R);
  const cy = Math.min(Math.max(y, R), S - 1 - R);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= R * R;
}

// convex polygon membership (points in order)
function inPoly(px, py, pts) {
  let sign = 0;
  for (let i = 0; i < pts.length; i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[(i + 1) % pts.length];
    const cross = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
    if (cross !== 0) {
      const s = cross > 0 ? 1 : -1;
      if (sign === 0) sign = s;
      else if (s !== sign) return false;
    }
  }
  return true;
}

const leftPage = [[44, 108], [128, 92], [128, 168], [44, 184]];
const rightPage = [[212, 108], [128, 92], [128, 168], [212, 184]];
// text lines on each page (y positions, relative)
const lineYs = [122, 136, 150];

for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    if (!inRounded(x, y)) continue;
    // vertical gradient background
    const t = y / (S - 1);
    const bg = [
      Math.round(BG_TOP[0] + (BG_BOT[0] - BG_TOP[0]) * t),
      Math.round(BG_TOP[1] + (BG_BOT[1] - BG_TOP[1]) * t),
      Math.round(BG_TOP[2] + (BG_BOT[2] - BG_TOP[2]) * t),
    ];
    set(x, y, bg);

    const onLeft = inPoly(x, y, leftPage);
    const onRight = inPoly(x, y, rightPage);
    if (onLeft || onRight) {
      set(x, y, PAGE);
      // page text lines
      for (const ly of lineYs) {
        if (Math.abs(y - ly) <= 2) {
          if (onLeft && x > 58 && x < 118) set(x, y, LINE);
          if (onRight && x > 138 && x < 198) set(x, y, LINE);
        }
      }
    }
    // spine shadow
    if (Math.abs(x - 128) <= 3 && y > 92 && y < 168) set(x, y, PAGE_SHADE);
  }
}

function OUTPATH() {
  return path.join(__dirname, '..', 'assets', 'icon.png');
}

function writePng(file, rgba, w, h) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // no filter
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  const chunks = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr(w, h)),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ];
  fs.writeFileSync(file, Buffer.concat(chunks));
}

function ihdr(w, h) {
  const b = Buffer.alloc(13);
  b.writeUInt32BE(w, 0);
  b.writeUInt32BE(h, 4);
  b[8] = 8;  // bit depth
  b[9] = 6;  // color type RGBA
  b[10] = 0; b[11] = 0; b[12] = 0;
  return b;
}

function chunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0, 0);
  return Buffer.concat([len, t, data, crc]);
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ 0xffffffff;
}

writePng(OUTPATH(), buf, S, S);
console.log('Wrote', OUTPATH());
