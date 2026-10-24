/**
 * test/fits.test.mjs — unit tests for server/lib/fits.mjs
 *
 * Every FITS buffer is built inline by the helpers below; nothing is read from
 * disk and no other module in the repo is imported. Run with:
 *   node --test test/fits.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isFits,
  parseFitsHeader,
  readFits,
  fitsToRgb,
  stretchLinear,
  asinhStretch,
  percentile,
  debayer,
} from '../server/lib/fits.mjs';

/* ------------------------------------------------------------------ *
 * FITS builders
 * ------------------------------------------------------------------ */

const pad = (s, n) => String(s).padEnd(n, ' ');
const rpad = (s, n) => String(s).padStart(n, ' ');

/** Format a numeric value the way a FITS writer would. */
function formatValue(v) {
  // FITS escapes an embedded single quote by doubling it.
  if (typeof v === 'string') return `'${v.replace(/'/g, "''")}'`;
  if (typeof v === 'boolean') return v ? 'T' : 'F';
  if (typeof v === 'number' && Number.isInteger(v)) return String(v);
  if (typeof v === 'number') return String(v).replace('e', 'E');
  return '';
}

/** One 80-char header card. */
function card(key, value, comment) {
  const field = pad(formatValue(value), 20);
  const body = `${pad(key.toUpperCase(), 8)}= ${field}`;
  const line = comment ? `${body} / ${comment}` : body;
  return pad(line.slice(0, 80), 80);
}

/** A raw (non key=value) 80-char card, e.g. a bare COMMENT or HISTORY line. */
function raw(text) {
  return pad(String(text).slice(0, 80), 80);
}

/** Header + data + 2880 padding for a single HDU. */
function hduBuffer(cards, dataBuf) {
  const text = cards.map((c) => pad(c, 80)).join('') + pad('END', 80);
  const headerLen = Math.ceil(text.length / 2880) * 2880;
  const header = Buffer.alloc(headerLen, 0x20);
  header.write(text, 0, 'latin1');
  const data = dataBuf && dataBuf.length ? Buffer.from(dataBuf) : Buffer.alloc(0);
  const paddedLen = Math.ceil(data.length / 2880) * 2880;
  return Buffer.concat([header, data, Buffer.alloc(paddedLen - data.length, 0)]);
}

/** Primary-HDU FITS file. */
function fitsFile(cards, dataBuf) {
  return hduBuffer(cards, dataBuf);
}

/** Mandatory image cards for a 2D or 3D image HDU. */
function imageCards({ bitpix, naxis1, naxis2, naxis3 = 0, extra = [] }) {
  const cards = [card('SIMPLE', true), card('BITPIX', bitpix)];
  if (naxis3 > 0) {
    cards.push(card('NAXIS', 3), card('NAXIS1', naxis1), card('NAXIS2', naxis2),
      card('NAXIS3', naxis3));
  } else {
    cards.push(card('NAXIS', 2), card('NAXIS1', naxis1), card('NAXIS2', naxis2));
  }
  return cards.concat(extra);
}

/* big-endian sample encoders */
function encU8(values) {
  return Buffer.from(Uint8Array.from(values));
}
function encI16(values) {
  const b = Buffer.alloc(values.length * 2);
  values.forEach((v, i) => b.writeInt16BE(v, i * 2));
  return b;
}
function encI32(values) {
  const b = Buffer.alloc(values.length * 4);
  values.forEach((v, i) => b.writeInt32BE(v, i * 4));
  return b;
}
function encF32(values) {
  const b = Buffer.alloc(values.length * 4);
  values.forEach((v, i) => b.writeFloatBE(v, i * 4));
  return b;
}
function encF64(values) {
  const b = Buffer.alloc(values.length * 8);
  values.forEach((v, i) => b.writeDoubleBE(v, i * 8));
  return b;
}

/** Bayer 2x2 tiles as written on disk: [p00, p01, p10, p11]; 0=R 1=G 2=B. */
const BAYER_TILES = {
  RGGB: [0, 1, 1, 2],
  BGGR: [2, 1, 1, 0],
  GRBG: [1, 0, 2, 1],
  GBRG: [1, 2, 0, 1],
};

/** Constant-colour frame sampled through a Bayer mosaic. */
function mosaic(pattern, width, height, rgb) {
  const tile = BAYER_TILES[pattern];
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      out[y * width + x] = rgb[tile[((y & 1) << 1) | (x & 1)]];
    }
  }
  return out;
}

