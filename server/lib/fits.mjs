/**
 * server/lib/fits.mjs — minimal, dependency-free FITS reader for web3astra.
 *
 * Contract: docs/CONTRACTS.md §3.2 (frozen API).
 * Primary exports: isFits, parseFitsHeader, readFits, fitsToRgb, stretchLinear.
 * Helper exports:  asinhStretch, percentile, debayer.
 *
 * Format facts implemented here:
 *  - FITS is big-endian. Header = 2880-byte blocks of 80-char ASCII cards,
 *    terminated by an `END` card; the header is zero-... space-padded to a
 *    multiple of 2880. Data follows, itself padded to a multiple of 2880.
 *  - BITPIX 8 (unsigned), 16, 32, -32 (float32), -64 (float64).
 *  - Physical value = BZERO + BSCALE * raw  (defaults BZERO=0, BSCALE=1).
 *  - Multi-HDU: the first HDU that is an image (primary or XTENSION='IMAGE')
 *    with NAXIS >= 2 and NAXIS1/NAXIS2 > 0 wins; BINTABLE/other extensions are
 *    skipped using the standard size formula
 *    dataBytes = |BITPIX|/8 * GCOUNT * (PCOUNT + prod(NAXISi)).
 *
 * Deliberate choices (documented deviations / clarifications):
 *  - `readFits().data` holds *physical* samples (BZERO/BSCALE applied), which is
 *    what every downstream consumer wants; `opts.scaled === false` returns the
 *    unscaled on-disk integers instead. For NAXIS=2 the length is exactly
 *    NAXIS1*NAXIS2 as the contract states; for NAXIS=3 the first
 *    min(NAXIS3, 3) planes are concatenated (planeCount reports how many).
 *  - Errors are `Error` instances carrying `.code`:
 *    NOT_FITS | TRUNCATED | NO_IMAGE_HDU | UNSUPPORTED_BITPIX | BAD_INPUT.
 *  - Zero dependencies, pure functions, no I/O.
 */

const BLOCK_SIZE = 2880;
const CARD_SIZE = 80;
const SUPPORTED_BITPIX = new Set([8, 16, 32, -32, -64]);

// WCS keys copied into meta.wcs (lowercased, as they appear in the header).
const WCS_KEYS = [
  'crpix1', 'crpix2', 'crpix3',
  'crval1', 'crval2', 'crval3',
  'cdelt1', 'cdelt2', 'cdelt3',
  'cd1_1', 'cd1_2', 'cd2_1', 'cd2_2',
  'pc1_1', 'pc1_2', 'pc2_1', 'pc2_2',
  'ctype1', 'ctype2', 'ctype3',
  'radesys', 'equinox', 'lonpole', 'latpole', 'mjd-obs',
];

// BAYER tile -> channel per (row&1, col&1), packed row-major: index = (y&1)*2 + (x&1).
// 0 = red, 1 = green, 2 = blue.
const BAYER_TILES = {
  RGGB: [0, 1, 1, 2],
  BGGR: [2, 1, 1, 0],
  GRBG: [1, 0, 2, 1],
  GBRG: [1, 2, 0, 1],
};

/**
 * NOTE ON BAYERPAT ORIENTATION
 * We interpret BAYERPAT as the literal 2x2 tile in memory order:
 *   pattern[0] = pixel(0,0), pattern[1] = pixel(0,1),
 *   pattern[2] = pixel(1,0), pattern[3] = pixel(1,1).
 * That is the FITS/SBIG convention (MaxIm DL, AstroArt, SBIG cameras, and the
 * ASI/INDI writers that copy it). Some pipelines — IRAF-derived code and some
 * ROI-flipped or binned writers — record the *transposed* tile instead, so a
 * file labelled RGGB can really be GRBG on disk. We do not try to guess: we
 * honour the 4 patterns literally, and `opts.bayerFlip === true` transposes the
 * tile (GRBG <-> GBRG; RGGB/BGGR are transpose-symmetric) for those pipelines.
 */

