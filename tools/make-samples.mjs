#!/usr/bin/env node
/**
 * deepsky-motion — deterministic synthetic deep-sky sample generator.
 *
 *   node tools/make-samples.mjs [--seed 1337] [--out samples]
 *
 * Produces (into --out, default `samples/`):
 *   nebula-1600.png   1600x1067  emission nebula + rich star field
 *   galaxy-1400.png   1400x1400  inclined spiral galaxy
 *   cluster-1200.png  1200x900   globular cluster, no nebula
 *   nebula-1024.fits  1024x683   16-bit FITS of the nebula scene (linear, needs a stretch)
 *   README.md
 *
 * Everything is driven by a seeded PRNG (`mulberry32`) threaded through the whole
 * pipeline: two runs with the same seed produce byte-identical files.
 *
 * Rendering model (all in linear light units, tone-mapped once at the very end):
 *   scene (nebula/galaxy/cluster + stars)
 *     -> airglow + light-pollution gradient (additive)
 *     -> vignetting (multiplicative)
 *     -> asinh stretch + highlight rolloff  (the "development" step)
 *     -> saturation / contrast
 *     -> shot + read noise, row banding, hot pixels
 *     -> 8-bit RGB -> PNG (sharp)
 */

import sharp from 'sharp';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// ---------------------------------------------------------------------------
// constants / small math
// ---------------------------------------------------------------------------

const TAU = Math.PI * 2;
const FWHM_K = 2.3548200450309493; // 2*sqrt(2 ln 2)
const SQRT2 = Math.SQRT2;

const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

/** Deterministic PRNG. Returns a function producing floats in [0,1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic standard-normal source backed by a seeded PRNG. */
function makeGaussian(rand) {
  let cached = null;
  return function gauss() {
    if (cached !== null) {
      const c = cached;
      cached = null;
      return c;
    }
    let u = 0;
    let v = 0;
    while (u === 0) u = rand();
    while (v === 0) v = rand();
    const m = Math.sqrt(-2 * Math.log(u));
    cached = m * Math.sin(TAU * v);
    return m * Math.cos(TAU * v);
  };
}

const pick = (rand, arr) => arr[Math.min(arr.length - 1, Math.floor(rand() * arr.length))];

/** Uniform float in [a,b). */
const range = (rand, a, b) => a + (b - a) * rand();

// ---------------------------------------------------------------------------
// gradient (Perlin) noise + fbm
// ---------------------------------------------------------------------------

const GRAD2 = [
  [1, 1], [-1, 1], [1, -1], [-1, -1],
  [1, 0], [-1, 0], [0, 1], [0, -1],
];

/** Seeded 2-D Perlin noise, roughly in [-1,1]. */
function makeNoise2D(rand) {
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = p[i];
    p[i] = p[j];
    p[j] = t;
  }
  const perm = new Uint8Array(512);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];

  return function noise2(x, y) {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const X = xi & 255;
    const Y = yi & 255;
    const xf = x - xi;
    const yf = y - yi;
    const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
    const v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
    const g00 = GRAD2[perm[(perm[X] + Y) & 255] & 7];
    const g10 = GRAD2[perm[(perm[X + 1] + Y) & 255] & 7];
    const g01 = GRAD2[perm[(perm[X] + Y + 1) & 255] & 7];
    const g11 = GRAD2[perm[(perm[X + 1] + Y + 1) & 255] & 7];
    const n00 = g00[0] * xf + g00[1] * yf;
    const n10 = g10[0] * (xf - 1) + g10[1] * yf;
    const n01 = g01[0] * xf + g01[1] * (yf - 1);
    const n11 = g11[0] * (xf - 1) + g11[1] * (yf - 1);
    const nx0 = n00 + u * (n10 - n00);
    const nx1 = n01 + u * (n11 - n01);
    return (nx0 + v * (nx1 - nx0)) * 1.4; // normalise to ~[-1,1]
  };
}

function fbm(noise, x, y, octaves, gain = 0.5, lacunarity = 2.03) {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise(x * freq, y * freq);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

/** Ridged variant — produces thin bright filaments. */
function ridged(noise, x, y, octaves, gain = 0.5) {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(noise(x * freq, y * freq));
    sum += amp * n * n;
    norm += amp;
    amp *= gain;
    freq *= 2.07;
  }
  return sum / norm; // 0..1, bright ridges near 1
}

// ---------------------------------------------------------------------------
// star colours
// ---------------------------------------------------------------------------

/**
 * Realistic-ish spectral mix for a Milky-Way field population.
 * Colours are linear-ish RGB triples normalised so max channel = 1.
 */
const SPECTRAL_TYPES = [
  { name: 'O5', w: 0.008, rgb: [0.58, 0.68, 1.00] },
  { name: 'B3', w: 0.022, rgb: [0.68, 0.78, 1.00] },
  { name: 'B8', w: 0.038, rgb: [0.78, 0.85, 1.00] },
  { name: 'A2', w: 0.085, rgb: [0.88, 0.92, 1.00] },
  { name: 'A7', w: 0.075, rgb: [0.95, 0.96, 1.00] },
  { name: 'F2', w: 0.090, rgb: [1.00, 0.98, 0.96] },
  { name: 'F8', w: 0.100, rgb: [1.00, 0.95, 0.87] },
  { name: 'G2', w: 0.130, rgb: [1.00, 0.91, 0.76] },
  { name: 'G8', w: 0.110, rgb: [1.00, 0.86, 0.68] },
  { name: 'K2', w: 0.150, rgb: [1.00, 0.79, 0.58] },
  { name: 'K7', w: 0.120, rgb: [1.00, 0.69, 0.45] },
  { name: 'M2', w: 0.060, rgb: [1.00, 0.60, 0.38] },
  { name: 'M6', w: 0.012, rgb: [1.00, 0.50, 0.30] },
];
const SPECTRAL_TOTAL = SPECTRAL_TYPES.reduce((s, t) => s + t.w, 0);

function sampleStarColor(rand, boost = 1.0) {
  let u = rand() * SPECTRAL_TOTAL;
  let rgb = SPECTRAL_TYPES[SPECTRAL_TYPES.length - 1].rgb;
  for (const t of SPECTRAL_TYPES) {
    u -= t.w;
    if (u <= 0) {
      rgb = t.rgb;
      break;
    }
  }
  const jitter = 1 + (rand() - 0.5) * 0.06;
  const r = Math.pow(rgb[0] * jitter, boost);
  const g = Math.pow(rgb[1] * jitter, boost);
  const b = Math.pow(rgb[2] * jitter, boost);
  const m = Math.max(r, g, b, 1e-6);
  return [r / m, g / m, b / m];
}

// ---------------------------------------------------------------------------
// star field
// ---------------------------------------------------------------------------

/**
 * Magnitude sampler for N(<m) ∝ 10^(0.4 m) — many faint stars, few bright ones.
 * `u` near 0 -> brightest end.
 */
function sampleMagnitude(u, magBright, magFaint) {
  const a = Math.pow(10, 0.4 * magBright);
  const b = Math.pow(10, 0.4 * magFaint);
  return 2.5 * Math.log10(a + u * (b - a));
}

/**
 * Build a star list in pixel coordinates.
 * Positions are generated in units of the long edge so the same seed gives the
 * same scene at any resolution.
 */