/** Deterministic PRNG so the test never depends on Math.random(). */
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** assert.throws helper for errors that must carry a `.code`. */
function throwsCode(fn, code) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof Error, `expected an Error, got ${String(err)}`);
    assert.equal(err.code, code);
    return true;
  });
}

/* ------------------------------------------------------------------ *
 * 1. isFits
 * ------------------------------------------------------------------ */

test('isFits accepts SIMPLE primary headers and rejects everything else', () => {
  const valid = fitsFile(imageCards({ bitpix: 16, naxis1: 2, naxis2: 2 }), encI16([1, 2, 3, 4]));
  assert.equal(isFits(valid), true);
  assert.equal(isFits(Buffer.from('SIMPLE  =                    T')), true);
  assert.equal(isFits(Buffer.from('simple  = t / lowercase tolerated')), true);

  assert.equal(isFits(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), false);
  assert.equal(isFits(Buffer.alloc(2880)), false);
  assert.equal(isFits(Buffer.alloc(4)), false);
  assert.equal(isFits(Buffer.from('SIMPLE  =                    F')), false);
  assert.equal(isFits(Buffer.from('XTENSION= \'IMAGE\'')), false);
  assert.equal(isFits(new Uint8Array(valid)), true);
});

/* ------------------------------------------------------------------ *
 * 2. header key parsing
 * ------------------------------------------------------------------ */

test('parseFitsHeader parses string, integer, float, boolean and quoted values', () => {
  const cards = imageCards({
    bitpix: -32,
    naxis1: 2,
    naxis2: 2,
    extra: [
      card('OBJECT', 'M 42'),
      card('EXPTIME', 120.5),
      card('GAIN', 139),
      card('IMAGETYP', 'LIGHT'),
      card('EXTEND', true),
      card('STACKED', false),
      card('OBSERVER', "O'Hara"),
      raw('COMMENT this is a comment card'),
      raw('HISTORY stacked 42 frames'),
    ],
  });
  const buf = fitsFile(cards, encF32([1, 2, 3, 4]));
  const { header, dataOffset, dataSize } = parseFitsHeader(buf);

  assert.equal(header.simple, true);
  assert.equal(header.object, 'M 42');
  assert.equal(header.exptime, 120.5);
  assert.equal(header.gain, 139);
  assert.equal(header.imagetyp, 'LIGHT');
  assert.equal(header.extend, true);
  assert.equal(header.stacked, false);
  assert.equal(header.observer, "O'Hara");
  assert.deepEqual(header.comment, ['this is a comment card']);
  assert.deepEqual(header.history, ['stacked 42 frames']);
  assert.equal(header.end, undefined);
  assert.equal(dataOffset, 2880);
  assert.equal(dataSize, 16);
});

test('parseFitsHeader handles HIERARCH cards and absent values', () => {
  const cards = [
    card('SIMPLE', true),
    raw('HIERARCH ESO DET WIN1 BINX = 2'),
    card('BITPIX', 16),
    card('NAXIS', 2),
    card('NAXIS1', 1),
    card('NAXIS2', 1),
    card('BLANKVAL', ''),
  ];
  const { header } = parseFitsHeader(hduBuffer(cards, encI16([7])));
  assert.equal(header['eso det win1 binx'], 2);
  assert.equal(header.blankval, '');
  assert.equal(header.naxis1, 1);
});

/* ------------------------------------------------------------------ *
 * 3. END detection and 2880-byte padding
 * ------------------------------------------------------------------ */

test('END terminates the header and data starts at the next 2880 boundary', () => {
  const short = fitsFile(imageCards({ bitpix: 16, naxis1: 4, naxis2: 4 }), encI16(new Array(16).fill(3)));
  const parsedShort = parseFitsHeader(short);
  assert.equal(parsedShort.dataOffset, 2880);
  assert.equal(parsedShort.dataOffset % 2880, 0);
  assert.equal(parsedShort.headerBytes, 2880);

  // 45 filler cards push the header past one 2880-byte block.
  const filler = [];
  for (let i = 0; i < 45; i++) filler.push(raw(`COMMENT filler ${i}`));
  const cards = imageCards({ bitpix: 16, naxis1: 4, naxis2: 4, extra: filler });
  assert.ok(cards.length * 80 > 2880, 'header must span more than one block');
  const buf = fitsFile(cards, encI16(new Array(16).fill(5)));
  const parsed = parseFitsHeader(buf);

  assert.equal(parsed.headerBytes, 5760);
  assert.equal(parsed.dataOffset, 5760);
  assert.equal(parsed.dataOffset % 2880, 0);
  assert.equal(parsed.header.comment.length, 45);

  // ...and the samples are read from that offset, not from byte 2880.
  const img = readFits(buf);
  assert.equal(img.width, 4);
  assert.equal(img.height, 4);
  assert.equal(img.data.length, 16);
  assert.equal(img.data[0], 5);
  assert.equal(img.data[15], 5);
  assert.equal(img.dataOffset, 5760);
});

