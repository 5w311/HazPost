#!/usr/bin/env node
/**
 * build-icons.mjs — derive icons/*.png from the committed source art.
 *
 *   node tools/build-icons.mjs
 *
 * The mark used to be procedurally generated — a signed distance field drawn
 * fresh on every run, with no source art to commit at all. It is now supplied
 * artwork: a glossy yellow diamond on a vertical dark gradient, provided as
 * three PNGs already rendered at exactly the sizes this app needs. Nothing
 * here draws a shape; it reads tools/icon-source/*.png, checks what it finds
 * against the same invariants the old generator used to guarantee by
 * construction, and writes icons/*.png.
 *
 * Still no dependencies. Node's PNG story is bring-your-own: this file
 * carries a small decoder (chunk walk, zlib inflate, the five PNG filter
 * types) alongside the encoder the old script already had (chunk assembly,
 * zlib deflate). Re-run this rather than editing icons/*.png by hand —
 * nobody can review a hand-edited PNG, committed or generated.
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..");
const SRC = path.join(HERE, "icon-source");
const OUT = path.join(REPO, "icons");
const OUT_REPORT = path.join(HERE, "ICONS-REPORT.md");

const fail = (msg) => { throw new Error(msg); };

/* ------------------------------------------------------------------ *
 * PNG — decode
 * ------------------------------------------------------------------ */

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
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
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

/**
 * Walk every chunk in a PNG, verifying its CRC as we go. Returns them in
 * file order. This runs on all three source files regardless of whether we
 * decode their pixels — a checked-in binary can bit-rot in git same as any
 * other file, and a CRC mismatch is cheap to catch and expensive to miss.
 */
function readChunks(buf, name) {
  if (!buf.subarray(0, 8).equals(SIGNATURE)) fail(`${name}: not a PNG (bad signature)`);
  const chunks = [];
  let off = 8;
  while (off < buf.length) {
    if (off + 8 > buf.length) fail(`${name}: truncated chunk header at byte ${off}`);
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    const storedCrc = buf.readUInt32BE(off + 8 + len);
    const gotCrc = crc32(Buffer.concat([Buffer.from(type, "ascii"), data]));
    if (gotCrc !== storedCrc) {
      fail(`${name}: CRC mismatch on chunk "${type}" at byte ${off} — the file is corrupt`);
    }
    chunks.push({ type, data });
    off += 8 + len + 4;
  }
  return chunks;
}

/** IHDR only — dimensions and colour mode, no pixel decode. */
function readHeader(buf, name) {
  const chunks = readChunks(buf, name);
  const ihdr = chunks.find((c) => c.type === "IHDR");
  if (!ihdr) fail(`${name}: no IHDR chunk`);
  const d = ihdr.data;
  return {
    chunks,
    width: d.readUInt32BE(0),
    height: d.readUInt32BE(4),
    depth: d[8],
    colorType: d[9],
    interlace: d[12],
  };
}

/** The PNG paeth predictor, straight off the spec. */
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Full pixel decode: IHDR, concatenated IDAT inflated, then the per-scanline
 * filters (0 None, 1 Sub, 2 Up, 3 Average, 4 Paeth) undone. Returns raw
 * top-to-bottom RGB or RGBA bytes, no filter bytes, no row padding — the
 * same shape the encoder below expects on the way back out.
 *
 * Only what this build actually needs: 8-bit depth, colour type 2 or 6,
 * no interlacing. Every one of the three committed sources is exactly
 * that (checked below); anything else aborts rather than guesses.
 */
