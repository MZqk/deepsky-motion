// Star-field analysis: detection, PSF metrics, depth assignment and starless plate.
//
// The whole "3D depth" illusion rests on three things produced here:
//   1. an accurate sub-pixel star catalogue (position, flux, FWHM, ellipticity)
//   2. a depth z in 0..1 per star, derived from brightness
//   3. a starless plate so the nebula can move on its own depth plane
//
// Pure functions, no I/O except for the sharp-based resize in `buildStarlessRaster`.

import { ANALYSIS } from '../config.mjs';

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** Rec.709 luminance of an interleaved RGB Float32 raster. */
export function luminance(raster) {
  const { data, width, height } = raster;
  const out = new Float32Array(width * height);
  for (let i = 0, p = 0; i < out.length; i++, p += 3) {
    out[i] = 0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2];
  }
  return out;
}

/**
 * Local sky background + noise model.
 *
 * A single global threshold fails badly on real astrophotos: nebulosity raises
 * the local level, so stars sitting on top of the nebula get suppressed, while
 * the global MAD is inflated by the nebula's own structure. Standard practice
 * (and what we do here) is a coarse background *mesh* of block medians plus a
 * robust *global* noise estimate taken from the mesh-subtracted residual.
 */
export function backgroundModel(lum, width, height, { block = 48 } = {}) {
  const bw = Math.max(2, Math.ceil(width / block));
  const bh = Math.max(2, Math.ceil(height / block));
  const mesh = new Float32Array(bw * bh);

  for (let by = 0; by < bh; by++) {
    const y0 = by * block;
    const y1 = Math.min(height, y0 + block);
    for (let bx = 0; bx < bw; bx++) {
      const x0 = bx * block;
      const x1 = Math.min(width, x0 + block);
      const vals = [];
      const stepY = Math.max(1, Math.floor((y1 - y0) / 12));
      const stepX = Math.max(1, Math.floor((x1 - x0) / 12));
      for (let y = y0; y < y1; y += stepY) {
        for (let x = x0; x < x1; x += stepX) vals.push(lum[y * width + x]);
      }
      vals.sort((a, b) => a - b);
      // 40th percentile: biased below the median so stars do not pull the sky up.
      mesh[by * bw + bx] = vals.length ? vals[Math.floor(vals.length * 0.4)] : 0;
    }
  }

  // Median-filter the mesh to kill blocks dominated by a bright star.
  const filtered = new Float32Array(mesh.length);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const vals = [];
      for (let dy = -1; dy <= 1; dy++) {
        const y = by + dy;
        if (y < 0 || y >= bh) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const x = bx + dx;
          if (x < 0 || x >= bw) continue;
          vals.push(mesh[y * bw + x]);
        }
      }
      vals.sort((a, b) => a - b);
      filtered[by * bw + bx] = vals[vals.length >> 1];
    }
  }

  // Bilinear upsample to full resolution.
  const bg = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const fy = Math.min(bh - 1.001, Math.max(0, (y + 0.5) / block - 0.5));
    const by0 = Math.floor(fy);
    const by1 = Math.min(bh - 1, by0 + 1);
    const ty = fy - by0;
    for (let x = 0; x < width; x++) {
      const fx = Math.min(bw - 1.001, Math.max(0, (x + 0.5) / block - 0.5));
      const bx0 = Math.floor(fx);
      const bx1 = Math.min(bw - 1, bx0 + 1);
      const tx = fx - bx0;
      const v00 = filtered[by0 * bw + bx0];
      const v10 = filtered[by0 * bw + bx1];
      const v01 = filtered[by1 * bw + bx0];
      const v11 = filtered[by1 * bw + bx1];
      bg[y * width + x] = (v00 * (1 - tx) + v10 * tx) * (1 - ty) + (v01 * (1 - tx) + v11 * tx) * ty;
    }
  }

  // Noise from the mesh-subtracted residual (subsampled).
  const n = width * height;
  const stride = Math.max(1, Math.floor(n / 200000));
  const res = [];
  for (let i = 0; i < n; i += stride) res.push(Math.abs(lum[i] - bg[i]));
  res.sort((a, b) => a - b);
  const mad = res[res.length >> 1] || 1e-6;
  const sigma = Math.max(1e-6, 1.4826 * mad);
  const median = (() => {
    const s = [];
    for (let i = 0; i < n; i += stride) s.push(lum[i]);
    s.sort((a, b) => a - b);
    return s[s.length >> 1];
  })();

  return { bg, sigma, median, block, bw, bh, mesh: filtered };
}

/**
 * Detect stars.
 *
 * The naive approach — one threshold, connected components, then reject blobs
 * that are "too big" — fails on the most important stars. A bright star's
 * diffraction spikes merge with its core and with its neighbours' spikes into a
 * single blob hundreds of pixels across, so the size filter throws the star away.
 * The result is a catalogue containing *every star except the bright ones*, and a
 * starless plate that still shows them — the exact opposite of what the depth
 * effect needs.
 *
 * So we detect on local maxima instead of on blob extent:
 *
 *   1. Threshold at 4.5σ above the local sky to get candidate pixels.
 *   2. Find local maxima of the residual within a small window. A diffraction
 *      spike is a thin ridge, so it produces at most a couple of maxima along its
 *      length; a star core produces exactly one strong maximum. This is what
 *      cleanly separates cores from spikes without throwing either away.
 *   3. Refine each maximum to sub-pixel accuracy by fitting a 1-D quadratic
 *      through the residual in x and y (the standard centroid refinement).
 *   4. Measure flux, FWHM and ellipticity from a small window around the
 *      maximum, weighted by the residual above the local sky, with the
 *      contribution of already-claimed neighbours suppressed so that a bright
 *      star's halo does not inflate a faint neighbour's flux.
 *
 * @returns {Array} stars sorted by flux desc
 */