function makeStars(rand, W, H, cfg) {
  const {
    count = 1200,
    magBright = 6.4,
    magFaint = 16.4,
    fwhmMin = 1.75,
    fwhmMax = 2.9,
    colorBoost = 1.0,
    elongMax = 1.14,
    elongAngle = 0.4,
    spikeMag = 7.4,
    spikeCount = 3,
  } = cfg;

  const stars = [];
  const fwhmScale = W / 1600;
  const baseFwhm = () => range(rand, fwhmMin, fwhmMax) * (0.75 + 0.25 * fwhmScale);

  // Forced "showcase" bright stars so the frame always has a few spiked ones.
  const showcase = [
    { m: 5.35, x: 0.215, y: 0.285 },
    { m: 6.05, x: 0.775, y: 0.205 },
    { m: 6.55, x: 0.585, y: 0.735 },
    { m: 6.95, x: 0.115, y: 0.815 },
    { m: 7.35, x: 0.905, y: 0.575 },
  ];
  for (let i = 0; i < spikeCount; i++) {
    const s = showcase[i];
    stars.push({
      x: s.x * W + range(rand, -6, 6),
      y: s.y * H + range(rand, -6, 6),
      mag: s.m + range(rand, -0.08, 0.08),
      fwhm: range(rand, 2.15, 2.75),
      elong: range(rand, 1.0, 1.06),
      angle: elongAngle + range(rand, -0.12, 0.12),
      color: sampleStarColor(rand, colorBoost),
      spikes: true,
    });
  }
  // Remaining showcase stars: bright but spikeless (below the spike threshold).
  for (let i = spikeCount; i < showcase.length; i++) {
    const s = showcase[i];
    stars.push({
      x: s.x * W + range(rand, -8, 8),
      y: s.y * H + range(rand, -8, 8),
      mag: s.m + range(rand, -0.1, 0.1),
      fwhm: range(rand, 1.9, 2.5),
      elong: range(rand, 1.0, 1.08),
      angle: elongAngle + range(rand, -0.2, 0.2),
      color: sampleStarColor(rand, colorBoost),
      spikes: false,
    });
  }

  for (let i = 0; i < count; i++) {
    const mag = sampleMagnitude(rand(), magBright, magFaint);
    stars.push({
      x: rand() * W,
      y: rand() * H,
      mag,
      fwhm: baseFwhm(),
      elong: 1 + rand() * (elongMax - 1),
      angle: elongAngle + range(rand, -0.35, 0.35),
      color: sampleStarColor(rand, colorBoost),
      spikes: mag < spikeMag,
    });
  }
  return stars;
}

/** Faint, unresolved stars: they only add mottled texture to the sky. */
function makeFaintStars(rand, W, H, count, magMin, magMax, fwhm = 1.35) {
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push({
      x: rand() * W,
      y: rand() * H,
      mag: magMin + rand() * (magMax - magMin),
      fwhm: fwhm * range(rand, 0.85, 1.2),
      elong: 1 + rand() * 0.1,
      angle: rand() * TAU,
      color: sampleStarColor(rand, 1.0),
      spikes: false,
    });
  }
  return out;
}

/**
 * Draw one star into a linear RGB buffer.
 * Gaussian core (FWHM), soft halo for bright stars, optional 4-point
 * diffraction spikes, slight elongation from tracking error.
 */
function stampStar(buf, W, H, star, opts) {
  const { zeroPoint, saturate = 6.0 } = opts;
  const sigma = star.fwhm / FWHM_K;
  const elong = Math.max(star.elong, 1);
  const sx = sigma * Math.sqrt(elong);
  const sy = sigma / Math.sqrt(elong);
  const flux = Math.pow(10, -0.4 * (star.mag - zeroPoint));
  const peak = flux / (TAU * sx * sy);
  const ca = Math.cos(star.angle);
  const sa = Math.sin(star.angle);

  const bright = peak > saturate * 0.02;
  const spikeAmp = star.spikes && peak > saturate * 0.03 ? peak * 0.016 : 0;
  const spikeLen = spikeAmp ? clamp(28 + 16 * Math.log10(peak / saturate + 1.2), 26, 110) * (W / 1600) : 0;
  const haloScale = bright ? clamp(0.5 + Math.log10(1 + peak / saturate) * 0.9, 0.5, 2.2) : 0;

  const rCore = 4.6 * Math.max(sx, sy);
  const rHalo = haloScale ? sigma * (10 + 8 * haloScale) : 0;
  const R = Math.min(120, Math.max(3, rCore, rHalo, spikeLen * 1.05));
  const x0 = Math.max(0, Math.floor(star.x - R));
  const x1 = Math.min(W - 1, Math.ceil(star.x + R));
  const y0 = Math.max(0, Math.floor(star.y - R));
  const y1 = Math.min(H - 1, Math.ceil(star.y + R));

  const inv2sx2 = 1 / (2 * sx * sx);
  const inv2sy2 = 1 / (2 * sy * sy);
  const halo1 = peak * 0.013 * haloScale;
  const halo2 = peak * 0.0045 * haloScale;
  const sigH1 = 2.4 * sigma;
  const sigH2 = 8.5 * sigma;
  const spikeW2 = 1 / (2 * 0.62 * 0.62);
  const spikeInvL = spikeLen ? 1 / (spikeLen * 0.55) : 0;
  const [cr, cg, cb] = star.color;

  for (let py = y0; py <= y1; py++) {
    const dy = py + 0.5 - star.y;
    const rowBase = py * W * 3;
    for (let px = x0; px <= x1; px++) {
      const dx = px + 0.5 - star.x;
      const dxr = dx * ca + dy * sa;
      const dyr = -dx * sa + dy * ca;
      let v = peak * Math.exp(-(dxr * dxr * inv2sx2 + dyr * dyr * inv2sy2));
      if (haloScale) {
        const r = Math.sqrt(dx * dx + dy * dy);
        v += halo1 * Math.exp(-(r * r) / (2 * sigH1 * sigH1));
        v += halo2 * Math.exp(-(r * r) / (2 * sigH2 * sigH2));
      }
      if (spikeAmp) {
        // main 4-point cross (aligned with the optical axis) + faint 45° pair
        for (let a = 0; a < 2; a++) {
          const th = star.angle * 0.25 + a * Math.PI * 0.25;
          const ct = Math.cos(th);
          const st = Math.sin(th);
          const along = Math.abs(dx * ct + dy * st);
          const perp = -dx * st + dy * ct;
          if (along < spikeLen * 2.4) {
            const amp = a === 0 ? spikeAmp : spikeAmp * 0.28;
            v += amp * Math.exp(-perp * perp * spikeW2) * Math.exp(-along * spikeInvL);
          }
        }
      }
      if (v < 2e-7) continue;
      const i = rowBase + px * 3;
      buf[i] += v * cr;
      buf[i + 1] += v * cg;
      buf[i + 2] += v * cb;
    }
  }
}

function drawStars(buf, W, H, stars, opts) {
  // faintest first so bright stars sit on top
  const sorted = stars.slice().sort((a, b) => b.mag - a.mag);
  for (const s of sorted) stampStar(buf, W, H, s, opts);
}

// ---------------------------------------------------------------------------
// scene: emission nebula
// ---------------------------------------------------------------------------

