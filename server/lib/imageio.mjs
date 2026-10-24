// Image decoding / normalisation. THE only entry point for turning user bytes
// into a Raster (CONTRACTS.md §2.1).
//
// Supported: png jpg/jpeg webp tif/tiff avif gif bmp heic/heif fits/fit/fts
// HEIC is decoded through sharp when the local libvips has the codec, otherwise
// through `sips` on macOS. FITS goes through server/lib/fits.mjs.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { SERVER } from '../config.mjs';

const RASTER_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.tif', '.tiff', '.avif', '.gif', '.bmp', '.jp2', '.jxl']);
const HEIF_EXT = new Set(['.heic', '.heif', '.hif']);
const FITS_EXT = new Set(['.fits', '.fit', '.fts', '.fz']);

export function extOf(name = '') {
  return path.extname(String(name)).toLowerCase();
}

export function classify(filename = '', buf = null) {
  const ext = extOf(filename);
  if (FITS_EXT.has(ext)) return 'fits';
  if (HEIF_EXT.has(ext)) return 'heif';
  if (RASTER_EXT.has(ext)) return 'raster';
  if (buf && buf.length > 12) {
    if (buf[0] === 0x53 && buf[1] === 0x49 && buf[2] === 0x4d && buf[3] === 0x50) return 'fits'; // "SIMPLE"
    if (buf[0] === 0x89 && buf[1] === 0x50) return 'raster';
    if (buf[0] === 0xff && buf[1] === 0xd8) return 'raster';
    if (buf.slice(4, 8).toString('ascii') === 'ftyp') {
      const brand = buf.slice(8, 12).toString('ascii');
      if (/heic|heix|hevc|heim|heis|mif1|msf1|avif/i.test(brand)) return 'heif';
    }
    if (buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a) return 'raster';
  }
  return 'unknown';
}

/** Run a process and collect stdout. */
function execCapture(cmd, args, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => {
      err += d.toString();
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(Object.assign(new Error(`${cmd}: ${e.message}`), { code: 'SPAWN_FAILED' }));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        return reject(Object.assign(new Error(`${cmd} exited ${code}: ${err.slice(-500)}`), { code: 'DECODE_FAILED' }));
      }
      resolve(Buffer.concat(out));
    });
  });
}