export function detectStars(raster, opts = {}) {
  const {
    sigma = ANALYSIS.detectSigma,
    minArea = ANALYSIS.minArea,
    maxStars = ANALYSIS.maxStars,
    maxEllipticity = ANALYSIS.maxEllipticity,
    maxFwhm = 16,
  } = opts;

  const W = raster.width;
  const H = raster.height;
  const N = W * H;
  const lum = opts.lum || luminance(raster);
  const model = opts.model || backgroundModel(lum, W, H, { block: opts.block || 48 });
  const { bg, sigma: noise } = model;
  const level = sigma * noise;

  // Residual above the local sky; negative values clamp to 0.
  const resid = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const v = lum[i] - bg[i];
    resid[i] = v > 0 ? v : 0;
  }

  // --- 1. candidate pixels -------------------------------------------------
  const cand = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (resid[i] > level) cand[i] = 1;

  // --- 2. local maxima -----------------------------------------------------
  // Window radius 1: a true PSF core is a single peak; spikes have no interior
  // peak across their width, so they are rejected as maxima but still counted
  // when measuring the flux of the core they belong to.
  const maxima = [];
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      if (!cand[i]) continue;
      const v = resid[i];
      let isMax = true;
      for (let dy = -1; dy <= 1 && isMax; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          if (resid[(y + dy) * W + (x + dx)] > v) {
            isMax = false;
            break;
          }
        }
      }
      if (isMax) maxima.push(i);
    }
  }

  // Merge maxima that are closer than ~1 FWHM: a slightly noisy core can throw
  // two adjacent maxima, and we want one star, not two.
  maxima.sort((a, b) => resid[b] - resid[a]);
  const claimed = new Int32Array(N).fill(-1);
  const kept = [];
  const mergeR = opts.mergeRadius ?? 2.2;
  const mergeR2 = mergeR * mergeR;
  for (const i of maxima) {
    const x = i % W;
    const y = (i - x) / W;
    let clash = false;
    const r = Math.ceil(mergeR);
    for (let dy = -r; dy <= r && !clash; dy++) {
      const ny = y + dy;
      if (ny < 0 || ny >= H) continue;
      for (let dx = -r; dx <= r; dx++) {
        const nx = x + dx;
        if (nx < 0 || nx >= W) continue;
        if (dx * dx + dy * dy > mergeR2) continue;
        if (claimed[ny * W + nx] >= 0) {
          clash = true;
          break;
        }
      }
    }
    if (clash) continue;
    claimed[y * W + x] = kept.length;
    kept.push(i);
  }

  // --- 3. + 4. refine and measure ------------------------------------------
  const stars = [];
  const measureR = opts.measureRadius ?? 3.0;

  for (let k = 0; k < kept.length; k++) {
    const i0 = kept[k];
    const x0 = i0 % W;
    const y0 = (i0 - x0) / W;

    // Sub-pixel refinement: parabola through the residual in each axis.
    const c = resid[i0];
    const xm = resid[i0 - 1];
    const xp = resid[i0 + 1];
    const ym = resid[i0 - W];
    const yp = resid[i0 + W];
    const dxp = 0.5 * (xm - xp) / Math.max(1e-9, xm - 2 * c + xp);
    const dyp = 0.5 * (ym - yp) / Math.max(1e-9, ym - 2 * c + yp);
    const px = x0 + (Math.abs(dxp) < 1 ? dxp : 0);
    const py = y0 + (Math.abs(dyp) < 1 ? dyp : 0);

    // Measure over a window, suppressing pixels claimed by a brighter neighbour.
    const R = Math.max(2, Math.ceil(measureR));
    let sum = 0;
    let sumX = 0;
    let sumY = 0;
    let sumXX = 0;
    let sumYY = 0;
    let sumXY = 0;
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    let peak = c;
    let area = 0;
    const rData = raster?.data;
    for (let dy = -R; dy <= R; dy++) {
      const y = y0 + dy;
      if (y < 0 || y >= H) continue;
      for (let dx = -R; dx <= R; dx++) {
        const x = x0 + dx;
        if (x < 0 || x >= W) continue;
        const d2 = dx * dx + dy * dy;
        if (d2 > measureR * measureR + 0.5) continue;
        const q = y * W + x;
        // If this pixel belongs to a brighter star, do not count it here.
        const owner = claimed[q];
        if (owner >= 0 && owner !== k && resid[q] > resid[i0]) continue;
        const v = resid[q];
        if (v <= 0) continue;
        sum += v;
        area++;
        sumX += v * x;
        sumY += v * y;
        sumXX += v * x * x;
        sumYY += v * y * y;
        sumXY += v * x * y;
        if (rData) {
          const p = q * 3;
          sumR += rData[p] * v;
          sumG += rData[p + 1] * v;
          sumB += rData[p + 2] * v;
        }
        if (v > peak) peak = v;
      }
    }
    if (sum <= 0 || area < minArea) continue;

    let color = [1, 1, 1];
    const maxCh = Math.max(sumR, sumG, sumB, 1e-7);
    if (maxCh > 1e-7 && (sumR > 0 || sumG > 0 || sumB > 0)) {
      color = [
        round3(clamp(sumR / maxCh, 0.15, 1)),
        round3(clamp(sumG / maxCh, 0.15, 1)),
        round3(clamp(sumB / maxCh, 0.15, 1)),
      ];
    }

    // --- shape test: reject texture, keep point sources --------------------
    // Nebula filaments and noise also produce local maxima. What separates them
    // from a star is that a star's energy is concentrated, whereas a filament
    // rises slowly over tens of pixels.
    //
    // The test is `peak / (sum / area)` — peak over the MEAN of the aperture,
    // not over the sum. The mean form is scale invariant: a well-sampled star
    // (FWHM ~5 px) and an undersampled one (FWHM ~1 px) both peak at roughly
    // 3-4x their aperture mean, so one threshold works across image scales.
    // Comparing peak against the raw sum would instead depend on how many
    // pixels the aperture happens to contain.
    if (peak / (sum / area) < (opts.minConcentration ?? 1.75)) continue;

    const cx0 = sumX / sum;
    const cy0 = sumY / sum;
    const mxx0 = Math.max(0, sumXX / sum - cx0 * cx0);
    const myy0 = Math.max(0, sumYY / sum - cy0 * cy0);
    const mxy0 = sumXY / sum - cx0 * cy0;
    const tr0 = mxx0 + myy0;
    const det0 = mxx0 * myy0 - mxy0 * mxy0;
    const disc0 = Math.max(0, (tr0 * tr0) / 4 - det0);
    const root0 = Math.sqrt(disc0);
    const l1 = tr0 / 2 + root0;
    const l2 = Math.max(1e-6, tr0 / 2 - root0);
    const sigmaPix = Math.sqrt(Math.max(1e-6, (l1 + l2) / 2));
    // Provisional moment width. The moments come from a 3 px aperture, so this
    // is biased toward the window size and cannot resolve a PSF narrower than
    // ~2 px. It is corrected against the frame-wide PSF below.
    const fwhmMoment = Math.max(0.9, 2.3548200450309493 * sigmaPix);
    const ellipticity = clamp(1 - Math.sqrt(l2 / l1), 0, 1);

    stars.push({
      x: px,
      y: py,
      flux: sum,
      peak,
      fwhmMoment,
      ellipticity,
      snr: peak / noise,
      area,
      noise,
      color,
    });
  }

  let result = stars.filter((s) => {
    if (s.ellipticity > maxEllipticity && s.area > 10) return false;
    if (s.snr < (opts.minSnr ?? ANALYSIS.minSnr)) return false;
    if (s.x < 1 || s.y < 1 || s.x > W - 2 || s.y > H - 2) return false;
    return true;
  });

  result.sort((a, b) => b.flux - a.flux);
  if (result.length > maxStars) result = result.slice(0, maxStars);

  // --- frame-wide PSF -------------------------------------------------------
  // In a real stacked frame every star shares essentially the same PSF: the
  // width comes from the optics and the seeing, not from the star's brightness.
  // Measuring each star independently inside a small window is both noisy and
  // biased, and using that biased width to draw the sprites turns every faint
  // star into a fat blob — the field degenerates into speckle.
  //
  // So we take the robust median of the provisional widths over the WELL
  // MEASURED stars (high SNR, not merged) and use that as the frame PSF. The
  // brightest stars then get a small extra allowance for blooming.
  const wellMeasured = result.filter((s) => s.snr >= 18 && s.area >= 5).map((s) => s.fwhmMoment);
  wellMeasured.sort((a, b) => a - b);
  const psfFwhm = wellMeasured.length >= 8
    ? wellMeasured[Math.floor(wellMeasured.length / 2)]
    : result.length
      ? result[Math.floor(result.length / 2)].fwhmMoment
      : 2;

  const fluxRef = result.length ? Math.max(1e-9, result[0].flux) : 1;
  const peakRef = result.length ? Math.max(1e-9, result[0].peak) : 1;

  return result.map((s) => {
    const fluxNorm = clamp(s.flux / fluxRef, 0, 1);
    // A brighter star saturates a slightly wider area of the sensor, so it does
    // read a touch larger — but only a touch. The base width is the frame PSF.
    const fwhm = Math.max(0.9, psfFwhm * (1 + 0.28 * Math.sqrt(fluxNorm)));
    return {
      x: round3(s.x),
      y: round3(s.y),
      flux: s.flux,
      peak: clamp(s.peak / peakRef, 0, 1),
      // Absolute core brightness above the local sky, in raster units (0..1).
      // The renderer needs the real number, not a normalised one, to place the
      // star correctly against the plate's own brightness.
      peakMeasured: s.peak,
      fluxNorm,
      fwhm: round3(fwhm),
      fwhmMoment: round3(s.fwhmMoment),
      ellipticity: round3(s.ellipticity),
      snr: Math.round(s.snr),
      mag: round3(-2.5 * Math.log10(Math.max(1e-9, s.flux))),
      area: s.area,
      // Halo radius for the starless plate, expressed in pixels.
      //
      // It MUST be relative to the brightest star in the frame, not to the noise
      // level: with a low-noise stack almost every star clears any absolute bar, so
      // an absolute threshold masks the whole image. Scaling steeply with
      // fluxNorm keeps the mask small for the thousands of faint stars (their halos
      // are genuinely negligible) and generous only for the handful that really do
      // carry 40-60 px halos and spikes.
      haloR: Math.max(3, Math.round(fwhm * 1.6 + 2 + 36 * Math.pow(fluxNorm, 1.8))),
      psfFwhm: round3(psfFwhm),
      noise: s.noise,
      color: s.color || [1, 1, 1],
    };
  });
}

