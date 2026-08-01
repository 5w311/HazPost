#!/usr/bin/env node
/**
 * build-icons.mjs — draw the HazPost home-screen icons.
 *
 *   node tools/build-icons.mjs
 *
 * Writes icons/*.png. No dependencies: the shape is a signed distance field,
 * the PNGs are encoded here against node:zlib. Re-run it rather than editing
 * the binaries — nobody can review a hand-authored PNG.
 *
 * The mark is the app's logo: a yellow rounded diamond on the app background,
 * i.e. the rounded square in `.logo-d::before` turned 45 degrees.
 *
 * Every icon is drawn full-bleed and fully opaque. iOS composites a
 * transparent apple-touch-icon onto white, which would put a yellow diamond
 * on a white tile instead of the dark one the app uses.
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "..", "icons");

/* Straight off :root in index.html */
const BG = [0x14, 0x17, 0x1c]; // --bg
const FG = [0xff, 0xb6, 0x12]; // --brand

/**
 * Icons come in two framings.
 *
 * "any" fills the tile: the diamond spans 82% of the width, matching the
 * proportions of the header logo.
 *
 * "maskable" is cropped by the launcher to whatever shape the OS likes, and
 * only the central 80% circle is guaranteed to survive. A diamond touching
 * the edges would lose its points, so it is drawn smaller — the safe circle
 * has radius 0.4·size, and a diamond of half-diagonal 0.30·size sits inside it
 * with room to spare.
 */
const SPAN = { any: 0.82, maskable: 0.60 };

/** Corner rounding, as a fraction of the square's side. */
const ROUND = 0.14;

/**
 * Signed distance to a rounded square centred on the origin, in pixels.
 * Negative inside. `half` is half the side length before rounding.
 */
function roundedSquare(px, py, half, r) {
  const qx = Math.abs(px) - (half - r);
  const qy = Math.abs(py) - (half - r);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inside = Math.min(Math.max(qx, qy), 0);
  return outside + inside - r;
}

/**
 * Render one icon into a raw RGB buffer.
 *
 * Coverage comes from the distance field rather than supersampling: at one
 * pixel per unit, `0.5 - d` is the fraction of the pixel the shape covers,
 * which antialiases the diamond's edges exactly.
 */
function draw(size, kind) {
  const half = (size * SPAN[kind]) / 2 / Math.SQRT2; // half-side of the pre-rotation square
  const r = half * 2 * ROUND;
  const c = size / 2 - 0.5; // sample pixel centres
  const buf = Buffer.alloc(size * size * 3);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // rotate the sample point by -45° so the square is axis-aligned
      const dx = x - c, dy = y - c;
      const rx = (dx + dy) * Math.SQRT1_2;
      const ry = (dy - dx) * Math.SQRT1_2;

      const cov = Math.min(Math.max(0.5 - roundedSquare(rx, ry, half, r), 0), 1);
      const i = (y * size + x) * 3;
      for (let ch = 0; ch < 3; ch++) {
        buf[i + ch] = Math.round(BG[ch] + (FG[ch] - BG[ch]) * cov);
      }
    }
  }
  return buf;
}

/* ---------------- PNG ---------------- */

const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Encode raw RGB as an 8-bit truecolour PNG. No alpha channel at all. */
function png(size, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type 2 = truecolour, no alpha
  // 10 compression, 11 filter, 12 interlace all default to 0

  // one filter byte per scanline; filter 0 (None) — these images are tiny
  const stride = size * 3;
  const raw = Buffer.alloc(size * (stride + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ---------------- Main ---------------- */

const ICONS = [
  { file: "icon-192.png", size: 192, kind: "any", note: "Android home screen" },
  { file: "icon-512.png", size: 512, kind: "any", note: "install prompt and splash" },
  { file: "icon-maskable-192.png", size: 192, kind: "maskable", note: "adaptive launcher icon" },
  { file: "icon-maskable-512.png", size: 512, kind: "maskable", note: "adaptive, high density" },
  { file: "apple-touch-icon.png", size: 180, kind: "any", note: "iOS add to home screen" },
  { file: "favicon-32.png", size: 32, kind: "any", note: "browser tab" },
];

fs.mkdirSync(OUT, { recursive: true });
let total = 0;
for (const ic of ICONS) {
  const buf = png(ic.size, draw(ic.size, ic.kind));
  fs.writeFileSync(path.join(OUT, ic.file), buf);
  total += buf.length;
  console.log(`  ${ic.file.padEnd(24)} ${String(ic.size + "×" + ic.size).padEnd(9)} ${ic.kind.padEnd(9)} ${String(buf.length).padStart(6)} B   ${ic.note}`);
}
console.log(`\nwrote ${ICONS.length} icons to icons/ — ${total.toLocaleString()} bytes total`);