/** Decode HEIC/HEIF to PNG bytes. sharp first, `sips` as the macOS fallback. */
async function decodeHeif(buf) {
  const sharp = (await import('sharp')).default;
  try {
    const png = await sharp(buf).png().toBuffer();
    return { png, via: 'sharp' };
  } catch (err) {
    if (process.platform !== 'darwin') {
      throw Object.assign(
        new Error(`HEIC/HEIF decoding is unavailable on this platform (${err.message}). Convert the file to PNG or JPEG first.`),
        { code: 'UNSUPPORTED_FORMAT' }
      );
    }
  }
  const dir = await fsp.mkdtemp(path.join(tmpdir(), 'w3a-heif-'));
  const inPath = path.join(dir, 'in.heic');
  const outPath = path.join(dir, 'out.png');
  try {
    await fsp.writeFile(inPath, buf);
    await execCapture('/usr/bin/sips', ['-s', 'format', 'png', inPath, '--out', outPath]);
    const png = await fsp.readFile(outPath);
    return { png, via: 'sips' };
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Downscale + convert to raw interleaved RGB Float32 in 0..1 (sRGB-encoded values). */
async function toRasterFromEncoded(buf, { maxEdge = SERVER.maxDecodeEdge, notes = [] } = {}) {
  const sharp = (await import('sharp')).default;
  const img = sharp(buf, { failOn: 'none', limitInputPixels: 1e9 }).rotate();
  const meta = await img.metadata();
  let pipeline = sharp(buf, { failOn: 'none', limitInputPixels: 1e9 }).rotate();
  const longest = Math.max(meta.width || 0, meta.height || 0);
  let scaleNote = null;
  if (longest > maxEdge) {
    const s = maxEdge / longest;
    const w = Math.max(1, Math.round((meta.width || 1) * s));
    const h = Math.max(1, Math.round((meta.height || 1) * s));
    pipeline = pipeline.resize(w, h, { kernel: 'lanczos3', fit: 'fill' });
    scaleNote = `downscaled ${meta.width}x${meta.height} -> ${w}x${h}`;
  }
  const { data, info } = await pipeline.removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const channels = info.channels;
  const N = info.width * info.height;
  const out = new Float32Array(N * 3);
  for (let i = 0, s = 0, d = 0; i < N; i++, s += channels, d += 3) {
    out[d] = data[s] / 255;
    out[d + 1] = data[s + (channels > 1 ? 1 : 0)] / 255;
    out[d + 2] = data[s + (channels > 2 ? 2 : 0)] / 255;
  }
  if (scaleNote) notes.push(scaleNote);
  return {
    raster: {
      data: out,
      width: info.width,
      height: info.height,
      meta: {
        source: 'raster',
        format: meta.format,
        bitDepth: meta.depth,
        isLinear: false,
        hasAlpha: meta.hasAlpha,
        exif: meta.exif ? 'present' : undefined,
        notes,
      },
    },
    meta,
  };
}

/** Percentile of a Float32Array luminance-ish sample. */
function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[i];
}

/**
 * Astro images are usually very dark. If the median is far below mid-grey we
 * apply a percentile + asinh stretch so the star detector and the renderer see a
 * usable dynamic range. The stretch is recorded in `meta.notes`.
 *
 * The gate matters as much as the stretch. A display-ready image (an 8-bit JPEG
 * or PNG that has already been processed) must pass through untouched — running
 * an asinh stretch on it would wash out the sky and destroy the faint contrast
 * the whole depth effect depends on. The decision is made from the black point
 * relative to the mid-tone, which is the same criterion whether the data is
 * linear or already sRGB-encoded.
 */
export function autoStretch(raster, opts = {}) {
  const { black = 0.0025, white = 0.9975, beta = 12, targetMedian = 0.055 } = opts;
  const { data } = raster;
  const n = data.length / 3;
  const stride = Math.max(1, Math.floor(n / 120000));
  const sample = new Float32Array(Math.ceil(n / stride));
  for (let i = 0, j = 0; i < n && j < sample.length; i += stride, j++) {
    const p = i * 3;
    sample[j] = 0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2];
  }
  sample.sort();
  const median = percentile(sample, 0.5);
  const lo = percentile(sample, black);
  const hi = percentile(sample, white);

  // Decide whether this frame still needs a stretch.
  //
  // The discriminator is where the sky sits relative to the frame's dynamic
  // range, NOT where the black point sits relative to the median. The latter
  // looks reasonable but misfires on a linear frame whose noise is comparable to
  // its sky level (very common in short exposures), where lo is close to the
  // median and the frame would be wrongly declared display-ready.
  //
  // A linear astro frame has its sky pinned near zero: median/hi is a fraction
  // of a percent. A processed sRGB image has its sky at a visible fraction of
  // the range. That ratio separates the two cleanly.
  if (hi - lo < 1e-4) return { applied: false, median, lo, hi, reason: 'no dynamic range' };
  // A processed image has a visible sky: its median sits at a few percent of the
  // white point. A linear frame's sky is pinned near zero. 3% is the cut — real
  // astrophotography that has been stretched lands at 4-10%, a raw stack at
  // well under 1%.
  const skyFraction = hi > 0 ? median / hi : 0;
  if (skyFraction >= 0.03 && median >= 0.02) {
    return { applied: false, median, lo, hi, reason: 'already display-ready' };
  }
  if (median >= 0.15) return { applied: false, median, lo, hi, reason: 'not dark enough' };

  const range = Math.max(1e-5, hi - lo);
  const denom = Math.log(beta + 1);
  for (let i = 0; i < data.length; i++) {
    const v = (data[i] - lo) / range;
    const c = v <= 0 ? 0 : v >= 1 ? 1 : v;
    data[i] = Math.log(beta * c + 1) / denom;
  }
  raster.meta.notes = raster.meta.notes || [];
  raster.meta.notes.push(
    `auto-stretch applied (median ${median.toFixed(4)}, black ${lo.toFixed(4)}, white ${hi.toFixed(4)}, asinh beta ${beta})`
  );
  raster.meta.stretched = true;
  return { applied: true, median, lo, hi };
}

/** Small post-stretch: lift the black point so the sky is not pure black. */
export function normalizeBackground(raster, opts = {}) {
  const { floor = 0.012, ceiling = 0.94 } = opts;
  const { data } = raster;
  const n = data.length / 3;
  const stride = Math.max(1, Math.floor(n / 60000));
  const sample = new Float32Array(Math.ceil(n / stride));
  for (let i = 0, j = 0; i < n && j < sample.length; i += stride, j++) {
    const p = i * 3;
    sample[j] = 0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2];
  }
  sample.sort();
  const bg = percentile(sample, 0.2);
  const hi = percentile(sample, 0.9995);
  if (bg <= 0 || hi <= bg) return { applied: false, bg, hi };
  const gain = ceiling / (hi - bg);
  for (let i = 0; i < data.length; i++) {
    const v = (data[i] - bg) * gain + floor;
    data[i] = v < 0 ? 0 : v > 1 ? 1 : v;
  }
  return { applied: true, bg, hi };
}