function round3(v) {
  return Math.round(v * 1000) / 1000;
}

/** Aggregate PSF metrics for the scene summary panel. */
export function estimatePsf(stars, raster) {
  if (!stars.length) {
    return { medianFwhm: 0, medianEllipticity: 0, starCount: 0, density: 0, brightest: null, faintest: null };
  }
  const fwhms = stars.map((s) => s.fwhm).sort((a, b) => a - b);
  const ells = stars.map((s) => s.ellipticity).sort((a, b) => a - b);
  const mid = (arr) => arr[Math.floor(arr.length / 2)];
  const area = raster ? raster.width * raster.height : 1;
  const mags = stars.map((s) => s.mag);
  return {
    medianFwhm: round3(mid(fwhms)),
    medianEllipticity: round3(mid(ells)),
    starCount: stars.length,
    density: Math.round((stars.length / area) * 1e6) / 1000, // stars per megapixel
    brightest: round3(Math.min(...mags)),
    faintest: round3(Math.max(...mags)),
  };
}

/**
 * Assign a depth z in 0..1 to every star. z=0 is closest to the camera.
 * Brighter stars sit nearer; a seeded 10% minority is pushed in front of the
 * nebula so the field genuinely straddles it (that is the strongest depth cue).
 */
export function assignDepth(stars, params = {}) {
  const spread = clamp(params.depthSpread ?? 0.6, 0, 1);
  const power = clamp(params.depthPower ?? 1.35, 0.3, 3);
  const zNebula = clamp(params.zNebula ?? 0.3, 0.05, 0.8);
  const rand = mulberry32((params.seed ?? 1337) ^ 0x5f3759df);

  if (!stars.length) {
    return { zNebula, zStarsNear: 0, zStarsFar: 1, magBright: 0, magFaint: 0, power, spread, zOf: () => zNebula };
  }

  const mags = stars.map((s) => s.mag);
  const magBright = Math.min(...mags);
  const magFaint = Math.max(...mags);
  const range = Math.max(0.35, magFaint - magBright);

  const zNear = Math.max(0.02, zNebula - 0.3 * spread);
  const zFar = Math.min(1, zNebula + (1 - zNebula) * (0.55 + 0.45 * spread));

  const depths = new Float32Array(stars.length);
  for (let i = 0; i < stars.length; i++) {
    const t = clamp((stars[i].mag - magBright) / range, 0, 1);
    let z = lerp(zNear, zFar, Math.pow(t, power));
    // A small foreground population: field stars in front of the nebula.
    if (rand() < 0.1) z = lerp(0.02, Math.max(0.04, zNebula - 0.06), rand());
    depths[i] = clamp(z, 0, 1);
  }

  return {
    zNebula,
    zStarsNear: zNear,
    zStarsFar: zFar,
    magBright: round3(magBright),
    magFaint: round3(magFaint),
    power,
    spread,
    depths,
    zOf(star, index) {
      if (index != null && depths[index] != null) return depths[index];
      const t = clamp((star.mag - magBright) / range, 0, 1);
      return clamp(lerp(zNear, zFar, Math.pow(t, power)), 0, 1);
    },
  };
}