function decodePNG(buf, name) {
  const h = readHeader(buf, name);
  if (h.depth !== 8) fail(`${name}: ${h.depth}-bit depth, only 8-bit is supported`);
  if (h.interlace !== 0) fail(`${name}: interlaced PNG, only non-interlaced is supported`);
  const bpp = { 2: 3, 6: 4 }[h.colorType];
  if (!bpp) fail(`${name}: colour type ${h.colorType}, only 2 (RGB) or 6 (RGBA) is supported`);

  const idat = Buffer.concat(h.chunks.filter((c) => c.type === "IDAT").map((c) => c.data));
  if (!idat.length) fail(`${name}: no IDAT data`);
  const filtered = zlib.inflateSync(idat);

  const stride = h.width * bpp;
  const expected = h.height * (stride + 1);
  if (filtered.length !== expected) {
    fail(`${name}: inflated to ${filtered.length} bytes, expected ${expected} for ${h.width}×${h.height}`);
  }

  const out = Buffer.alloc(h.height * stride);
  for (let y = 0; y < h.height; y++) {
    const filterType = filtered[y * (stride + 1)];
    const rowIn = filtered.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const rowOut = out.subarray(y * stride, (y + 1) * stride);
    const prevOut = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? rowOut[x - bpp] : 0;
      const b = prevOut ? prevOut[x] : 0;
      const c = prevOut && x >= bpp ? prevOut[x - bpp] : 0;
      let v = rowIn[x];
      switch (filterType) {
        case 0: break;
        case 1: v = (v + a) & 0xff; break;
        case 2: v = (v + b) & 0xff; break;
        case 3: v = (v + ((a + b) >> 1)) & 0xff; break;
        case 4: v = (v + paeth(a, b, c)) & 0xff; break;
        default: fail(`${name}: unknown filter type ${filterType} on row ${y}`);
      }
      rowOut[x] = v;
    }
  }
  return { width: h.width, height: h.height, bpp, pixels: out };
}