/* ------------------------------------------------------------------ *
 * 4. BITPIX coverage
 * ------------------------------------------------------------------ */

test('readFits decodes every supported BITPIX with the right signedness', () => {
  const raw8 = [0, 1, 127, 255];
  const b8 = fitsFile(imageCards({ bitpix: 8, naxis1: 2, naxis2: 2 }), encU8(raw8));
  const r8 = readFits(b8);
  assert.equal(r8.width, 2);
  assert.equal(r8.height, 2);
  assert.deepEqual([...r8.data], raw8);
  assert.equal(r8.stats.max, 255);

  const raw16 = [-32768, -1, 0, 32767];
  const b16 = fitsFile(imageCards({ bitpix: 16, naxis1: 2, naxis2: 2 }), encI16(raw16));
  const r16 = readFits(b16);
  assert.deepEqual([...r16.data], raw16);
  assert.equal(r16.stats.min, -32768);
  assert.equal(r16.stats.max, 32767);

  const raw32 = [-2147483648, -7, 0, 2147483647];
  const b32 = fitsFile(imageCards({ bitpix: 32, naxis1: 2, naxis2: 2 }), encI32(raw32));
  const r32 = readFits(b32);
  // Output is Float32Array, so int32 values round to the nearest float32.
  assert.deepEqual([...r32.data], raw32.map(Math.fround));
  assert.equal(r32.data[0], -2147483648);

  const rawF32 = [0, 0.5, -1.25, 3.5e7];
  const bF32 = fitsFile(imageCards({ bitpix: -32, naxis1: 2, naxis2: 2 }), encF32(rawF32));
  const rF32 = readFits(bF32);
  assert.deepEqual([...rF32.data], rawF32);

  const rawF64 = [0, 0.1, -1234.5678, 1e-9];
  const bF64 = fitsFile(imageCards({ bitpix: -64, naxis1: 2, naxis2: 2 }), encF64(rawF64));
  const rF64 = readFits(bF64);
  assert.deepEqual([...rF64.data], rawF64.map(Math.fround));
  assert.equal(rF64.bitpix, -64);
});

test('readFits reports min/max/mean/median/p1/p99 over the samples', () => {
  const values = [];
  for (let i = 1; i <= 100; i++) values.push(i);
  const buf = fitsFile(imageCards({ bitpix: 16, naxis1: 100, naxis2: 1 }), encI16(values));
  const { stats } = readFits(buf);
  assert.equal(stats.min, 1);
  assert.equal(stats.max, 100);
  assert.equal(stats.mean, 50.5);
  assert.equal(stats.median, 51);
  assert.ok(stats.p1 >= 1 && stats.p1 <= 3, `p1 was ${stats.p1}`);
  assert.ok(stats.p99 >= 99 && stats.p99 <= 100, `p99 was ${stats.p99}`);
  assert.equal(percentile(Float32Array.from(values), 50), 51);
});

/* ------------------------------------------------------------------ *
 * 5. BZERO / BSCALE
 * ------------------------------------------------------------------ */

test('BZERO/BSCALE are applied as physical = BZERO + BSCALE * raw', () => {
  const raw = [0, 1, 32767, -32768];
  const cards = imageCards({
    bitpix: 16,
    naxis1: 2,
    naxis2: 2,
    extra: [card('BZERO', 32768), card('BSCALE', 1)],
  });
  const buf = fitsFile(cards, encI16(raw));
  const scaled = readFits(buf);
  assert.deepEqual([...scaled.data], [32768, 32769, 65535, 0]);
  assert.equal(scaled.stats.min, 0);
  assert.equal(scaled.stats.max, 65535);
  assert.equal(scaled.header.bzero, 32768);

  const unscaled = readFits(buf, { scaled: false });
  assert.deepEqual([...unscaled.data], raw);

  const half = fitsFile(imageCards({
    bitpix: 16,
    naxis1: 2,
    naxis2: 1,
    extra: [card('BZERO', 100), card('BSCALE', 0.5)],
  }), encI16([10, 20]));
  assert.deepEqual([...readFits(half).data], [105, 110]);

  // Round-trip: the physical values must land inside 0..1 after stretching.
  const raster = fitsToRgb(buf);
  assert.equal(raster.data.length, 4 * 3);
  assert.ok(raster.meta.notes.some((n) => n.startsWith('scaled:')));
});