/** Attach a stable depth to each star and a deterministic per-star phase. */
export function applyDepth(stars, depthPlan, seed = 1337) {
  const rand = mulberry32((seed >>> 0) ^ 0x9e3779b9);
  return stars.map((s, i) => ({
    ...s,
    z: depthPlan.depths ? depthPlan.depths[i] : depthPlan.zOf(s, i),
    phase: rand() * Math.PI * 2,
    twinkleRate: 0.6 + rand() * 1.9,
  }));
}

/**
 * Build the starless plate.
 *
 * Real astrophotography halos extend 20-90 px around a bright star — far wider
 * than the detected core. Naive core-only masking therefore leaves the halo
 * behind, and because the plate zooms on the nebula plane while the catalogue
 * stars zoom on their own planes, a leftover halo visibly *separates* from its
 * star during the dolly.
 *
 * The fill is a mask-aware "push-pull" pyramid, the standard technique for
 * hole-filling in image processing:
 *
 *   PUSH  — repeatedly halve the resolution, and at each level take the
 *           WEIGHTED AVERAGE of only the *unmasked* children. A coarse cell
 *           therefore holds pure nebula, no matter how big the hole below it is;
 *           a cell whose children are entirely masked inherits the level above.
 *   PULL  — walk back down. A masked pixel is replaced by bilinear interpolation
 *           of the coarser (already hole-free) level; unmasked pixels keep the
 *           real data. Because each level's fill comes from real nebula pixels
 *           tens of pixels away, the result never *erodes* the nebula the way
 *           direct profile subtraction does, and the multi-scale blend keeps
 *           large-scale structure intact.
 *
 * This is deterministic and O(n) in the number of pixels per level.
 *
 * Returns an sRGB RGBA buffer at the source resolution.
 */