/* ------------------------------------------------------------------ *
 * small utilities
 * ------------------------------------------------------------------ */

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function toBuffer(input) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) {
    return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  }
  if (input instanceof ArrayBuffer) return Buffer.from(input);
  throw fail('BAD_INPUT', 'fits: expected a Buffer, Uint8Array or ArrayBuffer');
}

function intOf(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
}

function numOf(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/* ------------------------------------------------------------------ *
 * header parsing
 * ------------------------------------------------------------------ */

/**
 * Parse a single 80-char card.
 * @returns {{kind:'value'|'comment'|'history'|'end'|'skip', key?:string, value?:any, text?:string}}
 */
function parseCard(card) {
  const key8 = card.slice(0, 8).trim().toUpperCase();
  if (key8 === 'END') return { kind: 'end' };
  if (key8 === 'COMMENT') return { kind: 'comment', text: card.slice(8).trim() };
  if (key8 === 'HISTORY') return { kind: 'history', text: card.slice(8).trim() };

  let key = key8;
  let valueField;
  if (key8 === 'HIERARCH') {
    const eq = card.indexOf('=');
    if (eq < 0) return { kind: 'skip' };
    key = card.slice(8, eq).trim();
    valueField = card.slice(eq + 1);
  } else {
    if (card[8] !== '=') return { kind: 'skip' };
    valueField = card.slice(10);
  }
  if (key === '') return { kind: 'skip' };
  return { kind: 'value', key: key.toLowerCase(), value: parseValue(valueField) };
}

/** Parse the value field (columns 11-80) of a value card. */
function parseValue(field) {
  if (field.length === 0) return null;
  if (field[0] === "'") {
    // Quoted string; '' is an escaped single quote. Trailing blanks are padding.
    let out = '';
    for (let i = 1; i < field.length; i++) {
      const ch = field[i];
      if (ch === "'") {
        if (field[i + 1] === "'") {
          out += "'";
          i++;
          continue;
        }
        return out.replace(/\s+$/, '');
      }
      out += ch;
    }
    return out.replace(/\s+$/, '');
  }
  const slash = field.indexOf('/');
  const head = (slash >= 0 ? field.slice(0, slash) : field).trim();
  if (head === '') return null;
  if (head === 'T' || head === 't') return true;
  if (head === 'F' || head === 'f') return false;
  const num = Number(head.replace(/[dD]/, 'e'));
  return Number.isNaN(num) ? head : num;
}

/** Parse the header that starts at `offset`; returns its cards plus layout. */
function parseHeaderAt(buf, offset) {
  if (offset < 0 || offset + CARD_SIZE > buf.length) {
    throw fail('TRUNCATED', `fits: no complete header card at byte ${offset}`);
  }
  const header = {};
  const comments = [];
  const history = [];
  let pos = offset;
  let foundEnd = false;
  while (pos + CARD_SIZE <= buf.length) {
    const card = buf.toString('latin1', pos, pos + CARD_SIZE);
    pos += CARD_SIZE;
    const parsed = parseCard(card);
    if (parsed.kind === 'end') {
      foundEnd = true;
      break;
    }
    if (parsed.kind === 'value') {
      header[parsed.key] = parsed.value;
    } else if (parsed.kind === 'comment') {
      comments.push(parsed.text);
    } else if (parsed.kind === 'history') {
      history.push(parsed.text);
    }
  }
  if (!foundEnd) {
    throw fail('TRUNCATED', 'fits: header ended without an END card');
  }
  if (comments.length) header.comment = comments;
  if (history.length) header.history = history;

  const headerBytes = Math.ceil((pos - offset) / BLOCK_SIZE) * BLOCK_SIZE;
  const dataOffset = offset + headerBytes;
  const dataSize = hduDataBytes(header);
  const paddedDataSize = Math.ceil(dataSize / BLOCK_SIZE) * BLOCK_SIZE;
  return {
    header,
    headerBytes,
    dataOffset,
    dataSize,
    paddedDataSize,
    nextHduOffset: dataOffset + paddedDataSize,
  };
}

/** Standard HDU data size: |BITPIX|/8 * GCOUNT * (PCOUNT + prod(NAXISi)). */
function hduDataBytes(header) {
  const naxis = intOf(header.naxis, 0);
  const bitpix = intOf(header.bitpix, 8);
  const gcount = intOf(header.gcount, 1);
  const pcount = intOf(header.pcount, 0);
  let product = 0;
  if (naxis > 0) {
    product = 1;
    for (let i = 1; i <= naxis; i++) {
      product *= intOf(header[`naxis${i}`], 0);
    }
  }
  const bytes = (Math.abs(bitpix) / 8) * gcount * (pcount + product);
  return Number.isFinite(bytes) && bytes > 0 ? Math.round(bytes) : 0;
}

/**
 * Parse the primary header (or the n-th HDU when `opts.hduIndex` is given).
 * @param {Buffer|Uint8Array} input
 * @param {{offset?:number, hduIndex?:number, requireSimple?:boolean}} [opts]
 * @returns {{header:Object, dataOffset:number, dataSize:number, headerBytes:number,
 *            paddedDataSize:number, nextHduOffset:number}}
 */
export function parseFitsHeader(input, opts = {}) {
  const buf = toBuffer(input);
  const requireSimple = opts.requireSimple !== false;
  let offset = intOf(opts.offset, 0);
  if (offset === 0 && requireSimple && !isFits(buf)) {
    throw fail('NOT_FITS', 'fits: missing SIMPLE card at byte 0');
  }
  const hduIndex = intOf(opts.hduIndex, 0);
  for (let i = 0; i < hduIndex; i++) {
    const skipped = parseHeaderAt(buf, offset);
    offset = skipped.nextHduOffset;
  }
  return parseHeaderAt(buf, offset);
}

/** True when the buffer starts with a FITS `SIMPLE  = T` card. */
export function isFits(input) {
  let buf;
  try {
    buf = toBuffer(input);
  } catch {
    return false;
  }
  if (buf.length < 30) return false;
  const head = buf.toString('latin1', 0, 30);
  return /^SIMPLE\s*=\s*T/i.test(head);
}

/* ------------------------------------------------------------------ *
 * data reading
 * ------------------------------------------------------------------ */

/** Locate the first image HDU (primary or XTENSION='IMAGE', NAXIS>=2, sizes > 0). */
function locateImageHdu(buf, opts = {}) {
  const maxHdu = intOf(opts.maxHdu, 64);
  let offset = 0;
  for (let index = 0; index < maxHdu; index++) {
    if (offset + CARD_SIZE > buf.length) break;
    const parsed = parseHeaderAt(buf, offset);
    const h = parsed.header;
    const xtension = typeof h.xtension === 'string' ? h.xtension.trim().toUpperCase() : null;
    const isImage = (xtension === null || xtension === 'IMAGE')
      && intOf(h.naxis, 0) >= 2
      && intOf(h.naxis1, 0) > 0
      && intOf(h.naxis2, 0) > 0;
    if (isImage) return { ...parsed, hduIndex: index };
    if (parsed.nextHduOffset <= offset) break;
    offset = parsed.nextHduOffset;
  }
  throw fail('NO_IMAGE_HDU', 'fits: no image HDU with NAXIS >= 2 and NAXIS1/NAXIS2 > 0');
}

/**
 * Read `count` samples as Float32Array, applying BZERO/BSCALE unless disabled.
 * Big-endian throughout; DataView is used so unaligned buffers stay correct.
 */
function readSamples(buf, header, dataOffset, count, applyScale) {
  const bitpix = intOf(header.bitpix, 8);
  if (!SUPPORTED_BITPIX.has(bitpix)) {
    throw fail('UNSUPPORTED_BITPIX', `fits: BITPIX ${bitpix} is not supported`);
  }
  const bytesPer = Math.abs(bitpix) / 8;
  if (dataOffset + count * bytesPer > buf.length) {
    throw fail('TRUNCATED', `fits: image data needs ${count * bytesPer} bytes but only `
      + `${Math.max(0, buf.length - dataOffset)} are present`);
  }
  const out = new Float32Array(count);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const bscale = applyScale ? numOf(header.bscale, 1) : 1;
  const bzero = applyScale ? numOf(header.bzero, 0) : 0;
  const trivial = bscale === 1 && bzero === 0;
  let i;
  switch (bitpix) {
    case 8:
      if (trivial) {
        for (i = 0; i < count; i++) out[i] = buf[dataOffset + i];
      } else {
        for (i = 0; i < count; i++) out[i] = bzero + bscale * buf[dataOffset + i];
      }
      break;
    case 16:
      if (trivial) {
        for (i = 0; i < count; i++) out[i] = view.getInt16(dataOffset + i * 2);
      } else {
        for (i = 0; i < count; i++) out[i] = bzero + bscale * view.getInt16(dataOffset + i * 2);
      }
      break;
    case 32:
      if (trivial) {
        for (i = 0; i < count; i++) out[i] = view.getInt32(dataOffset + i * 4);
      } else {
        for (i = 0; i < count; i++) out[i] = bzero + bscale * view.getInt32(dataOffset + i * 4);
      }
      break;
    case -32:
      if (trivial) {
        for (i = 0; i < count; i++) out[i] = view.getFloat32(dataOffset + i * 4);
      } else {
        for (i = 0; i < count; i++) out[i] = bzero + bscale * view.getFloat32(dataOffset + i * 4);
      }
      break;
    default: // -64
      if (trivial) {
        for (i = 0; i < count; i++) out[i] = view.getFloat64(dataOffset + i * 8);
      } else {
        for (i = 0; i < count; i++) out[i] = bzero + bscale * view.getFloat64(dataOffset + i * 8);
      }
      break;
  }
  return out;
}

/**
 * Read the first image HDU.
 * @param {Buffer|Uint8Array} input
 * @param {{scaled?:boolean, allPlanes?:boolean, maxHdu?:number}} [opts]
 * @returns {{data:Float32Array, width:number, height:number, header:Object,
 *            stats:{min:number,max:number,mean:number,median:number,p1:number,p99:number},
 *            planeCount:number, bitpix:number, dataOffset:number, hduIndex:number}}
 */
export function readFits(input, opts = {}) {
  const buf = toBuffer(input);
  if (!isFits(buf)) throw fail('NOT_FITS', 'fits: missing SIMPLE card at byte 0');
  const located = locateImageHdu(buf, opts);
  const header = located.header;
  const width = intOf(header.naxis1, 0);
  const height = intOf(header.naxis2, 0);
  const naxis3 = Math.max(1, intOf(header.naxis3, 1));
  const planeCount = opts.allPlanes === true ? naxis3 : Math.min(naxis3, 3);
  const data = readSamples(
    buf, header, located.dataOffset, width * height * planeCount, opts.scaled !== false,
  );
  return {
    data,
    width,
    height,
    header,
    stats: computeStats(data),
    planeCount,
    bitpix: intOf(header.bitpix, 8),
    dataOffset: located.dataOffset,
    hduIndex: located.hduIndex,
  };
}

/* ------------------------------------------------------------------ *
 * statistics / selection
 * ------------------------------------------------------------------ */

/** Copy only the finite samples (NaN/Inf pixels must not poison percentiles). */
function finiteCopy(arr) {
  let count = 0;
  for (let i = 0; i < arr.length; i++) {
    if (Number.isFinite(arr[i])) count++;
  }
  const out = new Float32Array(count);
  let j = 0;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (Number.isFinite(v)) out[j++] = v;
  }
  return out;
}

