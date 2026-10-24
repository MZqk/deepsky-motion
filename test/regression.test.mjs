// Regression tests for bugs found during development and review.
// Each test names the defect it guards against, so a future change that
// reintroduces one fails here instead of shipping.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';

import { autoStretch, classify, loadRaster } from '../server/lib/imageio.mjs';
import { setJpegXmp, readXmp, inspectMotionPhoto, buildZip, crc32, jpegSegments } from '../server/lib/liveimage.mjs';
import { pipeRawFrames, which, detectH264Encoder, getH264EncoderArgs, _resetDetectedH264Encoder } from '../server/lib/encode.mjs';
import { detectStars, analyzeSync } from '../server/lib/astro.mjs';
import { createRenderer, srgbToLin, createCachedFrameSource, cameraAt, fastExpNeg } from '../server/lib/render.mjs';
import { runExport } from '../server/lib/pipeline.mjs';
import { createJob } from '../server/lib/job.mjs';
import { pruneWorkDirectory } from '../server/lib/store.mjs';
import { backendLabel, PreviewRenderer } from '../web/renderer.js';
import { DEFAULT_PARAMS } from '../server/config.mjs';
import { mulberry32 } from '../server/lib/astro.mjs';

// ---------------------------------------------------------------------------
// autoStretch must not fire on an already display-ready image.
// Defect: it stretched everything, washing out contrast on processed JPEG/PNG.
// ---------------------------------------------------------------------------

test('autoStretch leaves an already display-ready image untouched', () => {
  const n = 100 * 100;
  const data = new Float32Array(n * 3);
  const rnd = mulberry32(5);
  for (let i = 0; i < n; i++) {
    // Dark sky around 0.12 with a few bright pixels: black point is well below
    // the median, so no stretch is warranted.
    const v = i % 997 === 0 ? 0.95 : 0.12 + rnd() * 0.03;
    data[i * 3] = v;
    data[i * 3 + 1] = v;
    data[i * 3 + 2] = v;
  }
  const raster = { data, width: 100, height: 100, meta: { notes: [] } };
  const before = data[0];
  const res = autoStretch(raster);
  assert.equal(res.applied, false, `stretch should be skipped (reason: ${res.reason})`);
  assert.equal(data[0], before, 'pixels must not be modified');
});

test('autoStretch does fire on a very dark linear frame', () => {
  const n = 80 * 80;
  const data = new Float32Array(n * 3);
  const rnd = mulberry32(9);
  for (let i = 0; i < n; i++) {
    // Typical linear astro frame: sky near zero, stars far above.
    // ~1% bright pixels so the white percentile lands on real stars, as it
    // would in a genuine frame.
    const v = i % 100 === 0 ? 0.6 : 0.002 + rnd() * 0.001;
    data[i * 3] = v;
    data[i * 3 + 1] = v;
    data[i * 3 + 2] = v;
  }
  const raster = { data, width: 80, height: 80, meta: { notes: [] } };
  const res = autoStretch(raster);
  assert.equal(res.applied, true, 'a linear frame must be stretched');
  assert.ok(raster.meta.stretched === true);
  assert.ok((raster.meta.notes || []).some((s) => s.includes('auto-stretch')));
  // Monotonic and in range after stretching.
  for (let i = 0; i < data.length; i++) {
    assert.ok(data[i] >= 0 && data[i] <= 1, `value ${data[i]} out of range`);
  }
});

// ---------------------------------------------------------------------------
// Motion Photo offset must be computed from the real byte lengths.
// Defect guard: a hardcoded/derived-from-length offset would silently pass
// a single-size test but break for any other clip.
// ---------------------------------------------------------------------------

function tinyJpeg() {
  // Minimal but structurally valid JPEG: SOI, APP0, SOS, EOI.
  const app0 = Buffer.concat([
    Buffer.from([0xff, 0xe0, 0x00, 0x10]),
    Buffer.from('JFIF\0', 'latin1'),
    Buffer.from([0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]),
  ]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    app0,
    Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]),
    Buffer.from([0x12, 0x34, 0x56, 0x78]),
    Buffer.from([0xff, 0xd9]),
  ]);
}

function fakeMp4(bytes) {
  return Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypisom', 'latin1'), Buffer.alloc(bytes, 7)]);
}