export function buildStarless(raster, stars, opts = {}) {
  const margin = opts.margin ?? ANALYSIS.starlessMargin;
  const W = raster.width;
  const H = raster.height;
  const N = W * H;

  const rgb = new Float32Array(N * 3);
  for (let i = 0, p = 0, q = 0; i < N; i++, p += 3, q += 3) {
    rgb[q] = raster.data[p];
    rgb[q + 1] = raster.data[p + 1];
    rgb[q + 2] = raster.data[p + 2];
  }

  // --- 1. halo mask ---------------------------------------------------------
  // Only the brightest `fullMaskCount` stars get their whole halo masked. The
  // faint majority get a core-only mask.
  //
  // This is a deliberate trade, not a shortcut. A 1600x1067 frame holds ~1300
  // detected stars; masking every measured halo would cover more than the whole
  // frame and the pyramid would degenerate into a flat wash. In practice only the
  // bright stars have halos and spikes wide enough to be visible after the plate
  // is zoomed, and their residual motion is what would break the depth illusion.
  // A faint star's 2 px core, left in the plate, is sub-pixel at output scale and
  // reads as part of the nebula texture.
  const fullMaskCount = opts.fullMaskCount ?? 0;
  const sorted = opts.maskOrder || [...stars].sort((a, b) => (b.fluxNorm ?? 0) - (a.fluxNorm ?? 0));
  const fullMask = new Set(sorted.slice(0, fullMaskCount));
  const mask = new Uint8Array(N); // 1 = hole (must be filled)
  let maskedPixels = 0;
  for (const s of stars) {
    const fwhm = Math.max(1, s.fwhm || 2);
    const bright = clamp(s.fluxNorm ?? s.peak ?? 0, 0, 1);
    const coreR = Math.max(1.8, fwhm * margin);
    // The detector measured each star's real halo extent (spikes and glow
    // included), so trust it; fall back to a brightness-scaled estimate when the
    // caller supplies stars from elsewhere.
    const measured = s.haloR ? Math.max(coreR, s.haloR) : coreR + 2.0 + 28 * Math.pow(bright, 0.8);
    const haloR = fullMask.has(s) ? measured : coreR;
    const cx = s.x;
    const cy = s.y;
    const r2max = haloR * haloR;
    const x0 = Math.max(0, Math.floor(cx - haloR));
    const x1 = Math.min(W - 1, Math.ceil(cx + haloR));
    const y0 = Math.max(0, Math.floor(cy - haloR));
    const y1 = Math.min(H - 1, Math.ceil(cy + haloR));
    for (let y = y0; y <= y1; y++) {
      const dy = y - cy;
      for (let x = x0; x <= x1; x++) {
        const dx = x - cx;
        if (dx * dx + dy * dy <= r2max) {
          const i = y * W + x;
          if (!mask[i]) maskedPixels++;
          mask[i] = 1;
        }
      }
    }
  }

  if (maskedPixels === 0) {
    return { data: toRgba(rgb, N), width: W, height: H, maskedPixels: 0, levels: 0, starCount: stars.length };
  }

  // --- 2. PUSH: weighted-average pyramid that ignores masked pixels ---------
  const levels = [{ w: W, h: H, data: rgb, weight: maskToWeight(mask, N) }];
  const minSide = opts.minSide ?? ANALYSIS.starlessMinSide;
  while (
    levels[levels.length - 1].w > minSide &&
    levels[levels.length - 1].h > minSide &&
    levels.length < 14
  ) {
    const prev = levels[levels.length - 1];
    const nw = Math.max(1, prev.w >> 1);
    const nh = Math.max(1, prev.h >> 1);
    const data = new Float32Array(nw * nh * 3);
    const weight = new Float32Array(nw * nh);
    for (let y = 0; y < nh; y++) {
      for (let x = 0; x < nw; x++) {
        let sr = 0;
        let sg = 0;
        let sb = 0;
        let sw = 0;
        for (let dy = 0; dy < 2; dy++) {
          const sy = y * 2 + dy;
          if (sy >= prev.h) continue;
          for (let dx = 0; dx < 2; dx++) {
            const sx = x * 2 + dx;
            if (sx >= prev.w) continue;
            const pi = sy * prev.w + sx;
            const w = prev.weight[pi];
            if (w <= 0) continue; // masked: contributes nothing
            const p = pi * 3;
            sr += prev.data[p] * w;
            sg += prev.data[p + 1] * w;
            sb += prev.data[p + 2] * w;
            sw += w;
          }
        }
        const d = (y * nw + x) * 3;
        if (sw > 0) {
          data[d] = sr / sw;
          data[d + 1] = sg / sw;
          data[d + 2] = sb / sw;
          weight[y * nw + x] = Math.min(1, sw / 4);
        } else {
          // Entirely masked cell: mark weight 0 and let the PULL step inherit
          // from the level above.
          data[d] = 0;
          data[d + 1] = 0;
          data[d + 2] = 0;
          weight[y * nw + x] = 0;
        }
      }
    }
    levels.push({ w: nw, h: nh, data, weight });
  }

  // Fill any zero-weight cells at the coarsest level from its valid neighbours.
  const top = levels[levels.length - 1];
  fillInvalid(top.data, top.weight, top.w, top.h);

  // --- 3. PULL: interpolate coarse levels down into the holes ---------------
  for (let li = levels.length - 2; li >= 0; li--) {
    const fine = levels[li];
    const coarse = levels[li + 1];
    const up = upsampleBilinear(coarse.data, coarse.w, coarse.h, fine.w, fine.h);
    for (let i = 0; i < fine.w * fine.h; i++) {
      if (fine.weight[i] > 0) continue; // real pixel, keep it
      const p = i * 3;
      fine.data[p] = up[p];
      fine.data[p + 1] = up[p + 1];
      fine.data[p + 2] = up[p + 2];
      fine.weight[i] = 0.5; // allow the next finer level to blend over it
    }
  }

  // --- 4. blend the filled pixels back over the original --------------------
  // A soft alpha across the mask boundary avoids a visible seam.
  const alpha = featherAlpha(mask, W, H, opts.feather ?? 1.0);
  const out = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const a = alpha[i];
    const p = i * 3;
    out[p] = rgb[p] * (1 - a) + levels[0].data[p] * a;
    out[p + 1] = rgb[p + 1] * (1 - a) + levels[0].data[p + 1] * a;
    out[p + 2] = rgb[p + 2] * (1 - a) + levels[0].data[p + 2] * a;
  }

  // --- 5. residual cleanup --------------------------------------------------
  // A handful of bright stars always survive the first pass: their halo overlaps
  // a brighter neighbour that was filled first, or they sit on a steep nebula
  // gradient where the coarse levels inherit some of their own light. Rather than
  // chase this with ever more aggressive first-pass masking (which destroys the
  // nebula), we iterate: find what is still bright and compact in the RESULT, and
  // fill exactly that. Two passes converge in practice.
  const cleanupPasses = opts.cleanupPasses ?? 0;
  const plateData = out;
  let residualFixed = 0;
  for (let pass = 0; pass < cleanupPasses; pass++) {
    const holes = findBrightResiduals(plateData, W, H, {
      threshold: opts.residualThreshold ?? 0.065,
      radius: opts.residualRadius ?? 4,
    });
    if (holes.count === 0) break;
    residualFixed += holes.count;
    fillPushPull(plateData, holes.mask, W, H, opts);
  }

  return {
    data: toRgba(plateData, N),
    width: W,
    height: H,
    maskedPixels,
    residualFixed,
    levels: levels.length,
    starCount: stars.length,
  };
}