function buildNebulaScene(seed, W, H, opts = {}) {
  const rand = mulberry32(seed * 7919 + 11);
  const nz = makeNoise2D(mulberry32(seed * 104729 + 3));
  const nz2 = makeNoise2D(mulberry32(seed * 15485863 + 7));
  const lin = new Float32Array(W * H * 3);
  const U = 1 / W; // 1.0 = long edge

  // irregular envelope: a few overlapping anisotropic blobs (normalised coords)
  // Kept deliberately compact so the nebula is an *object* in a dark field
  // rather than a wash covering the whole frame.
  const blobs = [
    { x: 0.375, y: 0.300, r: 0.190, ax: 1.34, ay: 0.88, ang: -0.42, w: 1.00 },
    { x: 0.590, y: 0.395, r: 0.140, ax: 1.08, ay: 1.00, ang: 0.25, w: 0.80 },
    { x: 0.235, y: 0.455, r: 0.115, ax: 1.18, ay: 0.72, ang: 0.95, w: 0.62 },
    { x: 0.470, y: 0.150, r: 0.095, ax: 1.22, ay: 0.80, ang: -0.20, w: 0.52 },
    { x: 0.760, y: 0.235, r: 0.085, ax: 1.00, ay: 0.95, ang: 0.30, w: 0.38 },
  ];
  // bright cores inside the cloud
  const cores = [
    { x: 0.410, y: 0.300, r: 0.048, w: 1.00 },
    { x: 0.530, y: 0.350, r: 0.034, w: 0.72 },
    { x: 0.310, y: 0.400, r: 0.030, w: 0.55 },
    { x: 0.240, y: 0.225, r: 0.026, w: 0.42 },
  ];
  const reflC = { x: 0.760, y: 0.180, r: 0.085 };

  const gain = opts.nebulaGain ?? 0.075;
  const dustStrength = opts.dust ?? 0.74;

  for (let py = 0; py < H; py++) {
    const v = (py + 0.5) * U;
    for (let px = 0; px < W; px++) {
      const u = (px + 0.5) * U;

      // --- domain-warped base density -------------------------------------
      const q1 = fbm(nz, u * 3.0 + 11.3, v * 3.0 + 5.7, 3);
      const q2 = fbm(nz, u * 3.0 + 3.1, v * 3.0 + 19.2, 3);
      const wu = u + 0.22 * q1;
      const wv = v + 0.22 * q2;
      const d = fbm(nz, wu * 2.6, wv * 2.6, 5) * 0.5 + 0.5;

      // --- envelope, broken up by noise so it has no smooth analytic edge ---
      let envBase = 0;
      for (const b of blobs) {
        const dx = u - b.x;
        const dy = v - b.y;
        const cb0 = Math.cos(b.ang);
        const sb0 = Math.sin(b.ang);
        const ru = (dx * cb0 + dy * sb0) / (b.r * b.ax);
        const rv = (-dx * sb0 + dy * cb0) / (b.r * b.ay);
        envBase += b.w * Math.exp(-(ru * ru + rv * rv) * 0.5);
      }
      const envEdge = fbm(nz2, u * 7.5 + 91.3, v * 7.5 + 55.1, 4) * 0.5 + 0.5;
      // global falloff: the nebula must fade into genuinely dark sky at the edges
      const gd = Math.hypot(u - 0.435, (v - 0.315) * 1.45);
      const envFall = Math.pow(clamp(1 - gd / 0.60), 1.35);
      const env = clamp(Math.pow(clamp(envBase * (0.45 + 1.10 * envEdge), 0, 1), 1.55) * envFall, 0, 1);

      // --- filaments (two scales, ridged) ----------------------------------
      const fil = ridged(nz2, wu * 5.6 + 31.0, wv * 5.6 + 17.0, 4);
      const fil2 = ridged(nz, wu * 11.5 + 71.0, wv * 11.5 + 29.0, 3);

      // --- dark dust lanes (anisotropic -> elongated) ----------------------
      const dn = fbm(nz2, u * 5.0 + 61.7, v * 1.9 + 23.3, 4) * 0.5 + 0.5;
      const dn2 = fbm(nz2, u * 9.5 + 7.3, v * 3.6 + 44.1, 3) * 0.5 + 0.5;
      const dust = smoothstep(0.44, 0.84, dn * 0.75 + dn2 * 0.35);

      // --- cloud density: multiplicative structure so filaments really read -
      const shape = (d - 0.5) * 1.55 + (env - 0.22) * 2.60;
      let cloud = smoothstep(0.00, 0.40, shape) * Math.pow(env, 0.70);
      cloud *= 0.30 + 1.15 * fil;
      cloud *= 0.62 + 0.55 * fil2;
      cloud *= 1 - dustStrength * dust * smoothstep(0.04, 0.30, cloud);

      // --- core brightening ------------------------------------------------
      let core = 0;
      for (const c of cores) {
        const dx = u - c.x;
        const dy = v - c.y;
        core += c.w * Math.exp(-(dx * dx + dy * dy) / (2 * c.r * c.r));
      }
      core = clamp(core, 0, 1.4);

      // --- ionisation rim: bright where the cloud thins out -----------------
      const rim = smoothstep(0.34, 0.54, d) * (1 - smoothstep(0.54, 0.78, d));

      // --- reflection region (blue) ----------------------------------------
      const rdx = u - reflC.x;
      const rdy = v - reflC.y;
      const reflEnv = Math.exp(-(rdx * rdx + rdy * rdy) / (2 * reflC.r * reflC.r));
      const reflTex = 0.35 + 0.90 * (fbm(nz2, u * 9.0 + 13.7, v * 9.0 + 71.3, 3) * 0.5 + 0.5);
      const refl = reflEnv * reflTex * (0.30 + 0.70 * d) * smoothstep(0.30, 0.80, reflEnv + 0.20 * d) * 0.85;

      // --- emission-line weights -------------------------------------------
      let ha = Math.pow(cloud, 1.70) * (0.30 + 2.80 * core);
      ha += 0.55 * rim * Math.pow(cloud, 0.95) * (0.35 + 0.65 * env);
      ha *= 1 - 0.55 * dust * smoothstep(0.02, 0.20, cloud);
      // OIII is a fringe/high-excitation tracer, not a bulk emitter
      const oiii =
        Math.pow(cloud, 1.15) * (0.22 + 0.95 * fil) * Math.pow(1 - cloud, 2.0) * (0.30 + 0.70 * env) * 0.70;
      const sii = Math.pow(cloud, 2.20) * (0.30 + 0.90 * core) * 0.40;
      const reflI = refl * 0.60;

      const rr = (ha * 1.0 + oiii * 0.10 + sii * 1.0 + reflI * 0.30) * gain;
      const gg = (ha * 0.20 + oiii * 0.80 + sii * 0.30 + reflI * 0.46) * gain;
      const bb = (ha * 0.33 + oiii * 0.72 + sii * 0.08 + reflI * 1.0) * gain;

      const i = (py * W + px) * 3;
      lin[i] = rr;
      lin[i + 1] = gg;
      lin[i + 2] = bb;
    }
  }

  // --- stars ---------------------------------------------------------------
  const zeroPoint = opts.zeroPoint ?? 13.55;
  const resolved = makeStars(rand, W, H, {
    count: opts.starCount ?? 1250,
    magBright: 6.3,
    magFaint: 16.6,
    colorBoost: 1.0,
    spikeCount: 3,
  });
  // a small embedded cluster that lights up the nebula
  for (let i = 0; i < 14; i++) {
    const a = rand() * TAU;
    const r = Math.pow(rand(), 0.6) * 0.075;
    resolved.push({
      x: (0.435 + Math.cos(a) * r) * W,
      y: (0.300 + Math.sin(a) * r * 1.4) * H * (H / H) * (W / W) + 0,
      mag: range(rand, 8.4, 12.6),
      fwhm: range(rand, 1.9, 2.6),
      elong: 1 + rand() * 0.08,
      angle: 0.4 + range(rand, -0.3, 0.3),
      color: sampleStarColor(rand, 1.05),
      spikes: false,
    });
  }
  const faint = makeFaintStars(rand, W, H, opts.faintCount ?? 9000, 16.6, 22.0);
  drawStars(lin, W, H, faint, { zeroPoint, saturate: 6.0 });
  drawStars(lin, W, H, resolved, { zeroPoint, saturate: 6.0 });

  return { lin, meta: { resolved: resolved.length, faint: faint.length } };
}