function swap(a, i, j) {
  const t = a[i];
  a[i] = a[j];
  a[j] = t;
}

/** In-place quickselect (Hoare partition, median-of-three): returns the k-th smallest. */
function selectKth(a, k) {
  const n = a.length;
  if (n === 0) return NaN;
  const target = k < 0 ? 0 : k >= n ? n - 1 : k;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid] < a[lo]) swap(a, mid, lo);
    if (a[hi] < a[lo]) swap(a, hi, lo);
    if (a[hi] < a[mid]) swap(a, hi, mid);
    const pivot = a[mid];
    let i = lo;
    let j = hi;
    while (i <= j) {
      while (a[i] < pivot) i++;
      while (a[j] > pivot) j--;
      if (i <= j) {
        swap(a, i, j);
        i++;
        j--;
      }
    }
    if (target <= j) hi = j;
    else if (target >= i) lo = i;
    else return a[target];
  }
  return a[lo];
}

/** Percentile (0..100) of a Float32Array. Does not mutate the input. */
export function percentile(arr, p) {
  const src = arr instanceof Float32Array ? arr : Float32Array.from(arr);
  const work = finiteCopy(src);
  if (work.length === 0) return NaN;
  const pct = Number.isFinite(p) ? Math.min(100, Math.max(0, p)) : 0;
  return selectKth(work, Math.round((pct / 100) * (work.length - 1)));
}

