// Global configuration, paths and default parameters.
// Everything here is local-only: no network, no telemetry, loopback binding.
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const PATHS = {
  root: ROOT,
  web: path.join(ROOT, 'web'),
  samples: path.join(ROOT, 'samples'),
  work: process.env.WEB3ASTRA_WORK || path.join(ROOT, 'work'),
  uploads: path.join(ROOT, 'work', 'uploads'),
  jobs: path.join(ROOT, 'work', 'jobs'),
  tmp: path.join(ROOT, 'work', 'tmp'),
};

for (const dir of Object.values(PATHS)) {
  if (dir !== PATHS.root && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export const SERVER = {
  host: '127.0.0.1',
  port: Number(process.env.PORT || 8765),
  version: '0.1.0',
  // Uploads are held in memory: this is a local single-user tool.
  maxUploadBytes: 256 * 1024 * 1024,
  maxDecodeEdge: 4096,
  previewEdge: 1600,
  jobHistory: 24,
  workMaxAgeMs: 24 * 3600 * 1000,
  workMaxBytes: 2 * 1024 * 1024 * 1024,
};

/** Default render parameters. Mirrors CONTRACTS.md §2.4. */
export const DEFAULT_PARAMS = {
  durationSec: 6,
  fps: 30,
  resolution: 1280,
  dolly: 0.45,
  dollyEase: 'inOut',
  parallax: 1,
  depthSpread: 0.6,
  depthPower: 1.35,
  twinkle: 0.25,
  starScale: 1,
  bloom: 0.16,
  starGain: 1,
  nebulaGain: 1.05,
  background: 0,
  vignette: 0.15,
  occlusion: 0.55,
  focus: 0.5,
  coc: 0.06,
  seed: 1337,
  starColor: 0.85,
  loopMode: 'forward',
};

export const ANALYSIS = {
  // Cap on the catalogue. 2200 is comfortably above what a rich 1600px field
  // yields at the detection settings below, so it only ever acts as a safety
  // valve against pathological input.
  maxStars: 2200,
  detectSigma: 4.5,
  minArea: 2,
  // Minimum peak-over-noise for a detection to be kept. Lower values admit
  // noise peaks, which matters more than it sounds: 2000 barely-significant
  // detections drawn as sprites read as snow, not as a star field.
  minSnr: 10,
  maxArea: 260,        // reject extended nebula knots
  maxEllipticity: 0.92,
  starlessIterations: 44,
  starlessMargin: 1.05, // dilation factor of the star footprint before inpainting
  // Pyramid depth for the starless fill. Deeper is NOT better: once a level is
  // small enough that only a couple of its cells are unmasked, the interpolation
  // degenerates into a single global average and the filled nebula turns into a
  // flat wash. Stopping at ~64 px keeps the fill local.
  starlessMinSide: 64,
};

export const ENCODE = {
  mp4: { codec: 'libx264', crf: 18, preset: 'medium' },
  // A "live image" is meant to be shared, so it gets a size budget: cap the long
  // edge and the frame rate. Full quality stays available in the MP4.
  webp: { quality: 68, method: 6, loop: 0, maxEdge: 800, fpsCap: 24 },
  // APNG is lossless, so it needs a much smaller frame budget than MP4.
  apng: { fpsCap: 12, maxEdge: 640 },
  gif: { fpsCap: 10, maxEdge: 560 },
  posterQuality: 92,
};

export function workDirFor(kind, id) {
  const dir = path.join(PATHS.jobs, `${kind}-${id}`);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function tmpDir(prefix = 'w3a') {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

export const CAPS = {
  platform: process.platform,
  arch: process.arch,
  node: process.version,
};