// ---------------------------------------------------------------------------
// scene: inclined spiral galaxy
// ---------------------------------------------------------------------------

function buildGalaxyScene(seed, W, H) {
  const rand = mulberry32(seed * 2654435761 + 17);
  const nz = makeNoise2D(mulberry32(seed * 40503 + 5));
  const nz2 = makeNoise2D(mulberry32(seed * 122949829 + 9));
  const lin = new Float32Array(W * H * 3);
  const U = 1 / W;

  const cx = 0.50;
  const cy = 0.505;
  const pa = 0.42; // position angle (rad)
  const inc = 0.95; // inclination (rad) — 0 = face on, pi/2 = edge on (~54 deg)
  const cosI = Math.max(Math.cos(inc), 0.12);
  const reB = 0.044; // bulge effective radius (long-edge units)
  const hDisk = 0.150; // disk scale length
  const armK = 0.52; // log-spiral pitch: theta = armK*ln(r)
  const armSigma = 0.30; // arm width (rad) — tight enough that the 2 arms stay separate

  const cpa = Math.cos(pa);
  const spa = Math.sin(pa);
  const diskMax = 0.44;
  const GAIN = 0.165;

  for (let py = 0; py < H; py++) {
    const v = (py + 0.5) * U;
    for (let px = 0; px < W; px++) {
      const u = (px + 0.5) * U;
      const dx = u - cx;
      const dy = v - cy;
      const su = dx * cpa + dy * spa; // along major axis (observed frame)
      const svObs = -dx * spa + dy * cpa; // perpendicular, observed frame
      const sv = svObs / cosI; // de-projected
      const r = Math.hypot(su, sv);
      const theta = Math.atan2(sv, su);
      const rObs = Math.hypot(su, svObs); // radius as seen on screen

      // --- spheroidal bulge (Sersic n=4), slightly flattened ---------------
      const rb = Math.hypot(su, svObs / 0.88);
      const bulge = Math.exp(-7.67 * (Math.pow(Math.max(rb, 1e-4) / reB, 0.25) - 1));

      // --- exponential disk (smooth base) ----------------------------------
      const mott = 0.72 + 0.56 * (fbm(nz, u * 16 + 3.1, v * 16 + 8.7, 3) * 0.5 + 0.5);
      const disk = Math.exp(-r / hDisk) * mott;

      // --- two log-spiral arms (strong contrast over the disk) -------------
      const lnr = Math.log(Math.max(r, 0.025));
      let dphi = 2 * (theta - armK * lnr);
      dphi = (((dphi + Math.PI) % TAU) + TAU) % TAU - Math.PI;
      const armW = armSigma * (0.50 + 0.85 * smoothstep(0.015, 0.26, r));
      const armMask = Math.exp(-(dphi * dphi) / (2 * armW * armW));
      const armTex = 0.45 + 0.95 * (fbm(nz, u * 26 + 41, v * 26 + 13, 4) * 0.5 + 0.5);
      const armClumps = 0.55 + 0.80 * (fbm(nz2, u * 40 + 7, v * 40 + 63, 3) * 0.5 + 0.5);
      const armEnv = Math.exp(-r / (hDisk * 1.75)) * smoothstep(0.02, 0.10, r);
      const arm = armMask * armEnv * armTex * armClumps;

      // --- dust lanes on the inner (concave) edge of each arm --------------
      let dphiD = 2 * (theta - armK * lnr) + 0.85;
      dphiD = (((dphiD + Math.PI) % TAU) + TAU) % TAU - Math.PI;
      const dustBand = Math.exp(-(dphiD * dphiD) / (2 * 0.34 * 0.34));
      const dustTex = fbm(nz2, u * 30 + 77, v * 30 + 5, 4) * 0.5 + 0.5;
      const dust = clamp(
        dustBand * (0.30 + 1.05 * dustTex) * smoothstep(0.035, 0.15, r) * (1 - smoothstep(0.36, 0.48, r)),
        0,
        1
      );

      // --- colours ----------------------------------------------------------
      const bulgeI = Math.pow(bulge, 1.0) * 1.30;
      const diskI = disk * 0.21;
      const armI = arm * 1.45;
      const haloI = Math.exp(-r / 0.26) * 0.020;
      // unresolved nucleus
      const nucI = Math.exp(-(rObs * rObs) / (2 * 0.0055 * 0.0055)) * 1.9;

      let rr = bulgeI * 1.00 + diskI * 0.84 + armI * 0.74 + haloI * 0.95 + nucI * 1.00;
      let gg = bulgeI * 0.84 + diskI * 0.88 + armI * 0.82 + haloI * 0.88 + nucI * 0.86;
      let bb = bulgeI * 0.60 + diskI * 0.99 + armI * 1.00 + haloI * 0.90 + nucI * 0.66;

      // dust dims and reddens the light behind it
      const dim = 1 - 0.88 * dust;
      rr *= dim;
      gg *= dim * (1 - 0.12 * dust);
      bb *= dim * (1 - 0.30 * dust);

      const i = (py * W + px) * 3;
      lin[i] = rr * GAIN;
      lin[i + 1] = gg * GAIN;
      lin[i + 2] = bb * GAIN;
    }
  }

  // --- HII knots along the arms -------------------------------------------
  for (let k = 0; k < 110; k++) {
    const rr = Math.pow(rand(), 0.75) * diskMax * 0.92 + 0.03;
    const armPick = rand() < 0.5 ? 0 : Math.PI;
    const th = armK * Math.log(Math.max(rr, 0.02)) + armPick + (rand() - 0.5) * 0.55;
    const su = Math.cos(th) * rr;
    const sv = Math.sin(th) * rr * cosI;
    const x = cx + su * cpa - sv * spa;
    const y = cy + su * spa + sv * cpa;
    if (x < 0.02 || x > 0.98 || y < 0.02 || y > 0.98) continue;
    const rad = range(rand, 0.004, 0.011);
    const bright = range(rand, 0.25, 1.0) * Math.exp(-rr / 0.28);
    const px = x * W;
    const py = y * H;
    const R = Math.ceil(rad * W * 3.2);
    for (let qy = Math.max(0, Math.floor(py - R)); qy <= Math.min(H - 1, Math.ceil(py + R)); qy++) {
      for (let qx = Math.max(0, Math.floor(px - R)); qx <= Math.min(W - 1, Math.ceil(px + R)); qx++) {
        const ddx = qx + 0.5 - px;
        const ddy = qy + 0.5 - py;
        const e = Math.exp(-(ddx * ddx + ddy * ddy) / (2 * (rad * W) * (rad * W) * 0.35));
        const i = (qy * W + qx) * 3;
        lin[i] += e * bright * 0.105;
        lin[i + 1] += e * bright * 0.022;
        lin[i + 2] += e * bright * 0.038;
      }
    }
  }

  // --- stars ---------------------------------------------------------------
  const zeroPoint = 13.9;
  const field = makeStars(rand, W, H, {
    count: 2300,
    magBright: 7.0,
    magFaint: 17.4,
    fwhmMin: 1.55,
    fwhmMax: 2.35,
    spikeMag: 6.6,
    spikeCount: 2,
    elongMax: 1.12,
  });
  const faint = makeFaintStars(rand, W, H, 11000, 17.4, 22.5, 1.25);
  drawStars(lin, W, H, faint, { zeroPoint, saturate: 6.0 });
  drawStars(lin, W, H, field, { zeroPoint, saturate: 6.0 });

  return { lin, meta: { resolved: field.length, faint: faint.length } };
}