/* ------------------------------------------------------------------ *
 * 6. multi-HDU
 * ------------------------------------------------------------------ */

test('readFits skips empty and non-image HDUs to find the first image HDU', () => {
  const primary = hduBuffer([card('SIMPLE', true), card('BITPIX', 8), card('NAXIS', 0), card('EXTEND', true)], null);
  const extension = hduBuffer([
    card('XTENSION', 'IMAGE'),
    card('BITPIX', 16),
    card('NAXIS', 2),
    card('NAXIS1', 3),
    card('NAXIS2', 2),
    card('OBJECT', 'NGC 7000'),
  ], encI16([10, 20, 30, 40, 50, 60]));
  const buf = Buffer.concat([primary, extension]);

  const img = readFits(buf);
  assert.equal(img.width, 3);
  assert.equal(img.height, 2);
  assert.deepEqual([...img.data], [10, 20, 30, 40, 50, 60]);
  assert.equal(img.header.object, 'NGC 7000');
  assert.equal(img.hduIndex, 1);
  assert.equal(img.dataOffset, 2880 * 2);

  // A 1-D spectrum primary must also be skipped.
  const spectrum = hduBuffer([card('SIMPLE', true), card('BITPIX', 16), card('NAXIS', 1), card('NAXIS1', 4)], encI16([1, 2, 3, 4]));
  const both = Buffer.concat([spectrum, extension]);
  const img2 = readFits(both);
  assert.equal(img2.width, 3);
  assert.deepEqual([...img2.data], [10, 20, 30, 40, 50, 60]);
  assert.equal(img2.hduIndex, 1);

  // A BINTABLE extension is skipped using GCOUNT/PCOUNT sizing.
  const table = hduBuffer([
    card('XTENSION', 'BINTABLE'),
    card('BITPIX', 8),
    card('NAXIS', 2),
    card('NAXIS1', 10),
    card('NAXIS2', 3),
    card('PCOUNT', 0),
    card('GCOUNT', 1),
  ], Buffer.alloc(30));
  const withTable = Buffer.concat([primary, table, extension]);
  assert.deepEqual([...readFits(withTable).data], [10, 20, 30, 40, 50, 60]);
  assert.equal(readFits(withTable).hduIndex, 2);
});

/* ------------------------------------------------------------------ *
 * 7. NAXIS=3 RGB cube
 * ------------------------------------------------------------------ */

test('fitsToRgb maps a NAXIS3=3 cube to interleaved RGB', () => {
  const planes = [
    1, 2, 3, 4, // R
    11, 12, 13, 14, // G
    21, 22, 23, 24, // B
  ];
  const cards = imageCards({ bitpix: 16, naxis1: 2, naxis2: 2, naxis3: 3 });
  const buf = fitsFile(cards, encI16(planes));

  const raster = fitsToRgb(buf, { stretch: false });
  assert.equal(raster.width, 2);
  assert.equal(raster.height, 2);
  assert.equal(raster.data.length, 2 * 2 * 3);
  assert.equal(raster.meta.source, 'fits');
  assert.equal(raster.meta.isLinear, true);
  assert.equal(raster.meta.bitDepth, 16);
  assert.deepEqual([...raster.data], [1, 11, 21, 2, 12, 22, 3, 13, 23, 4, 14, 24]);
  assert.ok(raster.meta.notes.includes('rgb-cube:naxis3=3'));

  const stretched = fitsToRgb(buf);
  for (const v of stretched.data) {
    assert.ok(Number.isFinite(v) && v >= 0 && v <= 1);
  }
  assert.equal(stretched.data.length, 12);
});