/**
 * Locate compact bright blobs still present in a starless plate.
 * Uses the same local-maximum logic as the star detector, but on the plate: a
 * leftover star is a compact maximum, whereas nebula structure is broad.
 */
function findBrightResiduals(rgb, W, H, { threshold = 0.065, radius = 4 } = {}) {
  const N = W * H;
  const mask = new Uint8Array(N);
  let count = 0;
  const lum = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    lum[i] = 0.2126 * rgb[i * 3] + 0.7152 * rgb[i * 3 + 1] + 0.0722 * rgb[i * 3 + 2];
  }

  // Local maxima on a 3 px window, above the absolute threshold.
  const maxima = [];
  for (let y = 2; y < H - 2; y++) {
    for (let x = 2; x < W - 2; x++) {
      const i = y * W + x;
      const v = lum[i];
      if (v < threshold) continue;
      let isMax = true;
      for (let dy = -1; dy <= 1 && isMax; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          if (lum[(y + dy) * W + (x + dx)] > v) {
            isMax = false;
            break;
          }
        }
      }
      if (isMax) maxima.push([x, y, v]);
    }
  }

  // Keep only maxima that stand out from their immediate surround. A leftover
  // star core is a sharp spike; nebula structure is a broad plateau, so the
  // contrast against a 5 px ring separates them cleanly.
  maxima.sort((a, b) => b[2] - a[2]);
  for (const [x, y, v] of maxima) {
    const ring = [];
    for (let a = 0; a < 16; a++) {
      const th = (a / 16) * Math.PI * 2;
      const rx = Math.round(x + Math.cos(th) * 5);
      const ry = Math.round(y + Math.sin(th) * 5);
      if (rx < 0 || ry < 0 || rx >= W || ry >= H) continue;
      ring.push(lum[ry * W + rx]);
    }
    if (ring.length < 8) continue;
    ring.sort((a, b) => a - b);
    const surround = ring[ring.length >> 1];
    if (v - surround < 0.05) continue;

    const r = radius;
    const x0 = Math.max(0, x - r);
    const x1 = Math.min(W - 1, x + r);
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(H - 1, y + r);
    let touched = false;
    for (let yy = y0; yy <= y1; yy++) {
      for (let xx = x0; xx <= x1; xx++) {
        const dx = xx - x;
        const dy = yy - y;
        if (dx * dx + dy * dy > r * r) continue;
        const q = yy * W + xx;
        if (!mask[q]) touched = true;
        mask[q] = 1;
      }
    }
    if (touched) count++;
  }
  return { mask, count };
}

/** Push-pull fill of an arbitrary mask over an interleaved RGB float buffer. */
function fillPushPull(rgb, mask, W, H, opts = {}) {
  const N = W * H;
  const levels = [{ w: W, h: H, data: rgb, weight: maskToWeight(mask, N) }];
  const minSide = opts.minSide ?? ANALYSIS.starlessMinSide;
  while (levels[levels.length - 1].w > minSide && levels[levels.length - 1].h > minSide && levels.length < 14) {
    const prev = levels[levels.length - 1];
    const nw = Math.max(1, prev.w >> 1);
    const nh = Math.max(1, prev.h >> 1);
    const data = new Float32Array(nw * nh * 3);
    const weight = new Float32Array(nw * nh);
    for (let y = 0; y < nh; y++) {
      for (let x = 0; x < nw; x++) {
        let sr = 0;
        let sg = 0;
        let sb = 0;
        let sw = 0;
        for (let dy = 0; dy < 2; dy++) {
          const sy = y * 2 + dy;
          if (sy >= prev.h) continue;
          for (let dx = 0; dx < 2; dx++) {
            const sx = x * 2 + dx;
            if (sx >= prev.w) continue;
            const pi = sy * prev.w + sx;
            const w = prev.weight[pi];
            if (w <= 0) continue;
            const p = pi * 3;
            sr += prev.data[p] * w;
            sg += prev.data[p + 1] * w;
            sb += prev.data[p + 2] * w;
            sw += w;
          }
        }
        const d = (y * nw + x) * 3;
        if (sw > 0) {
          data[d] = sr / sw;
          data[d + 1] = sg / sw;
          data[d + 2] = sb / sw;
          weight[y * nw + x] = Math.min(1, sw / 4);
        } else {
          weight[y * nw + x] = 0;
        }
      }
    }
    levels.push({ w: nw, h: nh, data, weight });
  }
  const top = levels[levels.length - 1];
  fillInvalid(top.data, top.weight, top.w, top.h);
  for (let li = levels.length - 2; li >= 0; li--) {
    const fine = levels[li];
    const coarse = levels[li + 1];
    const up = upsampleBilinear(coarse.data, coarse.w, coarse.h, fine.w, fine.h);
    for (let i = 0; i < fine.w * fine.h; i++) {
      if (fine.weight[i] > 0) continue;
      const p = i * 3;
      fine.data[p] = up[p];
      fine.data[p + 1] = up[p + 1];
      fine.data[p + 2] = up[p + 2];
      fine.weight[i] = 0.5;
    }
  }
}