// ---------------------------------------------------------------------------
// scene: globular cluster
// ---------------------------------------------------------------------------

function buildClusterScene(seed, W, H) {
  const rand = mulberry32(seed * 2246822519 + 23);
  const lin = new Float32Array(W * H * 3);
  const U = 1 / W;
  const cx = 0.50;
  const cy = 0.50;
  const rc = 0.032; // core radius
  const rt = 0.36; // tidal radius

  // King profile: p(r) ∝ r * (1/sqrt(1+(r/rc)^2) - 1/sqrt(1+(rt/rc)^2))^2
  const k = 1 / Math.sqrt(1 + (rt / rc) * (rt / rc));
  const kingPdf = (r) => {
    const t = 1 / Math.sqrt(1 + (r / rc) * (r / rc)) - k;
    return r * t * t;
  };
  let pmax = 0;
  for (let i = 0; i <= 400; i++) pmax = Math.max(pmax, kingPdf((i / 400) * rt));

  const sampleKing = () => {
    for (let guard = 0; guard < 200; guard++) {
      const r = rt * Math.sqrt(rand());
      if (rand() * pmax < kingPdf(r)) return r;
    }
    return rt * 0.5;
  };

  const stars = [];
  // unresolved core glow (thousands of stars below the noise floor)
  const coreGlow = 26000;
  for (let i = 0; i < coreGlow; i++) {
    const r = Math.pow(rand(), 2.6) * 0.075;
    const a = rand() * TAU;
    stars.push({
      x: (cx + Math.cos(a) * r * 1.06) * W,
      y: (cy + Math.sin(a) * r * 0.97) * H,
      mag: range(rand, 16.6, 20.8),
      fwhm: range(rand, 1.25, 1.8),
      elong: 1 + rand() * 0.08,
      angle: 0.3 + range(rand, -0.3, 0.3),
      color: sampleStarColor(rand, 1.0),
      spikes: false,
    });
  }
  // resolved members
  const members = 1150;
  for (let i = 0; i < members; i++) {
    const r = sampleKing();
    const a = rand() * TAU;
    stars.push({
      x: (cx + Math.cos(a) * r * 1.06) * W,
      y: (cy + Math.sin(a) * r * 0.97) * H,
      mag: range(rand, 11.5, 17.5) + Math.pow(rand(), 3) * -2.2,
      fwhm: range(rand, 1.8, 2.6),
      elong: 1 + rand() * 0.1,
      angle: 0.3 + range(rand, -0.3, 0.3),
      color: sampleStarColor(rand, 0.92),
      spikes: false,
    });
  }
  // a few bright giants
  for (let i = 0; i < 9; i++) {
    const r = sampleKing() * 1.05;
    const a = rand() * TAU;
    stars.push({
      x: (cx + Math.cos(a) * r * 1.06) * W,
      y: (cy + Math.sin(a) * r * 0.97) * H,
      mag: range(rand, 7.4, 9.6),
      fwhm: range(rand, 2.2, 2.9),
      elong: 1 + rand() * 0.07,
      angle: 0.3 + range(rand, -0.25, 0.25),
      color: sampleStarColor(rand, 0.85),
      spikes: true,
    });
  }
  // field stars (a globular sits in a sparse field)
  const field = makeStars(rand, W, H, {
    count: 260,
    magBright: 7.6,
    magFaint: 16.0,
    spikeMag: 8.2,
    spikeCount: 1,
    elongMax: 1.12,
  });
  for (const s of field) stars.push(s);

  drawStars(lin, W, H, stars, { zeroPoint: 13.6, saturate: 6.0 });
  return { lin, meta: { resolved: members + 9 + field.length, faint: coreGlow } };
}

// ---------------------------------------------------------------------------
// optics / atmosphere / sensor
// ---------------------------------------------------------------------------

/** cos^4-ish falloff from the frame centre. */
function applyVignette(lin, W, H, strength) {
  const cxp = (W - 1) / 2;
  const cyp = (H - 1) / 2;
  const rmax = Math.hypot(cxp, cyp);
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const dx = (px - cxp) / rmax;
      const dy = (py - cyp) / rmax;
      const r2 = dx * dx + dy * dy;
      const f = 1 - strength * Math.pow(r2, 1.15) - strength * 0.18 * r2;
      const i = (py * W + px) * 3;
      lin[i] *= f;
      lin[i + 1] *= f;
      lin[i + 2] *= f;
    }
  }
}

/**
 * Light-pollution gradient (brighter toward `corner`) plus faint airglow.
 * Additive, in linear units.
 */
function addLightPollution(lin, W, H, opts) {
  const { amp, corner = 'bl', color = [1.0, 0.84, 0.66], seed = 1, airglow = 0.35 } = opts;
  const nz = makeNoise2D(mulberry32(seed * 6151 + 29));
  const cxc = corner.includes('l') ? 0 : 1;
  const cyc = corner.includes('t') ? 0 : 1;
  const [lr, lg, lb] = color;
  for (let py = 0; py < H; py++) {
    const v = (py + 0.5) / H;
    for (let px = 0; px < W; px++) {
      const u = (px + 0.5) / W;
      const du = u - cxc;
      const dv = v - cyc;
      const d = Math.min(1, Math.hypot(du * 1.06, dv) / 1.42);
      const glow = Math.pow(1 - d, 2.3);
      const cloud = fbm(nz, u * 2.6, v * 2.6, 3) * 0.5 + 0.5;
      const lp = amp * glow * (0.62 + 0.55 * cloud);
      const ag = amp * airglow * (0.30 + 0.70 * (fbm(nz, u * 1.7 + 5.5, v * 1.7 + 9.1, 2) * 0.5 + 0.5));
      const i = (py * W + px) * 3;
      lin[i] += lp * lr + ag * 0.42;
      lin[i + 1] += lp * lg + ag * 0.78;
      lin[i + 2] += lp * lb + ag * 0.50;
    }
  }
}

/**
 * asinh stretch anchored to the measured sky pedestal:
 *   curve(skyLin) === skyTarget   and   curve(whiteLin) === 1
 * so the sky always lands in the 8..25/255 band the star detector needs,
 * whatever the scene's absolute brightness happens to be.
 */
