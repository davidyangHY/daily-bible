#!/usr/bin/env node
/*
 * Wraps assets/icon.png (256x256) into build/icon.ico for electron-builder.
 * Uses the PNG-in-ICO format (Vista+), so no re-encoding is needed.
 * Run: node scripts/make-ico.js
 */
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'assets', 'icon.png');
const outDir = path.join(__dirname, '..', 'build');
const out = path.join(outDir, 'icon.ico');

const png = fs.readFileSync(src);

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(1, 4); // image count

const entry = Buffer.alloc(16);
entry.writeUInt8(0, 0);              // width 0 => 256
entry.writeUInt8(0, 1);              // height 0 => 256
entry.writeUInt8(0, 2);              // color palette
entry.writeUInt8(0, 3);              // reserved
entry.writeUInt16LE(1, 4);           // color planes
entry.writeUInt16LE(32, 6);          // bits per pixel
entry.writeUInt32LE(png.length, 8);  // size of image data
entry.writeUInt32LE(6 + 16, 12);     // offset of image data

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(out, Buffer.concat([header, entry, png]));
console.log('Wrote', out, `(${png.length} bytes PNG embedded)`);