function computeStats(data) {
  const n = data.length;
  if (n === 0) {
    return { min: 0, max: 0, mean: 0, median: 0, p1: 0, p99: 0 };
  }
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = data[i];
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  const work = finiteCopy(data);
  if (work.length === 0) {
    return { min: 0, max: 0, mean: 0, median: 0, p1: 0, p99: 0 };
  }
  const idx = (pct) => Math.round((pct / 100) * (work.length - 1));
  const p1 = selectKth(work, idx(1));
  const median = selectKth(work, idx(50));
  const p99 = selectKth(work, idx(99));
  return { min, max, mean: sum / n, median, p1, p99 };
}

/* ------------------------------------------------------------------ *
 * stretch
 * ------------------------------------------------------------------ */

/**
 * Percentile clip + optional asinh stretch to 0..1.
 * Monotonic non-decreasing: out[i] <= out[j] whenever arr[i] <= arr[j].
 * @param {Float32Array|number[]} arr
 * @param {{lowPct?:number, highPct?:number, asinh?:boolean, beta?:number,
 *          out?:Float32Array}} [opts]  defaults: 0.25 / 99.75 / asinh on / beta 0.1
 * @returns {Float32Array} new array (or `opts.out` when it has the right length)
 */
export function stretchLinear(arr, opts = {}) {
  const src = arr instanceof Float32Array ? arr : Float32Array.from(arr);
  const n = src.length;
  const out = opts.out instanceof Float32Array && opts.out.length === n
    ? opts.out
    : new Float32Array(n);
  if (n === 0) return out;

  const lowPct = Math.min(100, Math.max(0, numOf(opts.lowPct, 0.25)));
  const highPct = Math.min(100, Math.max(0, numOf(opts.highPct, 99.75)));
  const useAsinh = opts.asinh !== false;
  const beta = numOf(opts.beta, 0.1) > 0 ? numOf(opts.beta, 0.1) : 0.1;

  const work = finiteCopy(src);
  if (work.length === 0) {
    out.fill(0);
    return out;
  }
  const last = work.length - 1;
  const lo = selectKth(work, Math.round((lowPct / 100) * last));
  const hi = selectKth(work, Math.round((highPct / 100) * last));
  if (!(hi > lo)) {
    // Degenerate (constant or single-valued) input: keep it monotone.
    out.fill(hi > 0 ? 1 : 0);
    return out;
  }

  const inv = 1 / (hi - lo);
  const asinhNorm = useAsinh ? 1 / Math.asinh(1 / beta) : 1;
  for (let i = 0; i < n; i++) {
    const v = src[i];
    if (!Number.isFinite(v)) {
      out[i] = 0;
      continue;
    }
    let x = (v - lo) * inv;
    x = x < 0 ? 0 : x > 1 ? 1 : x;
    out[i] = useAsinh ? Math.asinh(x / beta) * asinhNorm : x;
  }
  return out;
}