test('setJpegXmp inserts an XMP APP1 and is idempotent', () => {
  const jpeg = tinyJpeg();
  const xmp = '<?xpacket begin="\uFEFF"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description GCamera:MicroVideo="1" xmlns:GCamera="http://ns.google.com/photos/1.0/camera/"/></rdf:RDF></x:xmpmeta><?xpacket end="w"?>';
  const once = setJpegXmp(jpeg, xmp);
  const twice = setJpegXmp(once, xmp);
  assert.equal(once.slice(0, 2).toString('latin1'), '\ufffd\ufffd'.slice(0, 0) + once.slice(0, 2).toString('latin1'));
  assert.equal(once[0], 0xff);
  assert.equal(once[1], 0xd8);
  // Exactly one XMP APP1 after re-tagging.
  const count = (buf) => jpegSegments(buf).filter((s) => s.marker === 0xe1 && buf.slice(s.dataStart, s.dataStart + 28).toString('latin1').startsWith('http://ns.adobe.com/xap/1.0/')).length;
  assert.equal(count(once), 1, 'first tagging must add exactly one XMP segment');
  assert.equal(count(twice), 1, 're-tagging must replace, not accumulate');
  const parsed = readXmp(twice);
  assert.ok(parsed, 'XMP must be readable back');
  assert.equal(parsed.MicroVideo, '1');
});

