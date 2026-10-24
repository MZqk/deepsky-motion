// Unit tests for the analysis + render core.
// Run: node --test test/

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  mulberry32,
  clamp,
  luminance,
  backgroundModel,
  detectStars,
  estimatePsf,
  assignDepth,
  applyDepth,
  buildStarless,
  analyzeSync,
  depthHistogram,
  recommendStarParams,
} from '../server/lib/astro.mjs';

import {
  createRenderer,
  outputSize,
  cameraAt,
  depthFactor,
  zoomAt,
  renderFrame,
} from '../server/lib/render.mjs';

import { DEFAULT_PARAMS } from '../server/config.mjs';

// ---------------------------------------------------------------------------
// Synthetic star field used across the tests.
// ---------------------------------------------------------------------------

function makeStarRaster({ width = 200, height = 150, stars = null, sky = 0.02, noise = 0.004, seed = 7 } = {}) {
  const rnd = mulberry32(seed);
  const list = stars || defaultStars(rnd, width, height);
  const data = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let v = sky + (rnd() - 0.5) * noise;
      for (const s of list) {
        const dx = x - s.x;
        const dy = y - s.y;
        const r2 = dx * dx + dy * dy;
        if (r2 < 400) v += s.a * Math.exp(-r2 / (2 * s.sigma * s.sigma));
      }
      const c = clamp(v, 0, 1);
      const p = (y * width + x) * 3;
      data[p] = c;
      data[p + 1] = c;
      data[p + 2] = c;
    }
  }
  return {
    data,
    width,
    height,
    meta: { source: 'synthetic', isLinear: false, notes: [] },
  };
}