test('NAXIS3=1 is treated as mono and NAXIS3>3 keeps the first three planes', () => {
  const monoCards = imageCards({ bitpix: 16, naxis1: 2, naxis2: 2, naxis3: 1 });
  const mono = fitsToRgb(fitsFile(monoCards, encI16([1, 2, 3, 4])), { stretch: false });
  assert.deepEqual([...mono.data], [1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4]);
  assert.ok(mono.meta.notes.includes('mono:replicated'));

  const quadCards = imageCards({ bitpix: 16, naxis1: 2, naxis2: 1, naxis3: 4 });
  const quad = fitsToRgb(fitsFile(quadCards, encI16([1, 2, 11, 12, 21, 22, 31, 32])), { stretch: false });
  assert.equal(quad.data.length, 2 * 1 * 3);
  assert.deepEqual([...quad.data], [1, 11, 21, 2, 12, 22]);
  assert.ok(quad.meta.notes.some((n) => n === 'extra-planes-ignored:1'));
});

/* ------------------------------------------------------------------ *
 * 8. debayer
 * ------------------------------------------------------------------ */

test('debayer reconstructs constant colour for all four Bayer patterns', () => {
  const truth = [10, 20, 30];
  for (const pattern of ['RGGB', 'BGGR', 'GRBG', 'GBRG']) {
    const raw = mosaic(pattern, 5, 4, truth);
    const rgb = debayer(raw, 5, 4, pattern);
    assert.equal(rgb.length, 5 * 4 * 3);
    for (let p = 0; p < 5 * 4; p++) {
      assert.equal(rgb[p * 3], 10, `${pattern} R at ${p}`);
      assert.equal(rgb[p * 3 + 1], 20, `${pattern} G at ${p}`);
      assert.equal(rgb[p * 3 + 2], 30, `${pattern} B at ${p}`);
    }
  }
  assert.throws(() => debayer(new Float32Array(4), 2, 2, 'XYZR'));
});

test('debayer honours the on-disk tile orientation (hand-checked RGGB 3x3)', () => {
  // Values 1..9 on a 3x3 grid, RGGB => (0,0) R, (0,1) G, (1,0) G, (1,1) B.
  // Border neighbours are mirrored: for n=3 the mirror of -1 and 3 is 1.
  const raw = Float32Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const rgb = debayer(raw, 3, 3, 'RGGB');

  // (0,0) R site: R = 1; G = mean(left v01=2, right v01=2, up v10=4, down v10=4) = 3;
  //               B = mean(diagonals, all v11=5) = 5
  assert.equal(rgb[0], 1);
  assert.equal(rgb[1], 3);
  assert.equal(rgb[2], 5);

  // (1,0) G site: G = 2; R = mean(v00=1, v02=3) = 2; B = mean(up v11=5, down v11=5) = 5
  assert.equal(rgb[3], 2);
  assert.equal(rgb[4], 2);
  assert.equal(rgb[5], 5);

  // (0,1) G site: G = 4; R = mean(up v00=1, down v20=7) = 4;
  //               B = mean(left v11=5, right v11=5) = 5
  assert.equal(rgb[9], 4);
  assert.equal(rgb[10], 4);
  assert.equal(rgb[11], 5);

  // (1,1) B site: B = 5; G = mean(v10=4, v12=6, v01=2, v21=8) = 5;
  //               R = mean(v00=1, v02=3, v20=7, v22=9) = 5
  assert.equal(rgb[12], 5);
  assert.equal(rgb[13], 5);
  assert.equal(rgb[14], 5);

  // (0,2) R site: R = 7; G = mean(v21=8, v21=8, v10=4, v10=4) = 6; B = 5
  assert.equal(rgb[18], 7);
  assert.equal(rgb[19], 6);
  assert.equal(rgb[20], 5);
});