/**
 * Asinh transfer on values already in 0..1 (clamped). out = asinh(x/beta)/asinh(1/beta).
 * @param {Float32Array|number[]} arr
 * @param {{beta?:number, out?:Float32Array}} [opts]
 */
export function asinhStretch(arr, opts = {}) {
  const src = arr instanceof Float32Array ? arr : Float32Array.from(arr);
  const n = src.length;
  const out = opts.out instanceof Float32Array && opts.out.length === n
    ? opts.out
    : new Float32Array(n);
  const beta = numOf(opts.beta, 0.1) > 0 ? numOf(opts.beta, 0.1) : 0.1;
  const norm = 1 / Math.asinh(1 / beta);
  for (let i = 0; i < n; i++) {
    const v = src[i];
    if (!Number.isFinite(v)) {
      out[i] = 0;
      continue;
    }
    const x = v < 0 ? 0 : v > 1 ? 1 : v;
    out[i] = Math.asinh(x / beta) * norm;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * debayer
 * ------------------------------------------------------------------ */

function normalizeBayerPattern(raw, opts) {
  if (typeof raw !== 'string') return null;
  let pattern = raw.trim().toUpperCase().replace(/[^RGB]/g, '');
  if (pattern.length !== 4 || !BAYER_TILES[pattern]) return null;
  if (opts.bayerFlip === true) {
    // Transpose the 2x2 tile: p0 p2 p1 p3.
    pattern = pattern[0] + pattern[2] + pattern[1] + pattern[3];
  }
  return pattern;
}

/**
 * Reflect an out-of-range index back inside [0, n-1] without repeating the edge
 * sample. Reflection (not clamping) is required for Bayer data: the edge pixel of
 * a 2x2 tile has a different colour than its missing neighbour, so clamping would
 * inject the wrong colour into every border pixel and tint the frame edges.
 */
function mirrorIndex(i, n) {
  if (n <= 1) return 0;
  let j = i < 0 ? -i : i;
  if (j >= n) j = 2 * (n - 1) - j;
  if (j < 0) return 0;
  return j >= n ? n - 1 : j;
}

/**
 * Bilinear demosaic of a single-plane Bayer frame.
 * Green at red/blue sites = mean of the 4 orthogonal neighbours; red/blue at a
 * green site = mean of the 2 orthogonal neighbours of that colour; the missing
 * red/blue at a red/blue site = mean of the 4 diagonal neighbours. Out-of-range
 * neighbours are mirrored about the edge (phase-preserving).
 * @param {Float32Array} mono  width*height samples
 * @param {number} width
 * @param {number} height
 * @param {'RGGB'|'BGGR'|'GRBG'|'GBRG'} pattern
 * @returns {Float32Array} width*height*3 interleaved RGB (same units as input)
 */
export function debayer(mono, width, height, pattern) {
  const tile = BAYER_TILES[pattern];
  if (!tile) throw fail('BAD_INPUT', `fits: unknown Bayer pattern ${pattern}`);
  const out = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    const rowMid = y * width;
    const rowUp = mirrorIndex(y - 1, height) * width;
    const rowDn = mirrorIndex(y + 1, height) * width;
    const rowParity = (y & 1) << 1;
    for (let x = 0; x < width; x++) {
      const i = rowMid + x;
      const xm = mirrorIndex(x - 1, width);
      const xp = mirrorIndex(x + 1, width);
      const site = tile[rowParity | (x & 1)];
      const left = mono[rowMid + xm];
      const right = mono[rowMid + xp];
      const up = mono[rowUp + x];
      const down = mono[rowDn + x];
      let r;
      let g;
      let b;
      if (site === 1) {
        // Green site: the two missing colours sit on orthogonal neighbours.
        const hCh = tile[rowParity | ((x & 1) ^ 1)];
        const vCh = tile[(rowParity ^ 2) | (x & 1)];
        const hAvg = (left + right) * 0.5;
        const vAvg = (up + down) * 0.5;
        g = mono[i];
        r = hCh === 0 ? hAvg : vCh === 0 ? vAvg : 0;
        b = hCh === 2 ? hAvg : vCh === 2 ? vAvg : 0;
      } else {
        const orth = (left + right + up + down) * 0.25;
        const diag = (mono[rowUp + xm] + mono[rowUp + xp]
          + mono[rowDn + xm] + mono[rowDn + xp]) * 0.25;
        if (site === 0) {
          r = mono[i];
          g = orth;
          b = diag;
        } else {
          b = mono[i];
          g = orth;
          r = diag;
        }
      }
      const o = i * 3;
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Raster conversion
 * ------------------------------------------------------------------ */

function extractWcs(header) {
  const wcs = {};
  let found = false;
  for (const key of WCS_KEYS) {
    if (header[key] !== undefined) {
      wcs[key] = header[key];
      found = true;
    }
  }
  return found ? wcs : null;
}

/**
 * Area-weighted box downscale of an interleaved RGB plane.
 * Used when the caller passes `maxEdge` (imageio.mjs does, per CONTRACTS §3.1):
 * without it a 6000x4000 FITS would allocate a ~288 MB Float32Array downstream.
 * Averaging (rather than point sampling) keeps the result photometrically sane,
 * which matters because the output feeds star detection.
 */
function downscaleRgb(src, width, height, outWidth, outHeight) {
  const out = new Float32Array(outWidth * outHeight * 3);
  const xRatio = width / outWidth;
  const yRatio = height / outHeight;
  for (let oy = 0; oy < outHeight; oy++) {
    const sy0 = oy * yRatio;
    const sy1 = (oy + 1) * yRatio;
    const yStart = Math.floor(sy0);
    const yEnd = Math.min(height, Math.ceil(sy1));
    for (let ox = 0; ox < outWidth; ox++) {
      const sx0 = ox * xRatio;
      const sx1 = (ox + 1) * xRatio;
      const xStart = Math.floor(sx0);
      const xEnd = Math.min(width, Math.ceil(sx1));
      let r = 0;
      let g = 0;
      let b = 0;
      let wsum = 0;
      for (let sy = yStart; sy < yEnd; sy++) {
        const wy = Math.min(sy + 1, sy1) - Math.max(sy, sy0);
        if (wy <= 0) continue;
        for (let sx = xStart; sx < xEnd; sx++) {
          const wx = Math.min(sx + 1, sx1) - Math.max(sx, sx0);
          if (wx <= 0) continue;
          const w = wx * wy;
          const si = (sy * width + sx) * 3;
          r += src[si] * w;
          g += src[si + 1] * w;
          b += src[si + 2] * w;
          wsum += w;
        }
      }
      const oi = (oy * outWidth + ox) * 3;
      if (wsum > 0) {
        out[oi] = r / wsum;
        out[oi + 1] = g / wsum;
        out[oi + 2] = b / wsum;
      }
    }
  }
  return out;
}

function stretchPerChannel(rgb, pixelCount, opts) {
  const out = new Float32Array(pixelCount * 3);
  const tmp = new Float32Array(pixelCount);
  for (let c = 0; c < 3; c++) {
    for (let p = 0; p < pixelCount; p++) tmp[p] = rgb[p * 3 + c];
    stretchLinear(tmp, { ...opts, out: tmp });
    for (let p = 0; p < pixelCount; p++) out[p * 3 + c] = tmp[p];
  }
  return out;
}

/**
 * Decode a FITS buffer to a Raster (docs/CONTRACTS.md §2.1).
 * Handles 2D mono (with optional BAYERPAT debayer) and NAXIS=3 RGB cubes.
 * @param {Buffer|Uint8Array} input
 * @param {{bayerFlip?:boolean, debayer?:boolean, channelStretch?:boolean,
 *          stretch?:boolean|Object, lowPct?:number, highPct?:number, beta?:number,
 *          asinh?:boolean, maxHdu?:number, maxEdge?:number}} [opts]
 * @returns {{data:Float32Array, width:number, height:number, meta:Object}}
 */
export function fitsToRgb(input, opts = {}) {
  const buf = toBuffer(input);
  if (!isFits(buf)) throw fail('NOT_FITS', 'fits: missing SIMPLE card at byte 0');
  const located = locateImageHdu(buf, opts);
  const header = located.header;
  const width = intOf(header.naxis1, 0);
  const height = intOf(header.naxis2, 0);
  const pixelCount = width * height;
  const naxis3 = Math.max(1, intOf(header.naxis3, 1));
  const bitpix = intOf(header.bitpix, 8);
  if (!SUPPORTED_BITPIX.has(bitpix)) {
    throw fail('UNSUPPORTED_BITPIX', `fits: BITPIX ${bitpix} is not supported`);
  }
  const notes = [];

  let rgb;
  if (naxis3 >= 3) {
    const planes = readSamples(buf, header, located.dataOffset, pixelCount * 3, true);
    rgb = new Float32Array(pixelCount * 3);
    for (let p = 0; p < pixelCount; p++) {
      rgb[p * 3] = planes[p];
      rgb[p * 3 + 1] = planes[pixelCount + p];
      rgb[p * 3 + 2] = planes[2 * pixelCount + p];
    }
    notes.push(`rgb-cube:naxis3=${naxis3}`);
    if (naxis3 > 3) notes.push(`extra-planes-ignored:${naxis3 - 3}`);
  } else {
    const mono = readSamples(buf, header, located.dataOffset, pixelCount, true);
    const pattern = opts.debayer === false ? null : normalizeBayerPattern(header.bayerpat, opts);
    if (pattern) {
      rgb = debayer(mono, width, height, pattern);
      notes.push(`debayer:${pattern}${opts.bayerFlip === true ? '(flipped)' : ''}`);
    } else {
      rgb = new Float32Array(pixelCount * 3);
      for (let p = 0; p < pixelCount; p++) {
        const v = mono[p];
        rgb[p * 3] = v;
        rgb[p * 3 + 1] = v;
        rgb[p * 3 + 2] = v;
      }
      if (header.bayerpat !== undefined && opts.debayer !== false) {
        notes.push(`bayerpat-unrecognized:${String(header.bayerpat)}`);
      } else {
        notes.push('mono:replicated');
      }
    }
  }

  // Optional long-edge downscale (imageio.mjs passes opts.maxEdge per §3.1).
  // Done on the LINEAR data, before the stretch: averaging non-linear values
  // would darken bright cores and bias the star photometry downstream.
  let outWidth = width;
  let outHeight = height;
  let work = rgb;
  let workPixels = pixelCount;
  const maxEdge = numOf(opts.maxEdge, 0);
  if (maxEdge > 0 && Math.max(width, height) > maxEdge) {
    const factor = maxEdge / Math.max(width, height);
    outWidth = Math.max(1, Math.round(width * factor));
    outHeight = Math.max(1, Math.round(height * factor));
    work = downscaleRgb(rgb, width, height, outWidth, outHeight);
    workPixels = outWidth * outHeight;
    notes.push(`downscaled:${width}x${height}->${outWidth}x${outHeight}`);
  }

  const stretchOpts = {
    lowPct: numOf(opts.lowPct, 0.25),
    highPct: numOf(opts.highPct, 99.75),
    asinh: opts.asinh !== false,
    beta: numOf(opts.beta, 0.1),
  };
  if (opts.stretch && typeof opts.stretch === 'object') Object.assign(stretchOpts, opts.stretch);

  let data;
  if (opts.stretch === false) {
    data = work;
    notes.push('stretch:none(linear-physical)');
  } else if (opts.channelStretch === true) {
    data = stretchPerChannel(work, workPixels, stretchOpts);
    notes.push(`stretch:per-channel(${stretchOpts.lowPct}/${stretchOpts.highPct})`);
  } else {
    data = stretchLinear(work, stretchOpts);
    notes.push(`stretch:percentile(${stretchOpts.lowPct}/${stretchOpts.highPct})`
      + `${stretchOpts.asinh ? '+asinh' : ''}`);
  }
  if (header.bzero !== undefined || header.bscale !== undefined) {
    notes.push(`scaled:bzero=${numOf(header.bzero, 0)},bscale=${numOf(header.bscale, 1)}`);
  }

  return {
    data,
    width: outWidth,
    height: outHeight,
    meta: {
      source: 'fits',
      header,
      bitDepth: Math.abs(bitpix),
      bitpix,
      isLinear: true,
      wcs: extractWcs(header),
      sourceWidth: width,
      sourceHeight: height,
      notes,
    },
  };
}