/** 1 for real pixels, 0 for masked ones. */
function maskToWeight(mask, N) {
  const w = new Float32Array(N);
  for (let i = 0; i < N; i++) w[i] = mask[i] ? 0 : 1;
  return w;
}

/** Replace zero-weight cells with the mean of their valid neighbours. */
function fillInvalid(data, weight, w, h) {
  let guard = 0;
  while (guard++ < 64) {
    let remaining = 0;
    const snapshot = data.slice();
    const wSnapshot = weight.slice();
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (wSnapshot[i] > 0) continue;
        remaining++;
        let sr = 0;
        let sg = 0;
        let sb = 0;
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            const j = yy * w + xx;
            if (wSnapshot[j] <= 0) continue;
            sr += snapshot[j * 3];
            sg += snapshot[j * 3 + 1];
            sb += snapshot[j * 3 + 2];
            n++;
          }
        }
        if (n > 0) {
          data[i * 3] = sr / n;
          data[i * 3 + 1] = sg / n;
          data[i * 3 + 2] = sb / n;
          weight[i] = 1;
        }
      }
    }
    if (remaining === 0) break;
  }
}

function toRgba(rgb, N) {
  const out = new Uint8ClampedArray(N * 4);
  for (let i = 0, p = 0, q = 0; i < N; i++, p += 4, q += 3) {
    out[p] = Math.round(clamp(rgb[q], 0, 1) * 255);
    out[p + 1] = Math.round(clamp(rgb[q + 1], 0, 1) * 255);
    out[p + 2] = Math.round(clamp(rgb[q + 2], 0, 1) * 255);
    out[p + 3] = 255;
  }
  return out;
}

function upsampleBilinear(src, sw, sh, dw, dh) {
  const out = new Float32Array(dw * dh * 3);
  const sx = sw / dw;
  const sy = sh / dh;
  for (let y = 0; y < dh; y++) {
    const fy = Math.min(sh - 1.001, Math.max(0, (y + 0.5) * sy - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(sh - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < dw; x++) {
      const fx = Math.min(sw - 1.001, Math.max(0, (x + 0.5) * sx - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(sw - 1, x0 + 1);
      const tx = fx - x0;
      const d = (y * dw + x) * 3;
      for (let c = 0; c < 3; c++) {
        const v00 = src[(y0 * sw + x0) * 3 + c];
        const v10 = src[(y0 * sw + x1) * 3 + c];
        const v01 = src[(y1 * sw + x0) * 3 + c];
        const v11 = src[(y1 * sw + x1) * 3 + c];
        out[d + c] = (v00 * (1 - tx) + v10 * tx) * (1 - ty) + (v01 * (1 - tx) + v11 * tx) * ty;
      }
    }
  }
  return out;
}

/** Soft alpha: 1 deep inside the mask, tapering to 0 just outside it. */
function featherAlpha(mask, W, H, radius) {
  const alpha = new Float32Array(W * H);
  for (let i = 0; i < alpha.length; i++) alpha[i] = mask[i] ? 1 : 0;
  if (radius < 1) return alpha;
  const src = alpha.slice();
  const r = Math.ceil(radius);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      let sum = 0;
      let n = 0;
      for (let dy = -r; dy <= r; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= H) continue;
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= W) continue;
          sum += src[yy * W + xx];
          n++;
        }
      }
      alpha[i] = n ? sum / n : src[i];
    }
  }
  return alpha;
}


function round2(v) {
  return Math.round(v * 100) / 100;
}

/**
 * Heuristic parameter recommendation based on measured PSF, photometric dynamic range,
 * color variance, and nebulosity extent.
 */