test('fitsToRgb debayers a mono frame when BAYERPAT is present', () => {
  const width = 4;
  const height = 4;
  const raw = mosaic('RGGB', width, height, [1000, 2000, 3000]);
  const cards = imageCards({
    bitpix: 16,
    naxis1: width,
    naxis2: height,
    extra: [card('BAYERPAT', 'RGGB'), card('BZERO', 32768)],
  });
  const raster = fitsToRgb(fitsFile(cards, encI16(raw.map((v) => v - 32768))));

  assert.equal(raster.width, width);
  assert.equal(raster.height, height);
  assert.equal(raster.data.length, width * height * 3);
  assert.ok(raster.meta.notes.some((n) => n === 'debayer:RGGB'));
  for (const v of raster.data) assert.ok(Number.isFinite(v) && v >= 0 && v <= 1);
  // Debayering must preserve channel ordering: R stays the darkest channel.
  const p = 0;
  assert.ok(raster.data[p * 3] < raster.data[p * 3 + 1]);
  assert.ok(raster.data[p * 3 + 1] < raster.data[p * 3 + 2]);

  // opts.debayer === false keeps the frame as grey.
  const grey = fitsToRgb(fitsFile(cards, encI16(raw.map((v) => v - 32768))), { debayer: false });
  assert.equal(grey.data[0], grey.data[1]);
  assert.equal(grey.data[1], grey.data[2]);

  // bayerFlip transposes the tile, so RGGB stays put but GRBG <-> GBRG.
  const flip = fitsToRgb(fitsFile(cards, encI16(raw.map((v) => v - 32768))), { bayerFlip: true });
  assert.ok(flip.meta.notes.some((n) => n === 'debayer:RGGB(flipped)'));
  const grbgCards = (pattern) => fitsFile(imageCards({
    bitpix: 16, naxis1: 4, naxis2: 4, extra: [card('BAYERPAT', pattern)],
  }), encI16(mosaic(pattern, 4, 4, [10, 20, 30])));
  const flipped = fitsToRgb(grbgCards('GRBG'), { bayerFlip: true, stretch: false });
  assert.ok(flipped.meta.notes.some((n) => n === 'debayer:GBRG(flipped)'));
  // Transposing the GRBG tile makes GBRG the correct interpretation of the
  // (unflipped) GRBG mosaic, so every channel must come back transposed.
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      const p = (y * 4 + x) * 3;
      assert.equal(flipped.data[p], 30, `R at ${x},${y}`);
      assert.equal(flipped.data[p + 1], 20, `G at ${x},${y}`);
      assert.equal(flipped.data[p + 2], 10, `B at ${x},${y}`);
    }
  }
  // Without the flip the same file debayers correctly as GRBG.
  const straight = fitsToRgb(grbgCards('GRBG'), { stretch: false });
  for (let i = 0; i < 16; i++) {
    assert.equal(straight.data[i * 3], 10);
    assert.equal(straight.data[i * 3 + 1], 20);
    assert.equal(straight.data[i * 3 + 2], 30);
  }
});

/* ------------------------------------------------------------------ *
 * 9. stretchLinear / asinhStretch
 * ------------------------------------------------------------------ */

test('stretchLinear is monotonic non-decreasing and stays in 0..1', () => {
  const rand = lcg(1337);
  const n = 20000;
  const src = new Float32Array(n);
  for (let i = 0; i < n; i++) src[i] = rand() * 5000;

  const sorted = Float32Array.from(src).sort();
  for (const opts of [{}, { asinh: false }, { beta: 0.02 }, { lowPct: 5, highPct: 95 }]) {
    const out = stretchLinear(src, opts);
    assert.equal(out.length, n);
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < n; i++) {
      const v = out[i];
      assert.ok(Number.isFinite(v), 'output must be finite');
      if (v < min) min = v;
      if (v > max) max = v;
    }
    assert.ok(min >= 0, `min ${min} >= 0`);
    assert.ok(max <= 1, `max ${max} <= 1`);

    const sortedOut = stretchLinear(sorted, opts);
    for (let i = 1; i < n; i++) {
      assert.ok(sortedOut[i] >= sortedOut[i - 1],
        `monotonicity broken at ${i}: ${sortedOut[i - 1]} -> ${sortedOut[i]}`);
    }
  }
  // Default percentile clip drives the extremes to exactly 0 and 1.
  const def = stretchLinear(src);
  assert.equal(Math.min(...def.slice(0, 2000)) >= 0, true);
  assert.equal(percentile(def, 0), 0);
  assert.equal(percentile(def, 100), 1);
});

test('stretchLinear maps linearly when asinh is disabled and clips outliers', () => {
  const values = Float32Array.from({ length: 101 }, (_, i) => i);
  const linear = stretchLinear(values, { asinh: false, lowPct: 0, highPct: 100 });
  assert.equal(linear[0], 0);
  assert.equal(linear[50], 0.5);
  assert.equal(linear[100], 1);

  const clipped = stretchLinear(values, { asinh: false, lowPct: 10, highPct: 90 });
  assert.equal(clipped[0], 0);
  assert.equal(clipped[5], 0);
  assert.equal(clipped[95], 1);
  assert.equal(clipped[100], 1);
  assert.equal(clipped[50], 0.5);

  const flat = stretchLinear(Float32Array.from([42, 42, 42, 42]), { asinh: false });
  assert.deepEqual([...flat], [1, 1, 1, 1]);
  const zeros = stretchLinear(Float32Array.from([0, 0, 0]));
  assert.deepEqual([...zeros], [0, 0, 0]);
  assert.equal(stretchLinear(new Float32Array(0)).length, 0);

  // NaN/Inf pixels must not poison the stretch.
  const dirty = Float32Array.from([0, 1, 2, NaN, Infinity, 3]);
  const clean = stretchLinear(dirty, { asinh: false, lowPct: 0, highPct: 100 });
  for (const v of clean) assert.ok(Number.isFinite(v) && v >= 0 && v <= 1);
});