function defaultStars(rnd, width, height) {
  const out = [];
  for (let i = 0; i < 60; i++) {
    out.push({
      x: 8 + rnd() * (width - 16),
      y: 8 + rnd() * (height - 16),
      a: 0.15 + Math.pow(rnd(), 2) * 0.85,
      sigma: 1.1 + rnd() * 0.7,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Determinism + math helpers
// ---------------------------------------------------------------------------

test('mulberry32 is deterministic and in [0,1)', () => {
  const a = mulberry32(1337);
  const b = mulberry32(1337);
  const c = mulberry32(1338);
  const seqA = Array.from({ length: 50 }, () => a());
  const seqB = Array.from({ length: 50 }, () => b());
  assert.deepEqual(seqA, seqB, 'same seed must give the same sequence');
  assert.notDeepEqual(seqA, Array.from({ length: 50 }, () => c()), 'different seed must differ');
  for (const v of seqA) {
    assert.ok(v >= 0 && v < 1, `value ${v} out of range`);
  }
});

test('clamp bounds values', () => {
  assert.equal(clamp(5, 0, 1), 1);
  assert.equal(clamp(-5, 0, 1), 0);
  assert.equal(clamp(0.5, 0, 1), 0.5);
});

test('luminance follows Rec.709 and stays in range', () => {
  const raster = {
    data: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),
    width: 3,
    height: 1,
    meta: {},
  };
  const lum = luminance(raster);
  assert.equal(lum.length, 3);
  assert.ok(Math.abs(lum[0] - 0.2126) < 1e-6);
  assert.ok(Math.abs(lum[1] - 0.7152) < 1e-6);
  assert.ok(Math.abs(lum[2] - 0.0722) < 1e-6);
});

test('backgroundModel recovers a known sky level and noise', () => {
  const width = 256;
  const height = 256;
  const rnd = mulberry32(99);
  const data = new Float32Array(width * height);
  for (let i = 0; i < data.length; i++) data[i] = 0.25 + (rnd() - 0.5) * 0.02;
  const model = backgroundModel(data, width, height, { block: 32 });
  assert.equal(model.bg.length, width * height);
  // Median should land on the sky pedestal.
  assert.ok(Math.abs(model.median - 0.25) < 0.01, `median ${model.median}`);
  assert.ok(model.sigma > 0 && model.sigma < 0.02, `sigma ${model.sigma}`);
  for (let i = 0; i < model.bg.length; i += 997) {
    assert.ok(Math.abs(model.bg[i] - 0.25) < 0.02, `bg[${i}] = ${model.bg[i]}`);
  }
});

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

test('detectStars finds injected stars at the right positions', () => {
  const injected = [
    { x: 40.3, y: 30.7, a: 0.9, sigma: 1.4 },
    { x: 120.5, y: 60.2, a: 0.7, sigma: 1.6 },
    { x: 80.1, y: 110.9, a: 0.5, sigma: 1.3 },
  ];
  const raster = makeStarRaster({ stars: injected, noise: 0.002 });
  const stars = detectStars(raster);
  assert.ok(stars.length >= 3, `expected >= 3 stars, got ${stars.length}`);

  for (const want of injected) {
    let best = null;
    let bestD = Infinity;
    for (const s of stars) {
      const d = Math.hypot(s.x - want.x, s.y - want.y);
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    assert.ok(bestD < 1.5, `no detection within 1.5 px of (${want.x},${want.y}); closest ${bestD.toFixed(2)}`);
    assert.ok(best.flux > 0, 'flux must be positive');
  }
});

test('detectStars is deterministic', () => {
  const raster = makeStarRaster({ seed: 21 });
  const a = detectStars(raster);
  const b = detectStars(raster);
  assert.deepEqual(a, b);
});

test('detectStars returns stars sorted by descending flux', () => {
  const raster = makeStarRaster({ seed: 5 });
  const stars = detectStars(raster);
  assert.ok(stars.length > 5);
  for (let i = 1; i < stars.length; i++) {
    assert.ok(stars[i - 1].flux >= stars[i].flux, `flux not sorted at ${i}`);
  }
});

test('detectStars normalises fluxNorm and peak to 0..1 with max = 1', () => {
  const raster = makeStarRaster({ seed: 11 });
  const stars = detectStars(raster);
  assert.ok(stars.length > 0);
  assert.equal(stars[0].fluxNorm, 1);
  assert.equal(stars[0].peak, 1);
  for (const s of stars) {
    assert.ok(s.fluxNorm >= 0 && s.fluxNorm <= 1, `fluxNorm ${s.fluxNorm}`);
    assert.ok(s.peak >= 0 && s.peak <= 1, `peak ${s.peak}`);
    assert.ok(s.fwhm >= 0.9, `fwhm ${s.fwhm}`);
    assert.ok(s.ellipticity >= 0 && s.ellipticity <= 1, `ell ${s.ellipticity}`);
  }
});

test('detectStars assigns a positive halo radius to every star', () => {
  const raster = makeStarRaster({ seed: 13 });
  const stars = detectStars(raster);
  for (const s of stars) {
    assert.ok(s.haloR >= 3, `haloR ${s.haloR} too small`);
    assert.ok(Number.isFinite(s.haloR));
  }
  // The brightest star must get a larger halo than the faintest.
  assert.ok(stars[0].haloR >= stars[stars.length - 1].haloR);
});

test('detectStars rejects a pure-noise image', () => {
  const width = 128;
  const height = 128;
  const rnd = mulberry32(3);
  const data = new Float32Array(width * height * 3);
  for (let i = 0; i < data.length; i++) data[i] = 0.05 + rnd() * 0.01;
  const stars = detectStars({ data, width, height, meta: {} });
  assert.ok(stars.length < 12, `noise produced ${stars.length} spurious detections`);
});

test('estimatePsf reports sane aggregate metrics', () => {
  const raster = makeStarRaster({ seed: 17 });
  const stars = detectStars(raster);
  const psf = estimatePsf(stars, raster);
  assert.equal(psf.starCount, stars.length);
  assert.ok(psf.medianFwhm > 0.5 && psf.medianFwhm < 20, `medianFwhm ${psf.medianFwhm}`);
  assert.ok(psf.medianEllipticity >= 0 && psf.medianEllipticity <= 1);
  assert.ok(psf.density > 0);
});

test('estimatePsf handles an empty catalogue', () => {
  const psf = estimatePsf([], { width: 100, height: 100 });
  assert.equal(psf.starCount, 0);
  assert.equal(psf.medianFwhm, 0);
});

// ---------------------------------------------------------------------------
// Depth
// ---------------------------------------------------------------------------

test('assignDepth produces z in 0..1 and nearer stars are brighter', () => {
  const raster = makeStarRaster({ seed: 23 });
  const stars = detectStars(raster);
  const plan = assignDepth(stars, { depthSpread: 0.6, depthPower: 1.35, seed: 1337 });
  assert.ok(plan.zNebula > 0 && plan.zNebula < 1);
  assert.ok(plan.zStarsNear < plan.zStarsFar);

  const withZ = applyDepth(stars, plan, 1337);
  for (const s of withZ) {
    assert.ok(s.z >= 0 && s.z <= 1, `z ${s.z} out of range`);
    assert.ok(Number.isFinite(s.phase));
    assert.ok(s.twinkleRate > 0);
  }
  // Brightest star should sit nearer (lower z) than the faintest.
  const brightest = withZ[0];
  const faintest = withZ[withZ.length - 1];
  assert.ok(brightest.z <= faintest.z, `brightest z=${brightest.z} should be <= faintest z=${faintest.z}`);
});

test('assignDepth is deterministic for a fixed seed', () => {
  const raster = makeStarRaster({ seed: 29 });
  const stars = detectStars(raster);
  const a = applyDepth(stars, assignDepth(stars, { seed: 42 }), 42);
  const b = applyDepth(stars, assignDepth(stars, { seed: 42 }), 42);
  assert.deepEqual(a, b);
});

test('depthHistogram sums to the star count', () => {
  const stars = [{ z: 0.05 }, { z: 0.5 }, { z: 0.99 }];
  const hist = depthHistogram(stars, 12);
  assert.equal(hist.length, 12);
  assert.equal(
    hist.reduce((a, b) => a + b, 0),
    3
  );
});

// ---------------------------------------------------------------------------
// Starless plate
// ---------------------------------------------------------------------------

test('buildStarless removes bright cores and preserves the background', () => {
  const raster = makeStarRaster({ seed: 31, sky: 0.3 });
  const stars = detectStars(raster);
  assert.ok(stars.length > 3);
  const plate = buildStarless(raster, stars);
  assert.equal(plate.width, raster.width);
  assert.equal(plate.height, raster.height);
  assert.equal(plate.data.length, raster.width * raster.height * 4);
  assert.ok(plate.maskedPixels > 0, 'some pixels must be masked');

  // The brightest star's core must be much dimmer in the plate.
  const s = stars[0];
  const cx = Math.round(s.x);
  const cy = Math.round(s.y);
  const srcLum = raster.data[(cy * raster.width + cx) * 3];
  const plateLum = plate.data[(cy * raster.width + cx) * 4] / 255;
  assert.ok(plateLum < srcLum, `plate ${plateLum} should be < source ${srcLum}`);

  // Background far from any star must survive.
  let far = null;
  for (let y = 2; y < raster.height - 2 && !far; y += 7) {
    for (let x = 2; x < raster.width - 2; x += 7) {
      let near = false;
      for (const t of stars) {
        if ((t.x - x) ** 2 + (t.y - y) ** 2 < 900) {
          near = true;
          break;
        }
      }
      if (!near) {
        far = [x, y];
        break;
      }
    }
  }
  assert.ok(far, 'test needs a pixel far from any star');
  const srcFar = raster.data[(far[1] * raster.width + far[0]) * 3];
  const plateFar = plate.data[(far[1] * raster.width + far[0]) * 4] / 255;
  assert.ok(Math.abs(plateFar - srcFar) < 0.12, `background changed: ${srcFar} -> ${plateFar}`);
});

test('buildStarless returns the input unchanged when there are no stars', () => {
  const raster = makeStarRaster({ seed: 37 });
  const plate = buildStarless(raster, []);
  assert.equal(plate.maskedPixels, 0);
  assert.equal(plate.levels, 0);
  const i = 500 * 3;
  assert.equal(plate.data[500 * 4] / 255, Math.round(raster.data[i] * 255) / 255);
});

// ---------------------------------------------------------------------------
// Full analysis
// ---------------------------------------------------------------------------

test('analyzeSync produces a complete Scene', () => {
  const raster = makeStarRaster({ seed: 41 });
  const scene = analyzeSync(raster, { seed: 1337 });
  assert.equal(scene.width, raster.width);
  assert.equal(scene.height, raster.height);
  assert.ok(Array.isArray(scene.stars));
  assert.ok(scene.stars.length > 0);
  assert.ok(scene.psf.starCount === scene.stars.length);
  assert.ok(scene.starless.data.length === raster.width * raster.height * 4);
  assert.ok(scene.depth.zNebula >= 0 && scene.depth.zNebula <= 1);
  for (const s of scene.stars) {
    assert.ok(typeof s.z === 'number' && s.z >= 0 && s.z <= 1, 'every star must carry z');
    assert.ok(typeof s.phase === 'number', 'every star must carry phase');
  }
});

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

test('outputSize keeps the aspect ratio and returns even dimensions', () => {
  const scene = { width: 1600, height: 1067 };
  const { width, height } = outputSize(scene, { resolution: 1280 });
  assert.equal(width, 1280);
  assert.equal(width % 2, 0);
  assert.equal(height % 2, 0);
  assert.ok(Math.abs(width / height - 1600 / 1067) < 0.01);

  const portrait = outputSize({ width: 800, height: 1200 }, { resolution: 600 });
  assert.equal(portrait.height, 600);
  assert.equal(portrait.width % 2, 0);
});

test('depthFactor makes near planes move more than far planes', () => {
  const near = depthFactor(0, 1);
  const far = depthFactor(1, 1);
  assert.ok(near > far, `near ${near} should exceed far ${far}`);
  assert.ok(near > 1.4 && near < 1.7, `near factor ${near}`);
  assert.ok(far > 0.2 && far < 0.4, `far factor ${far}`);
});

test('zoomAt is monotonic in progress for every depth', () => {
  for (const z of [0, 0.3, 0.7, 1]) {
    let prev = -Infinity;
    for (let i = 0; i <= 20; i++) {
      const v = zoomAt(z, i / 20, { dolly: 0.5, parallax: 1 });
      assert.ok(v >= prev - 1e-9, `zoom decreased at z=${z} i=${i}`);
      prev = v;
    }
  }
});

test('cameraAt honours the easing mode and stays finite', () => {
  const scene = { depth: { zNebula: 0.3 } };
  for (const ease of ['linear', 'inOut', 'easeOut', 'outIn', 'easeIn']) {
    const a = cameraAt(0, { dollyEase: ease, seed: 1 }, scene, { width: 100, height: 100 });
    const b = cameraAt(1, { dollyEase: ease, seed: 1 }, scene, { width: 100, height: 100 });
    assert.ok(Number.isFinite(a.scale) && Number.isFinite(b.scale));
    assert.ok(Number.isFinite(a.ox) && Number.isFinite(a.oy));
    assert.ok(b.scale > a.scale, `${ease}: end zoom ${b.scale} should exceed start ${a.scale}`);
  }
  // Eased progress must stay within [0,1].
  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    const c = cameraAt(t, { dollyEase: 'inOut' }, scene, { width: 10, height: 10 });
    assert.ok(c.k >= 0 && c.k <= 1, `eased k ${c.k}`);
  }
});

test('renderFrame writes a fully opaque RGBA frame of the right size', () => {
  const raster = makeStarRaster({ seed: 43, width: 160, height: 120 });
  const scene = analyzeSync(raster, { seed: 1337 });
  const renderer = createRenderer(scene, { resolution: 160, durationSec: 1, fps: 2 });
  const out = new Uint8ClampedArray(renderer.width * renderer.height * 4);
  renderer.renderFrame(0, 2, out);
  assert.equal(out.length, renderer.width * renderer.height * 4);
  let nonOpaque = 0;
  for (let i = 3; i < out.length; i += 4) if (out[i] !== 255) nonOpaque++;
  assert.equal(nonOpaque, 0, 'every pixel must be opaque');
});

test('renderFrame is deterministic for identical inputs', () => {
  const raster = makeStarRaster({ seed: 47, width: 128, height: 96 });
  const scene = analyzeSync(raster, { seed: 1337 });
  const params = { resolution: 128, durationSec: 1, fps: 3, twinkle: 0.4 };
  const a = new Uint8ClampedArray(128 * 96 * 4);
  const b = new Uint8ClampedArray(128 * 96 * 4);
  renderFrame(scene, params, 1, 3, a);
  renderFrame(scene, params, 1, 3, b);
  assert.deepEqual(Array.from(a), Array.from(b), 'frames must be bit-identical');
});

test('the dolly actually changes the frame over time', () => {
  const raster = makeStarRaster({ seed: 53, width: 200, height: 150 });
  const scene = analyzeSync(raster, { seed: 1337 });
  const renderer = createRenderer(scene, { resolution: 200, durationSec: 2, fps: 2, dolly: 0.6, twinkle: 0 });
  const first = new Uint8ClampedArray(renderer.width * renderer.height * 4);
  const last = new Uint8ClampedArray(renderer.width * renderer.height * 4);
  renderer.renderFrame(0, 2, first);
  renderer.renderFrame(1, 2, last);
  let diff = 0;
  for (let i = 0; i < first.length; i += 4) {
    if (Math.abs(first[i] - last[i]) > 6) diff++;
  }
  const frac = diff / (renderer.width * renderer.height);
  assert.ok(frac > 0.02, `only ${(frac * 100).toFixed(1)}% of pixels changed between first and last frame`);
});

test('higher parallax increases the spread between near and far stars', () => {
  const scene = { depth: { zNebula: 0.3 } };
  const low = cameraAt(1, { parallax: 0.2, dolly: 0.5 }, scene, { width: 10, height: 10 });
  const high = cameraAt(1, { parallax: 2, dolly: 0.5 }, scene, { width: 10, height: 10 });
  // The camera itself only reports the nebula plane, so compare per-depth zoom.
  assert.ok(
    zoomAt(0, 1, { parallax: 2, dolly: 0.5 }) - zoomAt(1, 1, { parallax: 2, dolly: 0.5 }) >
      zoomAt(0, 1, { parallax: 0.2, dolly: 0.5 }) - zoomAt(1, 1, { parallax: 0.2, dolly: 0.5 })
  );
  assert.ok(Number.isFinite(low.scale) && Number.isFinite(high.scale));
});

test('renderer defaults come from DEFAULT_PARAMS and are clamped', () => {
  const raster = makeStarRaster({ seed: 59, width: 96, height: 72 });
  const scene = analyzeSync(raster, { seed: 1337 });
  const r = createRenderer(scene, { resolution: 99999, dolly: 5, fps: 999 });
  assert.ok(r.params.resolution <= 3840);
  assert.equal(r.params.dolly, 1);
  assert.ok(r.params.fps <= 60);
  assert.equal(r.params.durationSec, DEFAULT_PARAMS.durationSec);
});

test('analyzeSync produces adaptive recommended params', () => {
  const raster = makeStarRaster({ seed: 71, width: 200, height: 150 });
  const scene = analyzeSync(raster, { seed: 1337 });
  assert.ok(scene.recommended, 'scene must contain recommended params');
  const rec = scene.recommended;
  assert.ok(typeof rec.starScale === 'number' && rec.starScale >= 0.5 && rec.starScale <= 2.0);
  assert.ok(typeof rec.starGain === 'number' && rec.starGain >= 0.5 && rec.starGain <= 2.0);
  assert.ok(typeof rec.starColor === 'number' && rec.starColor >= 0 && rec.starColor <= 2.0);
  assert.ok(typeof rec.bloom === 'number' && rec.bloom >= 0 && rec.bloom <= 1.0);
  assert.ok(typeof rec.depthSpread === 'number' && rec.depthSpread >= 0 && rec.depthSpread <= 1.0);
  assert.ok(typeof rec.zNebula === 'number' && rec.zNebula >= 0 && rec.zNebula <= 1.0);
  assert.ok(typeof rec.inferredScene === 'string');
});

test('recommendStarParams adapts starScale to seeing / FWHM', () => {
  const dummyStars = [{ mag: 5, fluxNorm: 0.8, color: [1, 0.9, 0.8] }];
  const sharpRec = recommendStarParams(dummyStars, { medianFwhm: 1.2, density: 100 }, { width: 1600, height: 1200 }, { maskedPixels: 5000 });
  const fatRec = recommendStarParams(dummyStars, { medianFwhm: 5.5, density: 100 }, { width: 1600, height: 1200 }, { maskedPixels: 5000 });
  assert.ok(fatRec.starScale < sharpRec.starScale, 'fat stars must have smaller starScale to tighten cores');
});

test('recommendStarParams sets starColor to 0 for monochrome stars', () => {
  const monoStars = [
    { mag: 5, fluxNorm: 0.5, color: [0.5, 0.5, 0.5] },
    { mag: 7, fluxNorm: 0.2, color: [0.3, 0.3, 0.3] },
  ];
  const rec = recommendStarParams(monoStars, { medianFwhm: 2.0, density: 100 }, { width: 1600, height: 1200 }, { maskedPixels: 5000 });
  assert.equal(rec.starColor, 0, 'monochrome starfield should recommend starColor = 0');
});

test('recommendStarParams classifies high density low nebulosity as cluster/widefield', () => {
  const dummyStars = Array.from({ length: 100 }, (_, i) => ({ mag: 5 + i * 0.1, fluxNorm: 0.1, color: [1, 1, 1] }));
  const rec = recommendStarParams(dummyStars, { medianFwhm: 2.0, density: 950 }, { width: 1600, height: 1200 }, { maskedPixels: 1000 });
  assert.equal(rec.inferredScene, 'cluster');
  assert.ok(rec.depthSpread >= 0.8, 'clusters should get larger depthSpread');
  assert.ok(rec.zNebula <= 0.2, 'clusters have little background nebula');
});