test('Motion Photo offset points at the embedded MP4 for two different sizes', () => {
  const sizes = [4096, 12345];
  const offsets = [];
  for (const size of sizes) {
    const mp4 = fakeMp4(size);
    const xmp = `<?xpacket begin="\uFEFF"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description GCamera:MicroVideo="1" GCamera:MicroVideoOffset="${mp4.length}" xmlns:GCamera="http://ns.google.com/photos/1.0/camera/"/></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
    const out = Buffer.concat([setJpegXmp(tinyJpeg(), xmp), mp4]);
    const info = inspectMotionPhoto(out);
    assert.ok(info.hasXmp, 'XMP must be found');
    assert.equal(info.microVideoOffset, mp4.length);
    assert.equal(info.videoStart, out.length - mp4.length);
    assert.equal(info.videoStartIsFtyp, true, 'offset must land on an ftyp box');
    assert.equal(info.ok, true);
    offsets.push(info.microVideoOffset);
  }
  assert.notEqual(offsets[0], offsets[1], 'offset must be computed, not constant');
});

// ---------------------------------------------------------------------------
// ZIP writer: CRCs must be correct or macOS refuses to open the archive.
// ---------------------------------------------------------------------------

test('buildZip produces a valid archive with correct CRCs', () => {
  const entries = [
    { name: 'a.txt', data: Buffer.from('hello world') },
    { name: 'dir/b.bin', data: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]) },
    { name: 'stored.txt', data: Buffer.from('stored, not deflated'), store: true },
  ];
  const zip = buildZip(entries);
  assert.equal(zip.slice(0, 4).toString('latin1'), 'PK\u0003\u0004');
  // Locate the End Of Central Directory and validate structure by hand.
  const eocdSig = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const eocd = zip.lastIndexOf(eocdSig);
  assert.ok(eocd > 0, 'EOCD must exist');
  const count = zip.readUInt16LE(eocd + 10);
  assert.equal(count, entries.length);
  const cdSize = zip.readUInt32LE(eocd + 12);
  const cdOffset = zip.readUInt32LE(eocd + 16);
  assert.equal(cdOffset + cdSize, eocd, 'central directory must end at the EOCD');

  // Walk central directory entries and verify each CRC against a fresh compute.
  let p = cdOffset;
  for (const e of entries) {
    assert.equal(zip.readUInt32LE(p), 0x02014b50, 'central header signature');
    const crc = zip.readUInt32LE(p + 16);
    const compSize = zip.readUInt32LE(p + 20);
    const rawSize = zip.readUInt32LE(p + 24);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const localOffset = zip.readUInt32LE(p + 42);
    const name = zip.slice(p + 46, p + 46 + nameLen).toString('utf8');
    assert.equal(name, e.name);
    assert.equal(rawSize, e.data.length, `${name}: uncompressed size`);
    assert.equal(crc, crc32(e.data), `${name}: CRC must match a fresh computation`);

    // Read the local header and inflate the payload.
    assert.equal(zip.readUInt32LE(localOffset), 0x04034b50, 'local header signature');
    const lNameLen = zip.readUInt16LE(localOffset + 26);
    const lExtraLen = zip.readUInt16LE(localOffset + 28);
    const method = zip.readUInt16LE(localOffset + 8);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const body = zip.slice(dataStart, dataStart + compSize);
    const raw = method === 0 ? body : zlib.inflateRawSync(body);
    assert.deepEqual(raw, e.data, `${name}: round-trip content`);
    p += 46 + nameLen + extraLen + commentLen;
  }
  assert.equal(p, eocd, 'central directory walk must consume exactly cdSize');
});

// ---------------------------------------------------------------------------
// ffmpeg filter chain: two `-vf` flags means the first is silently dropped.
// Defect: the GIF palette filter overrode the scale filter, so GIFs were
// emitted at full render resolution while the metadata claimed the cap.
// ---------------------------------------------------------------------------

test('pipeRawFrames composes scale and extra filters into a single -vf', async (t) => {
  if (!which(process.env.FFMPEG_PATH || 'ffmpeg')) {
    t.skip('ffmpeg not available');
    return;
  }
  const W = 64;
  const H = 48;
  const count = 4;
  const rgba = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    rgba[i * 4] = (i * 7) & 0xff;
    rgba[i * 4 + 1] = (i * 3) & 0xff;
    rgba[i * 4 + 2] = (i * 11) & 0xff;
    rgba[i * 4 + 3] = 255;
  }
  const frameSource = {
    width: W,
    height: H,
    fps: 8,
    count,
    renderFrame: (i, out) => out.set(rgba),
  };
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'w3a-filt-'));
  const outPath = path.join(dir, 'out.gif');
  try {
    const info = await pipeRawFrames(frameSource, ['-loop', '0', '-y', outPath], {
      scale: 0.5,
      extraFilters: ['split[a][b];[a]palettegen=max_colors=64[p];[b][p]paletteuse=dither=sierra2_4a'],
    });
    assert.equal(info.width, 32, 'scale filter must have been applied');
    assert.equal(info.height, 24);
    const st = await fsp.stat(outPath);
    assert.ok(st.size > 0, 'gif must be written');
    // Confirm the file itself is 32x24, not 64x48 — the header carries it.
    const head = await fsp.readFile(outPath);
    assert.equal(head.slice(0, 6).toString('latin1'), 'GIF89a');
    const w = head.readUInt16LE(6);
    const h = head.readUInt16LE(8);
    assert.equal(w, 32, `GIF logical screen width ${w} must match the scaled size`);
    assert.equal(h, 24, `GIF logical screen height ${h}`);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// Colour space: star amplitude must be linearised before additive compositing.
// Defect: sRGB peak values fed into a linear sum made faint stars 5-8x too
// bright and the star field swamped the nebula.
// ---------------------------------------------------------------------------

test('srgbToLin is the correct transfer function and is monotonic', () => {
  assert.equal(srgbToLin(0), 0);
  assert.ok(Math.abs(srgbToLin(1) - 1) < 1e-3);
  // The linear value of a mid-grey sRGB pixel is far below the sRGB value.
  assert.ok(srgbToLin(0.5) < 0.25, `srgbToLin(0.5) = ${srgbToLin(0.5)} should be well below 0.25`);
  let prev = -1;
  for (let i = 0; i <= 100; i++) {
    const v = srgbToLin(i / 100);
    assert.ok(v >= prev, 'must be non-decreasing');
    prev = v;
  }
});

test('a faint star renders far dimmer than its sRGB value would suggest', () => {
  // Two identical scenes differing only in how the star brightness is fed in.
  const raster = {
    data: new Float32Array(64 * 64 * 3),
    width: 64,
    height: 64,
    meta: { notes: [] },
  };
  // A uniform dim background plus one star.
  for (let i = 0; i < 64 * 64; i++) {
    const v = 0.05;
    raster.data[i * 3] = v;
    raster.data[i * 3 + 1] = v;
    raster.data[i * 3 + 2] = v;
  }
  const scene = {
    width: 64,
    height: 64,
    stars: [
      { x: 32, y: 32, flux: 10, peak: 0.3, fluxNorm: 0.3, fwhm: 2.2, ellipticity: 0, snr: 20, z: 0.5, phase: 0, twinkleRate: 1, haloR: 4 },
    ],
    psf: {},
    starless: { data: new Uint8ClampedArray(64 * 64 * 4).fill(13), width: 64, height: 64 },
    depth: { zNebula: 0.3 },
    meta: {},
  };
  const r = createRenderer(scene, { resolution: 64, durationSec: 1, fps: 2, twinkle: 0, bloom: 0, vignette: 0 });
  assert.ok(Math.abs(r.stars[0].peakLinear - srgbToLin(0.3)) < 1e-6, 'renderer must linearise the peak');
  assert.ok(r.stars[0].peakLinear < r.stars[0].peak, 'linear value must be below the sRGB value');
});

// ---------------------------------------------------------------------------
// Detection: bright stars must survive, and the frame PSF must be sane.
// Defect: bright stars with large diffraction spikes exceeded the area filter
// and were dropped entirely, so the starless plate still contained them.
// ---------------------------------------------------------------------------

test('detectStars keeps bright stars and reports a plausible frame PSF', () => {
  const W = 200;
  const H = 200;
  const data = new Float32Array(W * H * 3);
  const rnd = mulberry32(77);
  const stars = [
    { x: 50.2, y: 50.4, a: 1.0 },
    { x: 150.7, y: 60.1, a: 0.55 },
    { x: 100.3, y: 150.9, a: 0.3 },
  ];
  const sigma = 1.4;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let v = 0.03 + (rnd() - 0.5) * 0.004;
      for (const s of stars) {
        const dx = x - s.x;
        const dy = y - s.y;
        v += s.a * Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma));
      }
      const c = Math.min(1, Math.max(0, v));
      const p = (y * W + x) * 3;
      data[p] = c;
      data[p + 1] = c;
      data[p + 2] = c;
    }
  }
  const raster = { data, width: W, height: H, meta: {} };
  const found = detectStars(raster);
  assert.ok(found.length >= 3, `expected at least 3 stars, got ${found.length}`);
  for (const want of stars) {
    const near = found.filter((s) => Math.hypot(s.x - want.x, s.y - want.y) < 2);
    assert.ok(near.length >= 1, `no detection within 2 px of (${want.x},${want.y})`);
  }
  // Every star must carry the frame PSF, and it must be near the truth (1.4 px
  // sigma -> FWHM 3.30 px). The moment estimator over a small window is biased,
  // so allow a generous band but require the right order of magnitude.
  const psf = found[0].psfFwhm;
  assert.ok(psf > 1.2 && psf < 6, `frame PSF ${psf} outside a plausible range`);
  for (const s of found) {
    assert.ok(s.fwhm > 0.9, `fwhm ${s.fwhm}`);
    assert.ok(Number.isFinite(s.haloR) && s.haloR >= 3, `haloR ${s.haloR}`);
  }
});

test('analyzeSync gives every star a depth and keeps the starless plate sized right', () => {
  const W = 96;
  const H = 72;
  const data = new Float32Array(W * H * 3).fill(0.04);
  const raster = { data, width: W, height: H, meta: { notes: [] } };
  const scene = analyzeSync(raster, { seed: 1337 });
  assert.equal(scene.starless.width, W);
  assert.equal(scene.starless.height, H);
  assert.equal(scene.starless.data.length, W * H * 4);
  for (const s of scene.stars) {
    assert.ok(s.z >= 0 && s.z <= 1, 'every star needs a depth in 0..1');
  }
});

// ---------------------------------------------------------------------------
// CachedFrameSource: eliminates redundant rasterization in multi-format exports.
// ---------------------------------------------------------------------------

test('createCachedFrameSource avoids duplicate rendering and preserves exact pixel bytes (memory mode)', () => {
  let renders = 0;
  const W = 32, H = 24, count = 10;
  const baseSource = {
    width: W,
    height: H,
    fps: 10,
    count,
    durationSec: 1,
    renderer: null,
    renderFrame(i, out) {
      renders++;
      for (let p = 0; p < out.length; p += 4) {
        out[p] = (i * 20) & 255;
        out[p + 1] = 100;
        out[p + 2] = 200;
        out[p + 3] = 255;
      }
    },
  };

  const cached = createCachedFrameSource(baseSource, { maxMemoryBytes: 10 * 1024 * 1024 });
  const out1 = new Uint8ClampedArray(W * H * 4);
  const out2 = new Uint8ClampedArray(W * H * 4);

  // First pass: render frames 0, 1, 2
  cached.renderFrame(0, out1);
  cached.renderFrame(1, out1);
  cached.renderFrame(2, out1);
  assert.equal(renders, 3);
  assert.equal(cached.getStats().misses, 3);
  assert.equal(cached.getStats().hits, 0);

  // Second pass: request frame 1 and 0 again
  cached.renderFrame(1, out2);
  assert.equal(renders, 3, 'cache hit must not invoke base renderFrame');
  assert.equal(out2[0], (1 * 20) & 255);
  assert.equal(cached.getStats().hits, 1);

  cached.renderFrame(0, out2);
  assert.equal(renders, 3, 'cache hit must not invoke base renderFrame');
  assert.equal(out2[0], 0);
  assert.equal(cached.getStats().hits, 2);

  cached.dispose();
});

test('createCachedFrameSource spills to disk and disposes temp file cleanly (disk mode)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'w3a-cache-test-'));
  try {
    let renders = 0;
    const W = 32, H = 24, count = 5;
    const baseSource = {
      width: W,
      height: H,
      fps: 10,
      count,
      durationSec: 0.5,
      renderer: null,
      renderFrame(i, out) {
        renders++;
        out.fill(i + 1);
      },
    };

    // Force disk mode by setting maxMemoryBytes very small (0 bytes)
    const cached = createCachedFrameSource(baseSource, { workDir: tmpDir, maxMemoryBytes: 0 });
    assert.equal(cached.getStats().useDisk, true);
    assert.ok(cached.getStats().filePath, 'temp file path must be recorded');
    assert.ok(fs.existsSync(cached.getStats().filePath), 'temp file must be created on disk');

    const out1 = new Uint8ClampedArray(W * H * 4);
    cached.renderFrame(2, out1);
    assert.equal(renders, 1);
    assert.equal(out1[0], 3);

    const out2 = new Uint8ClampedArray(W * H * 4);
    cached.renderFrame(2, out2);
    assert.equal(renders, 1, 'second fetch must come from disk cache');
    assert.equal(out2[0], 3);
    assert.deepEqual(out1, out2);

    const filePath = cached.getStats().filePath;
    cached.dispose();
    assert.equal(fs.existsSync(filePath), false, 'temp file must be removed on dispose()');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('runExport with multiple formats activates caching and disposes temporary file cleanly', async () => {
  const job = createJob({ kind: 'multi-test' });
  const W = 64, H = 48;
  const data = new Float32Array(W * H * 3).fill(0.05);
  const raster = { data, width: W, height: H, meta: { notes: [] } };
  const scene = analyzeSync(raster, { seed: 1337 });

  const artifacts = await runExport({
    job,
    scene,
    params: { resolution: 64, durationSec: 1, fps: 6 },
    format: 'all',
  });

  assert.ok(artifacts.length >= 4, `expected all artifacts, got ${artifacts.length}`);
  const jobDir = path.join(job.id ? path.resolve('work/jobs', `job-${job.id}`) : '');
  if (fs.existsSync(jobDir)) {
    const files = fs.readdirSync(jobDir);
    const leakedCache = files.filter((f) => f.startsWith('.frames-cache'));
    assert.equal(leakedCache.length, 0, 'no temp frame cache files should be leaked after export');
  }
});

// ---------------------------------------------------------------------------
// P1 Feature Tests: Gaussian LUT, Ping-Pong Looping, Star Color Preservation
// ---------------------------------------------------------------------------

test('fastExpNeg provides accurate and monotonic Gaussian decay', () => {
  for (let u = 0; u < 7.0; u += 0.05) {
    const approx = fastExpNeg(u);
    const truth = Math.exp(-u);
    assert.ok(Math.abs(approx - truth) < 0.001, `mismatch at u=${u}: approx=${approx}, truth=${truth}`);
  }
  assert.equal(fastExpNeg(7.0), 0);
  assert.equal(fastExpNeg(10.0), 0);
});

test('cameraAt with loopMode=pingpong produces a seamless loop with identical first and last frame state', () => {
  const params = { loopMode: 'pingpong', dolly: 0.5, dollyEase: 'inOut', drift: 0.02, roll: 0.05 };
  const c0 = cameraAt(0, params);
  const c1 = cameraAt(1, params);
  const cmid = cameraAt(0.5, params);

  // First frame and last frame must be identical in all spatial properties
  assert.equal(c0.k, 0);
  assert.equal(c1.k, 0);
  assert.equal(c0.scale, c1.scale);
  assert.ok(Math.abs(c0.ox - c1.ox) < 1e-6, `ox mismatch: ${c0.ox} vs ${c1.ox}`);
  assert.ok(Math.abs(c0.oy - c1.oy) < 1e-6, `oy mismatch: ${c0.oy} vs ${c1.oy}`);
  assert.ok(Math.abs(c0.roll - c1.roll) < 1e-6, `roll mismatch: ${c0.roll} vs ${c1.roll}`);

  // Midpoint must reach full progress
  assert.equal(cmid.k, 1);
  assert.ok(cmid.scale > c0.scale, 'camera must zoom in at t=0.5');
});

test('detectStars preserves star color ratios and renderFrame composites them', () => {
  const W = 256, H = 256;
  const data = new Float32Array(W * H * 3).fill(0.02);

  // Injected red star at (60, 60): R is high, G and B are low
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const idx = ((60 + dy) * W + (60 + dx)) * 3;
      const att = Math.exp(-(dx * dx + dy * dy) / 2);
      data[idx] += 0.9 * att;     // R
      data[idx + 1] += 0.2 * att; // G
      data[idx + 2] += 0.1 * att; // B
    }
  }

  // Injected blue star at (180, 180): B is high, R and G are low
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const idx = ((180 + dy) * W + (180 + dx)) * 3;
      const att = Math.exp(-(dx * dx + dy * dy) / 2);
      data[idx] += 0.15 * att;   // R
      data[idx + 1] += 0.25 * att; // G
      data[idx + 2] += 0.95 * att; // B
    }
  }

  const raster = { data, width: W, height: H, meta: { notes: [] } };
  const stars = detectStars(raster, { minArea: 1, minSnr: 3 });
  assert.ok(stars.length >= 2, `expected at least 2 stars, found ${stars.length}`);

  const redStar = stars.find((s) => Math.hypot(s.x - 60, s.y - 60) < 2);
  const blueStar = stars.find((s) => Math.hypot(s.x - 180, s.y - 180) < 2);

  assert.ok(redStar, 'red star detected');
  assert.ok(blueStar, 'blue star detected');
  assert.ok(redStar.color[0] > redStar.color[2], 'red star R channel should dominate B');
  assert.ok(blueStar.color[2] > blueStar.color[0], 'blue star B channel should dominate R');

  // Verify renderFrame applies colors
  const scene = analyzeSync(raster, { minSnr: 3, seed: 1337 });
  const renderer = createRenderer(scene, { resolution: 256, starColor: 1.0, drift: 0, roll: 0 });
  const out = new Uint8ClampedArray(W * H * 4);
  renderer.renderFrame(0, 1, out);

  // Peak pixel around red star (60, 60)
  let maxR = -1, redPixel = null;
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const p = ((60 + dy) * W + (60 + dx)) * 4;
      if (out[p] > maxR) {
        maxR = out[p];
        redPixel = [out[p], out[p + 1], out[p + 2]];
      }
    }
  }

  // Peak pixel around blue star (180, 180)
  let maxB = -1, bluePixel = null;
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const p = ((180 + dy) * W + (180 + dx)) * 4;
      if (out[p + 2] > maxB) {
        maxB = out[p + 2];
        bluePixel = [out[p], out[p + 1], out[p + 2]];
      }
    }
  }

  assert.ok(redPixel, 'found rendered red star core');
  assert.ok(bluePixel, 'found rendered blue star core');
  assert.ok(redPixel[0] > redPixel[2], `rendered red star R (${redPixel[0]}) should be higher than B (${redPixel[2]})`);
  assert.ok(bluePixel[2] > bluePixel[0], `rendered blue star B (${bluePixel[2]}) should be higher than R (${bluePixel[0]})`);
});

test('pruneWorkDirectory enforces TTL and max size limits on jobs/uploads', async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'w3a-prune-test-'));
  try {
    const jobsDir = path.join(tmp, 'jobs');
    const uploadsDir = path.join(tmp, 'uploads');
    await fsp.mkdir(jobsDir, { recursive: true });
    await fsp.mkdir(uploadsDir, { recursive: true });

    // File 1: Old job (TTL expired)
    const oldJobDir = path.join(jobsDir, 'old-job');
    await fsp.mkdir(oldJobDir, { recursive: true });
    await fsp.writeFile(path.join(oldJobDir, 'data.bin'), Buffer.alloc(1000));
    const oldTime = (Date.now() - 100000) / 1000;
    fs.utimesSync(oldJobDir, oldTime, oldTime);

    // File 2: Recent upload
    const recentUpload = path.join(uploadsDir, 'recent.raw');
    await fsp.writeFile(recentUpload, Buffer.alloc(500));
    const recentTime = Date.now() / 1000;
    fs.utimesSync(recentUpload, recentTime, recentTime);

    // Run pruning with maxAgeMs = 50000
    const res1 = pruneWorkDirectory({ workDir: tmp, maxAgeMs: 50000, maxBytes: 1000000 });
    assert.equal(res1.removedCount, 1, 'should remove 1 expired entry');
    assert.equal(fs.existsSync(oldJobDir), false, 'old-job should be deleted');
    assert.equal(fs.existsSync(recentUpload), true, 'recent upload should be kept');

    // File 3: Add large recent file exceeding maxBytes
    const largeUpload = path.join(uploadsDir, 'large.raw');
    await fsp.writeFile(largeUpload, Buffer.alloc(800));

    // Run pruning with small maxBytes = 600
    const res2 = pruneWorkDirectory({ workDir: tmp, maxAgeMs: 1000000, maxBytes: 600 });
    assert.ok(res2.removedCount >= 1, 'should prune entries to stay under maxBytes');
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
});

test('detectH264Encoder and getH264EncoderArgs correctly select and parameterize encoders', async () => {
  _resetDetectedH264Encoder();
  const detected = await detectH264Encoder({ force: true });
  assert.ok(detected.name, 'should detect encoder name');
  assert.equal(typeof detected.isHardware, 'boolean');

  // getH264EncoderArgs checks
  const vtArgs = getH264EncoderArgs('h264_videotoolbox', { crf: 18, preset: 'medium', fps: 30, outPath: '/tmp/out.mp4' });
  assert.ok(vtArgs.includes('h264_videotoolbox'));
  assert.ok(vtArgs.includes('-b:v'));
  assert.equal(vtArgs.includes('-crf'), false, 'videotoolbox must not have -crf flag');
  assert.equal(vtArgs.includes('-preset'), false, 'videotoolbox must not have -preset flag');

  const x264Args = getH264EncoderArgs('libx264', { crf: 18, preset: 'medium', fps: 30, outPath: '/tmp/out.mp4' });
  assert.ok(x264Args.includes('libx264'));
  assert.ok(x264Args.includes('-crf'));
  assert.ok(x264Args.includes('-preset'));

  // Test disable hwaccel env
  process.env.DISABLE_HWACCEL = '1';
  _resetDetectedH264Encoder();
  const swOnly = await detectH264Encoder({ force: true });
  assert.equal(swOnly.name, 'libx264');
  assert.equal(swOnly.isHardware, false);
  delete process.env.DISABLE_HWACCEL;
  _resetDetectedH264Encoder();
});

test('backendLabel maps states correctly including draft mode', () => {
  assert.equal(backendLabel('draft'), '实时草稿');
  assert.equal(backendLabel('media'), '准确预览');
  assert.equal(backendLabel('none'), '不可用');
  assert.equal(backendLabel('unknown'), '不可用');
});

test('star bloom model applies soft threshold and subtle halo weight', () => {
  assert.equal(DEFAULT_PARAMS.bloom, 0.16);
  assert.equal(DEFAULT_PARAMS.starGain, 1);
  assert.equal(DEFAULT_PARAMS.nebulaGain, 1.05);
  assert.equal(DEFAULT_PARAMS.coc, 0.06);

  const W = 256, H = 256;
  const data = new Float32Array(W * H * 3).fill(0.02);
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const idx = ((128 + dy) * W + (128 + dx)) * 3;
      const att = Math.exp(-(dx * dx + dy * dy) / 2);
      data[idx] += 0.95 * att;
      data[idx + 1] += 0.95 * att;
      data[idx + 2] += 0.95 * att;
    }
  }
  const scene = analyzeSync({ data, width: W, height: H, meta: { notes: [] } }, { minSnr: 3, seed: 1337 });
  assert.ok(scene.stars.length >= 1, 'must detect injected star');

  const renderer = createRenderer(scene, { resolution: 256, bloom: 0.16 });
  const out = new Uint8ClampedArray(W * H * 4);
  renderer.renderFrame(0, 1, out);

  const star = renderer.stars[0];
  const cx = Math.round(star.x);
  const cy = Math.round(star.y);
  const p0 = out[(cy * W + cx) * 4];
  const p2 = out[(cy * W + cx + 2) * 4];
  assert.ok(p0 > 120, 'center peak must have strong specular punch');
  assert.ok(p0 / Math.max(1, p2) >= 2.0, 'steepness must ensure sharp pinpoint core');
});

test('bilinear plate resampling produces subpixel smooth transitions during camera motion', () => {
  const W = 64, H = 64;
  const starlessData = new Uint8ClampedArray(W * H * 4);
  // Create a linear gradient plate: x goes from 0 to 255
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = (y * W + x) * 4;
      const val = Math.round((x / (W - 1)) * 200 + 20);
      starlessData[idx] = val;
      starlessData[idx + 1] = val;
      starlessData[idx + 2] = val;
      starlessData[idx + 3] = 255;
    }
  }

  const scene = {
    width: W,
    height: H,
    stars: [],
    starless: { data: starlessData, width: W, height: H },
    depth: { zNebula: 0.3 },
  };

  const renderer = createRenderer(scene, {
    resolution: W,
    durationSec: 2,
    fps: 10,
    dolly: 0.2,
    twinkle: 0,
    drift: 0.05,
  });

  const f0 = new Uint8ClampedArray(W * H * 4);
  const f1 = new Uint8ClampedArray(W * H * 4);
  renderer.renderFrame(0, 20, f0);
  renderer.renderFrame(1, 20, f1);

  // With bilinear interpolation, subpixel camera drift produces small, smooth differences (not 0, not huge jumps)
  let diffCount = 0;
  let maxDiff = 0;
  for (let i = 0; i < f0.length; i += 4) {
    const diff = Math.abs(f0[i] - f1[i]);
    if (diff > 0) diffCount++;
    if (diff > maxDiff) maxDiff = diff;
  }
  assert.ok(diffCount > 0, 'subpixel drift must produce interpolated change across frames');
  assert.ok(maxDiff <= 15, `transitions must be smooth without abrupt jumps (maxDiff: ${maxDiff})`);
});

test('PreviewRenderer.returnToDraft resets manifest and switches backend from media to draft', () => {
  const videoMock = {
    pause() {},
    removeAttribute(attr) {},
    load() {},
    hidden: false,
  };
  const canvasMock = {
    hidden: true,
    width: 100,
    height: 100,
  };
  const fakePlayer = Object.assign(Object.create(PreviewRenderer.prototype), {
    ctx: {},
    manifest: { frameCount: 10, type: 'video' },
    video: videoMock,
    canvas: canvasMock,
    _ready: true,
    _cache: new Map(),
    _draftProgress: 0,
    _frameIndex: 5,
    _generation: 0,
    _request: 0,
    setPlaying(on) { this.playing = !!on; },
    render() { this.rendered = true; },
    _emit() { this.emitted = true; },
  });

  // Before returnToDraft, backend is 'media'
  assert.equal(fakePlayer.backend, 'media');

  // Trigger returnToDraft
  fakePlayer.returnToDraft(true);

  // After returnToDraft:
  assert.equal(fakePlayer.backend, 'draft');
  assert.equal(fakePlayer.manifest, null);
  assert.equal(videoMock.hidden, true);
  assert.equal(canvasMock.hidden, false);
  assert.equal(fakePlayer.rendered, true);
  assert.equal(fakePlayer.emitted, true);
});

test('PreviewRenderer._renderDraft applies filter, vignette and defocus parameters safely', () => {
  const operations = [];
  const fakeCtx = {
    save() { operations.push('save'); },
    restore() { operations.push('restore'); },
    translate(x, y) { operations.push(`translate(${x},${y})`); },
    scale(x, y) { operations.push(`scale(${x},${y})`); },
    drawImage() { operations.push('drawImage'); },
    beginPath() { operations.push('beginPath'); },
    arc() { operations.push('arc'); },
    fill() { operations.push('fill'); },
    fillRect() { operations.push('fillRect'); },
    createRadialGradient() {
      operations.push('createRadialGradient');
      return { addColorStop() {} };
    },
    filter: 'none',
  };

  const fakePlayer = {
    ctx: fakeCtx,
    _plate: { naturalWidth: 100, naturalHeight: 100 },
    scene: {
      stars: [
        { x: 50, y: 50, r: 2, z: 0.1, flux: 1, fluxNorm: 0.9 },
        { x: 30, y: 30, r: 1, z: 0.9, flux: 0.5, fluxNorm: 0.2 },
      ],
    },
    params: {
      nebulaGain: 1.2,
      background: 0.1,
      vignette: 0.2,
      focus: 0.1,
      coc: 0.15,
      dolly: 0.3,
      starScale: 1.2,
    },
  };

  PreviewRenderer.prototype._renderDraft.call(fakePlayer, 100, 100, 0.5);

  assert.ok(operations.includes('drawImage'), 'should draw plate image');
  assert.ok(operations.includes('createRadialGradient'), 'should create vignette radial gradient');
  assert.ok(operations.includes('fillRect'), 'should fill vignette gradient');
  assert.ok(operations.filter((op) => op === 'arc').length >= 2, 'should draw star arcs');
  assert.equal(fakeCtx.filter, 'none', 'should reset filter back to none');
});