test('asinhStretch lifts midtones monotonically and beta controls the lift', () => {
  const ramp = Float32Array.from({ length: 11 }, (_, i) => i / 10);
  const soft = asinhStretch(ramp, { beta: 0.5 });
  const hard = asinhStretch(ramp, { beta: 0.02 });
  assert.equal(soft[0], 0);
  assert.equal(hard[0], 0);
  assert.equal(soft[10], 1);
  assert.equal(hard[10], 1);
  for (let i = 1; i < 11; i++) {
    assert.ok(soft[i] >= soft[i - 1]);
    assert.ok(hard[i] >= hard[i - 1]);
  }
  assert.ok(hard[5] > soft[5], 'smaller beta must brighten midtones');
  assert.ok(asinhStretch(Float32Array.from([-3, 4]))[0] === 0);
});

/* ------------------------------------------------------------------ *
 * 10. error handling
 * ------------------------------------------------------------------ */

test('malformed input throws Errors carrying a .code', () => {
  throwsCode(() => readFits(Buffer.from('not a fits file at all, just some text')), 'NOT_FITS');
  throwsCode(() => fitsToRgb(Buffer.alloc(2880)), 'NOT_FITS');
  throwsCode(() => parseFitsHeader(Buffer.alloc(2880)), 'NOT_FITS');
  throwsCode(() => readFits('nope'), 'BAD_INPUT');

  // Valid header, truncated pixel data.
  const good = fitsFile(imageCards({ bitpix: 16, naxis1: 10, naxis2: 10 }), encI16(new Array(100).fill(1)));
  throwsCode(() => readFits(good.subarray(0, 2880 + 40)), 'TRUNCATED');
  throwsCode(() => fitsToRgb(good.subarray(0, 2880 + 40)), 'TRUNCATED');

  // Header that never reaches an END card.
  const noEnd = Buffer.alloc(2880, 0x20);
  noEnd.write(card('SIMPLE', true), 0, 'latin1');
  for (let i = 1; i < 36; i++) noEnd.write(raw(`COMMENT no end ${i}`), i * 80, 'latin1');
  throwsCode(() => parseFitsHeader(noEnd), 'TRUNCATED');
  throwsCode(() => readFits(noEnd), 'TRUNCATED');

  // Header ends but the buffer stops mid-card.
  throwsCode(() => parseFitsHeader(good.subarray(0, 100)), 'TRUNCATED');

  // No image HDU at all.
  const empty = fitsFile([card('SIMPLE', true), card('BITPIX', 8), card('NAXIS', 0)], null);
  throwsCode(() => readFits(empty), 'NO_IMAGE_HDU');
  throwsCode(() => fitsToRgb(empty), 'NO_IMAGE_HDU');

  // Unsupported BITPIX.
  const bad64 = fitsFile(imageCards({ bitpix: 64, naxis1: 2, naxis2: 2 }), Buffer.alloc(32));
  throwsCode(() => readFits(bad64), 'UNSUPPORTED_BITPIX');
  throwsCode(() => fitsToRgb(bad64), 'UNSUPPORTED_BITPIX');
});

/* ------------------------------------------------------------------ *
 * 11. WCS / meta
 * ------------------------------------------------------------------ */