function makeToneCurve({ softness, white, skyLin, skyTarget }) {
  const a = (x) => Math.asinh(Math.max(x, 0) / softness);
  const aWhite = a(white);
  const aSky = a(skyLin);
  const aBlack = (aSky - skyTarget * aWhite) / (1 - skyTarget);
  const span = aWhite - aBlack;
  return (x) => clamp((a(x) - aBlack) / span);
}

// ---------------------------------------------------------------------------
// finalisation: tone map -> colour -> noise -> 8-bit
// ---------------------------------------------------------------------------

/** Median-preserving percentile of the linear luminance (subsampled). */
function linearSkyLevel(lin, W, H) {
  const n = W * H;
  const step = Math.max(1, Math.floor(n / 120000));
  const lums = [];
  for (let i = 0; i < n; i += step) {
    const j = i * 3;
    lums.push(0.2126 * lin[j] + 0.7152 * lin[j + 1] + 0.0722 * lin[j + 2]);
  }
  lums.sort((x, y) => x - y);
  return { p: (q) => percentile(lums, q), n: lums.length };
}

function finish(lin, W, H, cfg) {
  const {
    stretch = {}, vignette = 0.16, lp, saturation = 1.16, contrast = 1.0,
    readNoise = 0.006, shotNoise = 0.020, banding = 0.0016,
    hotPixels = 14, seed = 1, highlightDesat = 0.30,
  } = cfg;
  const {
    softnessRatio = 0.055, skyTarget = 0.055, whitePct = 0.999,
    whiteMul = 1.25, minWhiteOverSky = 7,
  } = stretch;

  if (lp) addLightPollution(lin, W, H, { ...lp, seed });
  if (vignette) applyVignette(lin, W, H, vignette);

  // measure the actual pedestal and bright end, then anchor the curve
  const lum = linearSkyLevel(lin, W, H);
  const skyLin = Math.max(lum.p(0.15), 1e-7);
  const whiteLin = Math.max(lum.p(whitePct) * whiteMul, skyLin * minWhiteOverSky);
  const softness = Math.max(whiteLin * softnessRatio, 1e-8);
  const curve = makeToneCurve({ softness, white: whiteLin, skyLin, skyTarget });

  const out = new Uint8Array(W * H * 3);
  const rand = mulberry32(seed * 1000003 + 41);
  const gauss = makeGaussian(rand);

  // per-row read-noise banding (cheap sensor realism)
  const rows = new Float32Array(H);
  for (let y = 0; y < H; y++) rows[y] = gauss() * banding;

  for (let py = 0; py < H; py++) {
    const rowBias = rows[py];
    for (let px = 0; px < W; px++) {
      const i = (py * W + px) * 3;
      let r = curve(lin[i]);
      let g = curve(lin[i + 1]);
      let b = curve(lin[i + 2]);

      // contrast about the sky pedestal
      if (contrast !== 1) {
        r = clamp(skyTarget + (r - skyTarget) * contrast);
        g = clamp(skyTarget + (g - skyTarget) * contrast);
        b = clamp(skyTarget + (b - skyTarget) * contrast);
      }

      // saturation
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      r = clamp(lum + (r - lum) * saturation);
      g = clamp(lum + (g - lum) * saturation);
      b = clamp(lum + (b - lum) * saturation);

      // highlight rolloff (sensors desaturate near full well)
      const hl = smoothstep(0.55, 1.0, lum) * highlightDesat;
      r = lerp(r, lum, hl);
      g = lerp(g, lum, hl);
      b = lerp(b, lum, hl);

      // shot + read noise
      const nL = gauss() * readNoise;
      r += nL + gauss() * shotNoise * Math.sqrt(Math.max(r, 0.002)) + rowBias;
      g += nL + gauss() * shotNoise * Math.sqrt(Math.max(g, 0.002)) + rowBias;
      b += nL + gauss() * shotNoise * Math.sqrt(Math.max(b, 0.002)) + rowBias;

      out[i] = Math.round(clamp(r) * 255);
      out[i + 1] = Math.round(clamp(g) * 255);
      out[i + 2] = Math.round(clamp(b) * 255);
    }
  }

  // hot / warm pixels + a couple of cosmic-ray hits
  for (let k = 0; k < hotPixels; k++) {
    const x = Math.floor(rand() * W);
    const y = Math.floor(rand() * H);
    const i = (y * W + x) * 3;
    const ch = rand();
    const val = range(rand, 0.42, 1.0);
    if (ch < 0.45) out[i] = Math.round(val * 255);
    else if (ch < 0.72) out[i + 2] = Math.round(val * 255);
    else if (ch < 0.9) out[i + 1] = Math.round(val * 0.9 * 255);
    else {
      out[i] = out[i + 1] = out[i + 2] = Math.round(val * 255);
    }
    if (rand() < 0.4) {
      const j = (y * W + Math.min(W - 1, x + 1)) * 3;
      out[j] = Math.min(255, out[j] + Math.round(val * 0.4 * 255));
    }
  }
  for (let k = 0; k < 2; k++) {
    const x = 2 + Math.floor(rand() * (W - 6));
    const y = 2 + Math.floor(rand() * (H - 6));
    const len = 2 + Math.floor(rand() * 3);
    const v = range(rand, 0.5, 0.95) * 255;
    for (let t = 0; t < len; t++) {
      const i = (y * W + Math.min(W - 1, x + t)) * 3;
      out[i] = out[i + 1] = out[i + 2] = Math.round(v);
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// FITS writer (16-bit, BZERO=32768)
// ---------------------------------------------------------------------------

function fitsCard(key, value, comment) {
  let s;
  if (typeof value === 'string') {
    s = `${key.padEnd(8)}= ${`'${value}'`.padEnd(20)}`;
  } else if (typeof value === 'boolean') {
    s = `${key.padEnd(8)}= ${(value ? 'T' : 'F').padStart(20)}`;
  } else {
    s = `${key.padEnd(8)}= ${String(value).padStart(20)}`;
  }
  if (comment) s += ` / ${comment}`;
  if (s.length > 80) s = s.slice(0, 80);
  return Buffer.from(s.padEnd(80, ' '), 'ascii');
}

/**
 * Write a real FITS file: 2880-byte header blocks, big-endian 16-bit data with
 * BZERO=32768 so the stored signed integers map to 0..65535 physical counts.
 * `cards` are [keyword, value, comment]; `value === null` means a keyword-only
 * card (HISTORY / COMMENT / END).
 */
function writeFits({ width, height, pixels, cards }) {
  const header = Buffer.concat(
    cards.map(([k, v, c]) => {
      if (v === null || k === 'END') {
        let s = k === 'END' ? 'END' : `${k.padEnd(8)}${c ? ` ${c}` : ''}`;
        if (s.length > 80) s = s.slice(0, 80);
        return Buffer.from(s.padEnd(80, ' '), 'ascii');
      }
      return fitsCard(k, v, c);
    })
  );
  const headerPadded = Buffer.alloc((Math.ceil(header.length / 2880) || 1) * 2880, 0x20);
  header.copy(headerPadded);

  const dataBytes = width * height * 2;
  const data = Buffer.alloc(Math.ceil(dataBytes / 2880) * 2880, 0); // zero padding is valid FITS
  for (let i = 0; i < pixels.length; i++) data.writeUInt16BE(pixels[i], i * 2);

  return Buffer.concat([headerPadded, data]);
}

// ---------------------------------------------------------------------------
// stats helpers (reporting only — never affects pixels)
// ---------------------------------------------------------------------------

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = clamp(p, 0, 1) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function imageStats(rgb, W, H) {
  const step = Math.max(3, Math.floor((W * H) / 200000) * 3);
  const lums = [];
  let min = 255;
  let max = 0;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < W * H * 3; i += step) {
    const r = rgb[i];
    const g = rgb[i + 1];
    const b = rgb[i + 2];
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    lums.push(l);
    if (l < min) min = l;
    if (l > max) max = l;
    sum += l;
    n++;
  }
  lums.sort((a, b) => a - b);
  return {
    min: +min.toFixed(1),
    median: +percentile(lums, 0.5).toFixed(2),
    mean: +(sum / n).toFixed(2),
    p1: +percentile(lums, 0.01).toFixed(1),
    p99: +percentile(lums, 0.99).toFixed(1),
    p999: +percentile(lums, 0.999).toFixed(1),
    max: +max.toFixed(1),
  };
}

// ---------------------------------------------------------------------------
// PNG / FITS emission
// ---------------------------------------------------------------------------

async function writePng(rgb, W, H, file) {
  const buf = await sharp(Buffer.from(rgb.buffer, rgb.byteOffset, rgb.length), {
    raw: { width: W, height: H, channels: 3 },
  })
    .png({ compressionLevel: 9, adaptiveFiltering: true, effort: 7 })
    .toBuffer();
  await writeFile(file, buf);
  return buf.length;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { seed: 1337, out: 'samples' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--seed' || a === '-s') {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v)) throw new Error(`--seed needs a number, got ${argv[i]}`);
      out.seed = Math.trunc(v);
    } else if (a === '--out' || a === '-o') {
      const v = argv[++i];
      if (!v) throw new Error('--out needs a path');
      out.out = v;
    } else if (a === '--help' || a === '-h') {
      out.help = true;
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return out;
}

const USAGE = `deepsky-motion sample generator

  node tools/make-samples.mjs [--seed 1337] [--out samples]

  --seed N   master seed for every PRNG (default 1337)
  --out DIR  output directory (default samples/)
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE);
    return;
  }
  const seed = args.seed;
  const outDir = path.resolve(process.cwd(), args.out);
  await mkdir(outDir, { recursive: true });
  const written = [];
  const t0 = Date.now();

  // ---- 1. nebula 1600x1067 -------------------------------------------------
  {
    const W = 1600;
    const H = 1067;
    const { lin, meta } = buildNebulaScene(seed, W, H);
    const rgb = finish(lin, W, H, {
      stretch: { softnessRatio: 0.052, skyTarget: 0.052, whitePct: 0.9992, whiteMul: 1.15 },
      vignette: 0.15,
      lp: { amp: 0.0026, corner: 'bl', color: [1.0, 0.83, 0.64], airglow: 0.30 },
      saturation: 1.18,
      contrast: 1.02,
      readNoise: 0.0062,
      shotNoise: 0.020,
      banding: 0.0016,
      hotPixels: 16,
      seed: seed + 1,
    });
    const bytes = await writePng(rgb, W, H, path.join(outDir, 'nebula-1600.png'));
    written.push({ file: 'nebula-1600.png', w: W, h: H, bytes, stats: imageStats(rgb, W, H), meta });
  }

  // ---- 2. galaxy 1400x1400 -------------------------------------------------
  {
    const W = 1400;
    const H = 1400;
    const { lin, meta } = buildGalaxyScene(seed, W, H);
    const rgb = finish(lin, W, H, {
      stretch: { softnessRatio: 0.060, skyTarget: 0.040, whitePct: 0.9995, whiteMul: 1.10 },
      vignette: 0.20,
      lp: { amp: 0.0016, corner: 'tr', color: [1.0, 0.86, 0.70], airglow: 0.26 },
      saturation: 1.20,
      contrast: 1.04,
      readNoise: 0.0058,
      shotNoise: 0.019,
      banding: 0.0014,
      hotPixels: 13,
      seed: seed + 2,
    });
    const bytes = await writePng(rgb, W, H, path.join(outDir, 'galaxy-1400.png'));
    written.push({ file: 'galaxy-1400.png', w: W, h: H, bytes, stats: imageStats(rgb, W, H), meta });
  }

  // ---- 3. cluster 1200x900 -------------------------------------------------
  {
    const W = 1200;
    const H = 900;
    const { lin, meta } = buildClusterScene(seed, W, H);
    const rgb = finish(lin, W, H, {
      stretch: { softnessRatio: 0.050, skyTarget: 0.038, whitePct: 0.9995, whiteMul: 1.10 },
      vignette: 0.13,
      lp: { amp: 0.0011, corner: 'tr', color: [1.0, 0.88, 0.74], airglow: 0.22 },
      saturation: 1.12,
      contrast: 1.03,
      readNoise: 0.0042,
      shotNoise: 0.014,
      banding: 0.0010,
      hotPixels: 9,
      seed: seed + 3,
    });
    const bytes = await writePng(rgb, W, H, path.join(outDir, 'cluster-1200.png'));
    written.push({ file: 'cluster-1200.png', w: W, h: H, bytes, stats: imageStats(rgb, W, H), meta });
  }

  // ---- 4. nebula FITS 1024x683 (linear, 16-bit) ----------------------------
  let fitsInfo = null;
  {
    const W = 1024;
    const H = 683;
    const { lin, meta } = buildNebulaScene(seed, W, H);
    // linear scene + a little photon noise; no stretch, no display curve
    const rand = mulberry32(seed * 700001 + 53);
    const gauss = makeGaussian(rand);
    addLightPollution(lin, W, H, {
      amp: 0.0026,
      corner: 'bl',
      color: [1.0, 0.83, 0.64],
      airglow: 0.30,
      seed: seed + 1,
    });
    applyVignette(lin, W, H, 0.15);
    const n = W * H;
    for (let i = 0; i < n; i++) {
      const j = i * 3;
      const r = lin[j];
      const g = lin[j + 1];
      const b = lin[j + 2];
      lin[j] = Math.max(0, r + gauss() * 0.00035 + gauss() * Math.sqrt(Math.max(r, 1e-6)) * 0.0035);
      lin[j + 1] = Math.max(0, g + gauss() * 0.00035 + gauss() * Math.sqrt(Math.max(g, 1e-6)) * 0.0035);
      lin[j + 2] = Math.max(0, b + gauss() * 0.00035 + gauss() * Math.sqrt(Math.max(b, 1e-6)) * 0.0035);
    }
    // scale so the sky sits near 350 counts and bright cores approach full well
    const sample = [];
    for (let i = 0; i < n; i += 7) sample.push(0.2126 * lin[i * 3] + 0.7152 * lin[i * 3 + 1] + 0.0722 * lin[i * 3 + 2]);
    sample.sort((a, b) => a - b);
    const p999 = percentile(sample, 0.999);
    const p50 = percentile(sample, 0.5);
    const scale = 58000 / Math.max(p999, 1e-6);

    // luminance is stored as a mono FITS (single-channel), which is what a
    // one-shot colour camera / mono sensor with an Ha filter actually gives.
    const pixels = new Uint16Array(n);
    let dmin = 65535;
    let dmax = 0;
    let dsum = 0;
    for (let i = 0; i < n; i++) {
      const j = i * 3;
      const l = 0.2126 * lin[j] + 0.7152 * lin[j + 1] + 0.0722 * lin[j + 2];
      const v = Math.max(0, Math.min(65535, Math.round(l * scale)));
      pixels[i] = v;
      if (v < dmin) dmin = v;
      if (v > dmax) dmax = v;
      dsum += v;
    }

    const cards = [
      ['SIMPLE', true, 'file does conform to FITS standard'],
      ['BITPIX', 16, 'number of bits per data pixel'],
      ['NAXIS', 2, 'number of data axes'],
      ['NAXIS1', W, 'length of data axis 1'],
      ['NAXIS2', H, 'length of data axis 2'],
      ['BZERO', 32768, 'offset data range to that of unsigned short'],
      ['BSCALE', 1, 'default scaling factor'],
      ['OBJECT', 'NGC 7000 SYNTHETIC', 'target name'],
      ['TELESCOP', 'deepsky-motion-sim', 'simulated 130/650 APO + 0.8x flattener'],
      ['INSTRUME', 'ASI2600MM-SIM', 'monochrome CMOS, -10C'],
      ['FILTER', 'Ha 7nm', 'narrowband'],
      ['EXPTIME', 1800, 'total integration time in seconds'],
      ['DATE-OBS', '2025-08-14T22:41:07', 'UTC start of integration'],
      ['CRPIX1', W / 2, 'reference pixel x'],
      ['CRPIX2', H / 2, 'reference pixel y'],
      ['CRVAL1', 314.7512, 'RA at reference pixel (deg)'],
      ['CRVAL2', 44.3286, 'Dec at reference pixel (deg)'],
      ['CDELT1', -0.001389, 'deg per pixel (RA)'],
      ['CDELT2', 0.001389, 'deg per pixel (Dec)'],
      ['CTYPE1', 'RA---TAN', 'gnomonic projection'],
      ['CTYPE2', 'DEC--TAN', 'gnomonic projection'],
      ['RADESYS', 'ICRS', 'coordinate reference frame'],
      ['HISTORY', null, 'Synthetic sample generated by tools/make-samples.mjs'],
      ['HISTORY', null, `seed=${seed}; linear data, needs a stretch before display`],
      ['END', null, ''],
    ];
    const finalBuf = writeFits({ width: W, height: H, pixels, cards });
    await writeFile(path.join(outDir, 'nebula-1024.fits'), finalBuf);
    fitsInfo = {
      file: 'nebula-1024.fits',
      w: W,
      h: H,
      bytes: finalBuf.length,
      dataMin: dmin,
      dataMax: dmax,
      dataMean: Math.round(dsum / n),
      skyCounts: Math.round(p50 * scale),
      meta,
    };
  }

  // ---- 5. README -----------------------------------------------------------
  const readme = `# deepsky-motion sample images

Generated by \`node tools/make-samples.mjs --seed ${seed}\`. Everything here is
synthetic and deterministic: re-running with the same seed produces byte-identical
files. Do not hand-edit; edit \`tools/make-samples.mjs\` instead.

## nebula-1600.png — 1600x1067, RGB

An Hα-dominant emission nebula (NGC 7000-like) with filament structure, a bright
core, dark dust lanes, teal OIII fringes, a small blue reflection region, and an
embedded cluster of ionising stars. ${written[0].meta.resolved} resolved stars
over a realistic magnitude distribution (a few bright ones with 4-point
diffraction spikes and soft halos), plus ~${written[0].meta.faint} unresolved
background stars, a warm light-pollution gradient from the lower-left corner,
vignetting, shot noise and hot pixels.
**What the app should show:** a rich, deep field with a big soft nebula; star
detection should find well over a thousand stars, mostly faint, and the parallax
dolly should push through a convincing star field while the nebula plate stays
put. Stars are drawn with a ~1.8-3.0 px FWHM Gaussian PSF; note that a real
detector measures a smaller value on this frame because the textured nebula
background biases the second-moment estimate low.

## galaxy-1400.png — 1400x1400, RGB

An inclined (about 54°) spiral galaxy: warm de Vaucouleurs bulge, exponential
disk, two log-spiral arms with dust lanes on their inner edges, pink HII knots
along the arms, a faint halo, and a dense field of small stars on a darker sky.
**What the app should show:** the galaxy as the foreground "plate" with the disk
tilt giving an obvious depth cue; star detection finds a dense, faint-dominated
field; good for testing that depth assignment does not flatten the galaxy.

## cluster-1200.png — 1200x900, RGB

A globular cluster with a King-profile radial density (core radius ~38 px,
tidal radius ~430 px), an unresolved glowing core, a handful of bright giants,
and a sparse field. Low noise, no nebula.
**What the app should show:** a concentrated swarm of stars with an obvious
centre; the detector should report high density and a tight magnitude
distribution — a good stress test for star-vs-star blending.

## nebula-1024.fits — 1024x683, 16-bit mono FITS

The same nebula scene as a real FITS file: \`SIMPLE=T\`, \`BITPIX=16\`, \`NAXIS=2\`,
\`NAXIS1=1024\`, \`NAXIS2=683\`, \`BZERO=32768\`, \`BSCALE=1\`, plus \`OBJECT\`,
\`TELESCOP\`, \`INSTRUME\`, \`FILTER\`, \`EXPTIME\`, \`DATE-OBS\` and a TAN WCS.
Header is padded to 2880-byte blocks and the big-endian data is padded to a
2880-byte boundary. **The data is linear** (sky ≈ ${fitsInfo.skyCounts} counts,
nebula core ≈ ${fitsInfo.dataMax} counts): it looks almost black until the app
applies its auto-stretch, which is exactly the path \`imageio.mjs\` is supposed to
take for a dark image. It is mono luminance, i.e. what a mono sensor with an Hα
filter records.
`;

  await writeFile(path.join(outDir, 'README.md'), readme, 'utf8');

  // ---- report --------------------------------------------------------------
  const lines = [];
  for (const w of written) {
    lines.push(
      `  ${w.file.padEnd(18)} ${String(w.w).padStart(5)}x${String(w.h).padEnd(5)} ` +
        `${String(Math.round(w.bytes / 1024)).padStart(5)} KiB  ` +
        `sky(median lum)=${w.stats.median}/255 p99=${w.stats.p99} p99.9=${w.stats.p999} max=${w.stats.max}`
    );
  }
  lines.push(
    `  ${fitsInfo.file.padEnd(18)} ${String(fitsInfo.w).padStart(5)}x${String(fitsInfo.h).padEnd(5)} ` +
      `${String(Math.round(fitsInfo.bytes / 1024)).padStart(5)} KiB  ` +
      `data ${fitsInfo.dataMin}..${fitsInfo.dataMax} (mean ${fitsInfo.dataMean}, sky ${fitsInfo.skyCounts})`
  );
  process.stdout.write(
    `deepsky-motion samples (seed ${seed}) -> ${outDir}\n${lines.join('\n')}\n` +
      `  README.md\n  done in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`
  );
}

main().catch((err) => {
  process.stderr.write(`make-samples: ${err && err.stack ? err.stack : err}\n`);
  process.exitCode = 1;
});