export function recommendStarParams(stars, psf, raster, starless, params = {}) {
  const W = raster?.width || 1600;
  const H = raster?.height || 1067;
  const N = W * H;

  // 1. Star scale baseline:
  // Normalize Airy core so rendered stars retain pinpoint sharpness (target ~1.45px)
  const medianFwhm = (psf && psf.medianFwhm > 0) ? psf.medianFwhm : 2.0;
  const longEdge = Math.max(W, H);
  const scaleRatio = Math.min(1, 1280 / Math.max(1, longEdge));
  const effectiveFwhm = medianFwhm * scaleRatio * 0.60;
  const starScale = clamp(round2(1.45 / Math.max(0.7, effectiveFwhm)), 0.68, 1.35);

  // 2. Star gain baseline:
  // Detect if extreme primary bright stars over-compress the flux of the remaining field
  let starGain = 1.0;
  if (stars && stars.length >= 15) {
    const mags = stars.map((s) => s.mag).filter((m) => Number.isFinite(m)).sort((a, b) => a - b);
    if (mags.length >= 15) {
      const p05 = mags[Math.floor(mags.length * 0.05)];
      const p50 = mags[Math.floor(mags.length * 0.50)];
      const magSpread = p50 - p05;
      if (magSpread > 3.8) {
        starGain = clamp(round2(1.0 + (magSpread - 3.8) * 0.12), 1.0, 1.38);
      }
    }
  }

  // 3. Star color baseline:
  // Inspect chromatic dispersion across detected stars.
  // Mono/grayscale images yield 0, true broadband RGB yields ~0.85-0.95.
  let starColor = 0.85;
  if (stars && stars.length > 0) {
    let chromaDiffSum = 0;
    let colorSamples = 0;
    const sampleLimit = Math.min(stars.length, 120);
    for (let i = 0; i < sampleLimit; i++) {
      const c = stars[i].color;
      if (Array.isArray(c) && c.length === 3) {
        chromaDiffSum += Math.abs(c[0] - c[1]) + Math.abs(c[1] - c[2]) + Math.abs(c[0] - c[2]);
        colorSamples++;
      }
    }
    const avgChromaDiff = colorSamples > 0 ? chromaDiffSum / (colorSamples * 3) : 0;
    if (avgChromaDiff < 0.015) {
      starColor = 0.0; // monochrome frame
    } else if (avgChromaDiff > 0.12) {
      starColor = 0.95; // saturated rich starfield
    } else {
      starColor = 0.85;
    }
  }

  // 4. Bloom baseline:
  const brightCount = stars ? stars.filter((s) => (s.fluxNorm ?? 0) > 0.20).length : 0;
  const brightRatio = stars && stars.length > 0 ? brightCount / stars.length : 0;
  const bloom = clamp(round2(0.12 + brightRatio * 1.5), 0.09, 0.25);

  // 5. Scene classification & depth structure:
  // True physical density: stars per megapixel (handles both raw density and estimatePsf's /1000 scaling)
  let density = 0;
  if (psf && Number.isFinite(psf.density) && psf.density > 0) {
    density = psf.density > 10 ? psf.density : psf.density * 1000;
  } else if (stars?.length && N > 0) {
    density = (stars.length / N) * 1e6;
  }

  // Measure emission ratio above the background sky
  let nebRatio = 0;
  if (params.lum && params.model) {
    const lum = params.lum;
    const bg = params.model.bg;
    const thr = 3 * params.model.sigma;
    let emissionCount = 0;
    const stride = Math.max(1, Math.floor(N / 50000));
    let samples = 0;
    for (let i = 0; i < N; i += stride) {
      if (lum[i] - bg[i] > thr || lum[i] > 0.12) emissionCount++;
      samples++;
    }
    nebRatio = samples > 0 ? emissionCount / samples : 0;
  } else if (starless?.maskedPixels) {
    nebRatio = (starless.maskedPixels / Math.max(1, N)) * 5;
  }

  let inferredScene = 'nebula';
  let zNebula = 0.32;
  let depthSpread = 0.62;
  let depthPower = 1.35;
  let occlusion = 0.58;

  if (density > 900 || (density > 600 && nebRatio < 0.08)) {
    // 密集星团 / 广角星野
    inferredScene = density > 900 ? 'cluster' : 'widefield';
    zNebula = 0.15;
    depthSpread = 0.85;
    depthPower = 1.15;
    occlusion = 0.20;
  } else if (nebRatio > 0.09) {
    // 弥漫星云 / 超新星遗迹
    inferredScene = 'nebula';
    zNebula = 0.32;
    depthSpread = 0.62;
    depthPower = 1.35;
    occlusion = 0.58;
  } else if (density < 450) {
    // 河外星系
    inferredScene = 'galaxy';
    zNebula = 0.65;
    depthSpread = 0.50;
    depthPower = 1.80;
    occlusion = 0.65;
  }

  return {
    starScale,
    starGain,
    starColor,
    bloom,
    depthSpread,
    depthPower,
    occlusion,
    zNebula,
    inferredScene,
  };
}

/**
 * Full analysis pass: raster -> Scene (CONTRACTS.md §2.3).
 * The starless plate is returned as an sRGB RGBA buffer at source resolution.
 */
export function analyzeSync(raster, params = {}) {
  const lum = luminance(raster);
  const model = backgroundModel(lum, raster.width, raster.height, { block: params.block || 48 });
  const stars = detectStars(raster, { ...params, lum, model });
  const psf = estimatePsf(stars, raster);
  const depthPlan = assignDepth(stars, params);
  const withDepth = applyDepth(stars, depthPlan, params.seed ?? 1337);
  const starless = buildStarless(raster, stars, params);
  const recommended = recommendStarParams(stars, psf, raster, starless, { lum, model, ...params });
  return {
    width: raster.width,
    height: raster.height,
    stars: withDepth,
    psf,
    starless,
    depth: {
      zNebula: depthPlan.zNebula,
      zStarsNear: depthPlan.zStarsNear,
      zStarsFar: depthPlan.zStarsFar,
      magBright: depthPlan.magBright,
      magFaint: depthPlan.magFaint,
      power: depthPlan.power,
      spread: depthPlan.spread,
    },
    recommended,
    meta: {
      sourceName: raster.meta?.sourceName || 'upload',
      sourceWidth: raster.width,
      sourceHeight: raster.height,
      notes: raster.meta?.notes || [],
    },
  };
}

/** Depth histogram for the UI (12 buckets over 0..1). */
export function depthHistogram(stars, buckets = 12) {
  const hist = new Array(buckets).fill(0);
  for (const s of stars) {
    const i = Math.min(buckets - 1, Math.max(0, Math.floor((s.z ?? 0) * buckets)));
    hist[i]++;
  }
  return hist;
}