test('fitsToRgb collects WCS keywords and header meta', () => {
  const cards = imageCards({
    bitpix: 16,
    naxis1: 2,
    naxis2: 2,
    extra: [
      card('OBJECT', 'M 31'),
      card('TELESCOP', 'TestScope'),
      card('INSTRUME', 'TestCam'),
      card('FILTER', 'Ha'),
      card('DATE-OBS', '2026-01-02T03:04:05'),
      card('EXPTIME', 300),
      card('CRPIX1', 800.5),
      card('CRPIX2', 533.5),
      card('CRVAL1', 10.6847),
      card('CRVAL2', 41.2691),
      card('CDELT1', -0.0002),
      card('CDELT2', 0.0002),
      card('CTYPE1', 'RA---TAN'),
      card('CTYPE2', 'DEC--TAN'),
      card('RADESYS', 'ICRS'),
    ],
  });
  const raster = fitsToRgb(fitsFile(cards, encI16([1, 2, 3, 4])));
  assert.equal(raster.meta.header.object, 'M 31');
  assert.equal(raster.meta.header.telescop, 'TestScope');
  assert.equal(raster.meta.header.exptime, 300);
  assert.equal(raster.meta.header['date-obs'], '2026-01-02T03:04:05');
  assert.ok(raster.meta.wcs);
  assert.equal(raster.meta.wcs.crval1, 10.6847);
  assert.equal(raster.meta.wcs.ctype2, 'DEC--TAN');
  assert.equal(raster.meta.wcs.radesys, 'ICRS');
  assert.equal(raster.meta.wcs.naxis1, undefined);

  const noWcs = fitsToRgb(fitsFile(imageCards({ bitpix: 16, naxis1: 2, naxis2: 2 }), encI16([1, 2, 3, 4])));
  assert.equal(noWcs.meta.wcs, null);
});

test('fitsToRgb honours opts.maxEdge by box-downscaling the long edge', () => {
  const width = 40;
  const height = 20;
  const count = width * height;
  const raw = new Array(count);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) raw[y * width + x] = 100 + x * 10 + y;
  }
  const buf = fitsFile(imageCards({ bitpix: 16, naxis1: width, naxis2: height }), encI16(raw));

  const full = fitsToRgb(buf);
  assert.equal(full.width, width);
  assert.equal(full.height, height);
  assert.equal(full.data.length, count * 3);

  const half = fitsToRgb(buf, { maxEdge: 20 });
  assert.equal(half.width, 20);
  assert.equal(half.height, 10);
  assert.equal(half.data.length, 20 * 10 * 3);
  assert.equal(half.meta.sourceWidth, width);
  assert.equal(half.meta.sourceHeight, height);
  assert.ok(half.meta.notes.some((n) => n === 'downscaled:40x20->20x10'));
  for (const v of half.data) assert.ok(Number.isFinite(v) && v >= 0 && v <= 1);

  // A long edge already inside the limit must be left alone.
  const untouched = fitsToRgb(buf, { maxEdge: 4000 });
  assert.equal(untouched.width, width);
  assert.equal(untouched.height, height);
  assert.ok(!untouched.meta.notes.some((n) => n.startsWith('downscaled:')));

  // The LONG edge is the one clamped; the aspect ratio is preserved.
  const tall = fitsToRgb(buf, { maxEdge: 10 });
  assert.equal(tall.width, 10);
  assert.equal(tall.height, 5);
});

/* ------------------------------------------------------------------ *
 * 12. performance smoke test
 * ------------------------------------------------------------------ */

test('a 1600x1067 16-bit frame decodes well under a second', () => {
  const width = 1600;
  const height = 1067;
  const count = width * height;
  const data = Buffer.alloc(count * 2);
  for (let i = 0; i < count; i++) data.writeInt16BE(((i * 37) % 65536) - 32768, i * 2);
  const cards = imageCards({
    bitpix: 16,
    naxis1: width,
    naxis2: height,
    extra: [card('BZERO', 32768), card('BSCALE', 1), card('OBJECT', 'perf')],
  });
  const buf = fitsFile(cards, data);

  const t0 = performance.now();
  const img = readFits(buf);
  const decodeMs = performance.now() - t0;
  assert.equal(img.width, width);
  assert.equal(img.height, height);
  assert.equal(img.data.length, count);
  assert.ok(decodeMs < 1000, `readFits took ${decodeMs.toFixed(1)} ms`);

  const t1 = performance.now();
  const raster = fitsToRgb(buf);
  const rgbMs = performance.now() - t1;
  assert.equal(raster.width, width);
  assert.equal(raster.height, height);
  assert.equal(raster.data.length, count * 3);
  assert.ok(rgbMs < 1500, `fitsToRgb took ${rgbMs.toFixed(1)} ms`);

  let finite = true;
  for (let i = 0; i < raster.data.length; i += 997) {
    const v = raster.data[i];
    if (!Number.isFinite(v) || v < 0 || v > 1) finite = false;
  }
  assert.equal(finite, true);
  console.log(`# perf: readFits ${decodeMs.toFixed(1)} ms, fitsToRgb ${rgbMs.toFixed(1)} ms (${width}x${height})`);
});