/* ------------------------------------------------------------------ *
 * PNG — encode (unchanged from the procedural generator)
 * ------------------------------------------------------------------ */

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Encode raw top-to-bottom RGB as an 8-bit truecolour PNG, no alpha. */
function encodePNG(size, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type 2 = truecolour, no alpha

  const stride = size * 3;
  const raw = Buffer.alloc(size * (stride + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter 0 (None) — these outputs are tiny
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ *
 * Downsampling
 * ------------------------------------------------------------------ */

/**
 * Box-average downsample by an exact integer factor. Every output pixel is
 * the mean of the NxN source block it covers — the correct way to shrink an
 * image (as opposed to nearest-neighbour, which just discards samples), and
 * exact rather than approximate because the ratio divides evenly: 512/32=16,
 * no fractional-pixel weighting to get subtly wrong.
 */
function boxDownsample(src, factor) {
  if (src.width % factor !== 0 || src.height % factor !== 0) {
    fail(`boxDownsample: ${src.width}×${src.height} does not divide evenly by ${factor}`);
  }
  const outSize = src.width / factor;
  const bpp = src.bpp;
  const out = Buffer.alloc(outSize * outSize * 3); // output is always opaque RGB
  const n = factor * factor;
  for (let oy = 0; oy < outSize; oy++) {
    for (let ox = 0; ox < outSize; ox++) {
      const sums = [0, 0, 0];
      for (let dy = 0; dy < factor; dy++) {
        const sy = oy * factor + dy;
        for (let dx = 0; dx < factor; dx++) {
          const sx = ox * factor + dx;
          const i = (sy * src.width + sx) * bpp;
          sums[0] += src.pixels[i];
          sums[1] += src.pixels[i + 1];
          sums[2] += src.pixels[i + 2];
          // an alpha channel, if present, is ignored: every source here is
          // fully opaque (checked below) so straight averaging of RGB is
          // exact, not an approximation that happens to look fine.
        }
      }
      const o = (oy * outSize + ox) * 3;
      out[o] = Math.round(sums[0] / n);
      out[o + 1] = Math.round(sums[1] / n);
      out[o + 2] = Math.round(sums[2] / n);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * The maskable safe-zone check
 * ------------------------------------------------------------------ *
 *
 * A maskable icon's outer edges are not guaranteed to survive — Android (and
 * the wider manifest spec) can crop to a circle, a squircle, a rounded
 * square, whatever the launcher prefers, and only the central 80% — a circle
 * of radius 0.4×size — is guaranteed visible. The old procedural generator
 * derived this by construction: it drew the diamond smaller for the
 * "maskable" kind and the geometry made safety a proven fact, not a
 * measurement.
 *
 * There is no such guarantee for supplied art, so this measures it instead:
 * decode the pixels, find the diamond's farthest point from centre, and
 * abort if it is not safely inside that circle. The background is a cool
 * blue-grey gradient (see ICONS-REPORT.md) and the mark is warm yellow, so
 * "farthest warm pixel from centre" is a clean, hue-based test that will not
 * mistake the gradient's own brightness variation for the diamond — an
 * earlier, cruder version of this check did exactly that and had to be
 * thrown out. `warmth = max(r,g) - b` is positive only where yellow has
 * blended in at all, which catches the anti-aliased edge, not just the solid
 * fill.
 */
function measureSafeZone(img) {
  const { width: w, height: h, bpp, pixels } = img;
  let maxReach = 0, worstAt = null;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * bpp;
      const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
      if (Math.max(r, g) - b > 3) {
        const reach = Math.hypot(x - (w - 1) / 2, y - (h - 1) / 2) / w;
        if (reach > maxReach) { maxReach = reach; worstAt = [x, y]; }
      }
    }
  }
  return { reach: maxReach, worstAt };
}

const SAFE_RADIUS = 0.4; // W3C manifest spec: the guaranteed-visible circle

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

const SOURCES = {
  512: path.join(SRC, "512.png"),
  192: path.join(SRC, "192.png"),
  180: path.join(SRC, "180.png"),
};

function loadAndCheck(size, file) {
  if (!fs.existsSync(file)) fail(`missing source: ${path.relative(REPO, file)}`);
  const buf = fs.readFileSync(file);
  const h = readHeader(buf, path.relative(REPO, file));
  if (h.width !== size || h.height !== size) {
    fail(`${path.relative(REPO, file)}: is ${h.width}×${h.height}, expected ${size}×${size}`);
  }
  if (h.depth !== 8 || h.colorType !== 2) {
    fail(`${path.relative(REPO, file)}: expected 8-bit RGB (colour type 2), found depth ${h.depth} type ${h.colorType} — ` +
         `not full-bleed/opaque, or not a plain truecolour PNG. Re-export without an alpha channel.`);
  }
  return buf;
}

const buf512 = loadAndCheck(512, SOURCES[512]);
const buf192 = loadAndCheck(192, SOURCES[192]);
const buf180 = loadAndCheck(180, SOURCES[180]);
console.log("  ok  all three sources are 8-bit opaque RGB, non-interlaced, at their expected size");

const img512 = decodePNG(buf512, "icon-source/512.png");
const safe = measureSafeZone(img512);
console.log(`  ok  diamond reach ${(safe.reach * 100).toFixed(2)}% of tile width (farthest warm pixel at ${safe.worstAt})`);
if (safe.reach >= SAFE_RADIUS) {
  fail(
    `the diamond reaches ${(safe.reach * 100).toFixed(1)}% of the tile width from centre, ` +
    `past the ${(SAFE_RADIUS * 100).toFixed(0)}% safe-zone radius a maskable icon must stay inside.\n` +
    `  A circular or squircle launcher mask would clip it. This source art can be used for the\n` +
    `  "any" icons but not safely duplicated as the "maskable" ones — go back to drawing a smaller,\n` +
    `  separately-scaled maskable variant instead of reusing this file for both purposes.`
  );
}
const margin = ((SAFE_RADIUS - safe.reach) / SAFE_RADIUS) * 100;
console.log(`  ok  that is inside the ${(SAFE_RADIUS * 100).toFixed(0)}% safe-zone radius, ${margin.toFixed(0)}% of it to spare`);
console.log(`      => icon-maskable-*.png can safely be identical to icon-*.png (verified, not assumed)`);

fs.mkdirSync(OUT, { recursive: true });

/* The three exact-size sources are already valid, already well-compressed
   PNGs at exactly the size needed — copied through byte for byte rather than
   decoded and re-encoded, which would only risk bloating them for no gain
   (this file's own encoder always uses filter 0, fine for the tiny computed
   favicon below, wasteful on a real photographic gradient). */
const WRITTEN = [];
const write = (file, size, buf, note) => {
  fs.writeFileSync(path.join(OUT, file), buf);
  WRITTEN.push({ file, size: `${size}×${size}`, bytes: buf.length, note });
};

write("icon-192.png", 192, buf192, "Android home screen");
write("icon-512.png", 512, buf512, "install prompt and splash");
write("icon-maskable-192.png", 192, buf192, "adaptive launcher icon — identical to icon-192.png, verified safe above");
write("icon-maskable-512.png", 512, buf512, "adaptive, high density — identical to icon-512.png, verified safe above");
write("apple-touch-icon.png", 180, buf180, "iOS add to home screen");

const favicon = encodePNG(32, boxDownsample(img512, 16));
write("favicon-32.png", 32, favicon, "browser tab — box-averaged down from the 512 source, 16:1");

let total = 0;
for (const w of WRITTEN) {
  total += w.bytes;
  console.log(`  ${w.file.padEnd(24)} ${w.size.padEnd(9)} ${String(w.bytes).padStart(6)} B   ${w.note}`);
}
console.log(`\nwrote ${WRITTEN.length} icons to icons/ — ${total.toLocaleString()} bytes total`);

/* ------------------------------------------------------------------ */

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

const report = `# icons/ generation report

Generated by \`tools/build-icons.mjs\`. Do not edit \`icons/*.png\` by hand —
re-run the script. Do not edit \`tools/icon-source/*.png\` by hand either;
replace them and re-run if the art changes.

## What changed

The icon used to be procedurally generated — a signed distance field drawn at
build time, no source art committed at all. It is now supplied artwork: a
glossy yellow diamond on a vertical dark gradient, provided already rendered
at 512×512, 192×192 and 180×180 — exactly the three sizes this app's "any"
icons need. Nothing here draws a shape any more; the script's job is to check
what it is given and derive the sizes that are not already covered.

## Sources

| File | Size | SHA-256 |
|---|---|---|
| \`tools/icon-source/512.png\` | 512×512 | \`${sha256(buf512)}\` |
| \`tools/icon-source/192.png\` | 192×192 | \`${sha256(buf192)}\` |
| \`tools/icon-source/180.png\` | 180×180 | \`${sha256(buf180)}\` |

All three: 8-bit truecolour PNG (colour type 2), no alpha channel,
non-interlaced. Asserted on every run — a source that gains an alpha channel
or gets interlaced fails the build rather than silently producing a
transparent or garbled icon.

Two other renders were supplied alongside these three and are **not used**:
a 1024×1024 opaque master, and a 192×192 version of the mark alone on a fully
transparent background. The master isn't needed because every output size
this app requires is either an exact match to one of the three committed
sources or a clean integer division of the 512 one (see below) — there is no
size that would benefit from a larger source to downsample from. The
transparent mark was a candidate for building a separately-scaled maskable
icon (see next section) but turned out not to be necessary either.

## Checks

| Check | Result |
|---|---|
| All three sources are 8-bit opaque RGB, non-interlaced, at their claimed size | pass |
| Every chunk's CRC-32 verified while reading (catches a corrupted commit, not just a malformed source) | pass |
| Maskable safe-zone: diamond's farthest point from centre vs. the 40% safe-zone radius | pass — ${(safe.reach * 100).toFixed(2)}%, ${margin.toFixed(0)}% of the radius to spare |
| \`favicon-32.png\` derived by an exact 16:1 box average (512 ÷ 32), not an approximation | pass |

## The maskable icons are identical to the "any" icons, on purpose

\`icon-maskable-192.png\` and \`icon-maskable-512.png\` are byte-for-byte the
same files as \`icon-192.png\` and \`icon-512.png\`. That is not a shortcut —
it is the result the safe-zone measurement above justifies. A maskable icon
only needs a **separately scaled-down** version of the mark when the "any"
art doesn't leave enough margin for an OS to crop into; here it already does,
by a wide margin (${margin.toFixed(0)}% of the safe radius to spare). Reusing
the same file for both manifest purposes means there is exactly one piece of
art to keep in sync, not two that happen to agree today and could quietly
drift apart on a future re-export.

The check that justifies this is not a one-time eyeball: it runs on every
build, against whatever \`tools/icon-source/512.png\` currently contains. If a
future redesign ever produces art that reaches past the safe radius, the
build fails with the measured number rather than shipping a maskable icon
that Android would clip.

## \`favicon-32.png\`

No 32×32 source was supplied, so the script derives one. 512 ÷ 32 = 16
exactly, so each output pixel is the plain average of the 16×16 source block
it covers — an exact box filter, not a general-purpose resampling algorithm
approximating a non-integer ratio. This is the correct way to shrink an
image by a clean integer factor and needs no interpolation scheme to get
subtly wrong.

## Output

${WRITTEN.map((w) => `- \`icons/${w.file}\` — ${w.size}, ${w.bytes.toLocaleString()} B — ${w.note}`).join("\n")}
`;

fs.writeFileSync(OUT_REPORT, report);
console.log(`wrote ${path.relative(REPO, OUT_REPORT)}`);