/**
 * Load any supported input into a Raster.
 * @param {{path?:string, buffer?:Buffer, filename?:string}} input
 */
export async function loadRaster(input, opts = {}) {
  const { maxEdge = SERVER.maxDecodeEdge, stretch = true, normalize = false, filename } = opts;
  let buf = input.buffer;
  let name = filename || input.filename || '';
  if (!buf && input.path) {
    buf = await fsp.readFile(input.path);
    if (!name) name = path.basename(input.path);
  }
  if (!buf || !buf.length) {
    throw Object.assign(new Error('empty input'), { code: 'EMPTY_INPUT' });
  }

  const kind = classify(name, buf);
  const notes = [];
  let raster;

  if (kind === 'fits') {
    const fits = await import('./fits.mjs');
    const rgb = fits.fitsToRgb(buf, { maxEdge });
    raster = rgb;
    notes.push('decoded from FITS');
  } else if (kind === 'heif') {
    const { png, via } = await decodeHeif(buf);
    notes.push(`HEIC/HEIF decoded via ${via}`);
    raster = (await toRasterFromEncoded(png, { maxEdge, notes })).raster;
  } else if (kind === 'raster') {
    raster = (await toRasterFromEncoded(buf, { maxEdge, notes })).raster;
  } else {
    throw Object.assign(new Error(`unsupported file type${name ? ` (${name})` : ''}`), {
      code: 'UNSUPPORTED_FORMAT',
    });
  }

  raster.meta.sourceName = name || 'upload';
  raster.meta.notes = [...(raster.meta.notes || []), ...notes];
  if (stretch) autoStretch(raster);
  if (normalize) normalizeBackground(raster);
  return raster;
}

export async function loadRasterFromUrl(url, opts = {}) {
  const res = await fetch(url);
  if (!res.ok) throw Object.assign(new Error(`fetch ${url} -> ${res.status}`), { code: 'FETCH_FAILED' });
  const buf = Buffer.from(await res.arrayBuffer());
  return loadRaster({ buffer: buf, filename: path.basename(new URL(url).pathname) }, opts);
}

/** Convert a Raster to an 8-bit sRGB RGBA buffer (CONTRACTS §3.1). */
export async function rasterToSrgb8(raster) {
  const N = raster.width * raster.height;
  const out = new Uint8ClampedArray(N * 4);
  for (let i = 0, p = 0, q = 0; i < N; i++, p += 4, q += 3) {
    out[p] = Math.round(Math.min(1, Math.max(0, raster.data[q])) * 255);
    out[p + 1] = Math.round(Math.min(1, Math.max(0, raster.data[q + 1])) * 255);
    out[p + 2] = Math.round(Math.min(1, Math.max(0, raster.data[q + 2])) * 255);
    out[p + 3] = 255;
  }
  return { data: out, width: raster.width, height: raster.height };
}

/** Write a Raster out as a PNG. */
export async function rasterToPng(raster, outPath, { longEdge = null } = {}) {
  const sharp = (await import('sharp')).default;
  const { data, width, height } = await rasterToSrgb8(raster);
  let pipe = sharp(Buffer.from(data.buffer, data.byteOffset, data.byteLength), {
    raw: { width, height, channels: 4 },
  });
  if (longEdge && Math.max(width, height) > longEdge) {
    const s = longEdge / Math.max(width, height);
    pipe = pipe.resize(Math.round(width * s), Math.round(height * s), { kernel: 'lanczos3' });
  }
  await pipe.png({ compressionLevel: 9 }).toFile(outPath);
  return outPath;
}

/** Write an RGBA buffer out as a PNG (used for the starless plate). */
export async function writeRgbaPng({ data, width, height }, outPath, { compressionLevel = 6 } = {}) {
  const sharp = (await import('sharp')).default;
  await sharp(Buffer.from(data.buffer, data.byteOffset, data.byteLength), {
    raw: { width, height, channels: 4 },
  })
    .png({ compressionLevel })
    .toFile(outPath);
  return outPath;
}

export async function fileExists(p) {
  try {
    await fsp.access(p, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}
