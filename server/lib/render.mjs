// Pure software renderer for the dolly-in shot.
//
// The depth illusion is built from four cues, all of them cheap and deterministic:
//   1. DIFFERENTIAL SCALING — every star scales about the frame centre by
//      zoomAt(z, k) = 1 + k * dolly * parallax * depthFactor(z).
//      Near stars (z=0) scale ~1.55x the base dolly, far stars (z=1) ~0.28x.
//      The nebula sits on its own plane (z = depth.zNebula), so the star field
//      visibly shears past it — this is the whole effect.
//   2. INVERSE-SQUARE BRIGHTENING — a star brightens as the camera closes in.
//   3. OCCLUSION — stars behind the nebula dim where the nebula is bright.
//   4. DEPTH-OF-FIELD — a per-frame focus distance blurs stars away from focus.
//
// Colour pipeline: the plate is sRGB, so it is linearised once via LUT, stars are
// accumulated additively in linear light, then the sum is tonemapped and re-encoded.

import fs from 'node:fs';
import path from 'node:path';
import { mulberry32, clamp, lerp } from './astro.mjs';
import { DEFAULT_PARAMS } from '../config.mjs';

// ---------------------------------------------------------------------------
// Colour LUTs
// ---------------------------------------------------------------------------

const LUT_N = 1024;
const SRGB_TO_LIN = new Float32Array(LUT_N + 1);
const LIN_TO_SRGB = new Float32Array(LUT_N + 1);
for (let i = 0; i <= LUT_N; i++) {
  const s = i / LUT_N;
  SRGB_TO_LIN[i] = s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  LIN_TO_SRGB[i] = s <= 0.0031308 ? s * 12.92 : 1.055 * Math.pow(s, 1 / 2.4) - 0.055;
}

function srgbToLin(v) {
  const i = (v * LUT_N) | 0;
  return SRGB_TO_LIN[i < 0 ? 0 : i > LUT_N ? LUT_N : i];
}

function linToSrgbByte(v) {
  if (v <= 0) return 0;
  if (v >= 1) return 255;
  const i = (v * LUT_N) | 0;
  return (LIN_TO_SRGB[i < 0 ? 0 : i > LUT_N ? LUT_N : i] * 255 + 0.5) | 0;
}

const GAUSS_LUT_N = 1024;
const GAUSS_MAX_U = 7.0; // exp(-7.0) ≈ 0.000911 < cutoff threshold 0.0009
const GAUSS_SCALE = GAUSS_LUT_N / GAUSS_MAX_U;
const GAUSS_EXP_LUT = new Float32Array(GAUSS_LUT_N + 1);
for (let i = 0; i <= GAUSS_LUT_N; i++) {
  GAUSS_EXP_LUT[i] = Math.exp(-i / GAUSS_SCALE);
}

/** Fast deterministic exp(-u) for u >= 0 */
export function fastExpNeg(u) {
  if (u >= GAUSS_MAX_U || u < 0) return 0;
  const f = u * GAUSS_SCALE;
  const idx = f | 0;
  const frac = f - idx;
  return GAUSS_EXP_LUT[idx] * (1 - frac) + GAUSS_EXP_LUT[idx + 1] * frac;
}

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------

export const EASES = {
  linear: (t) => t,
  inOut: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
  easeOut: (t) => 1 - Math.pow(1 - t, 3),
  outIn: (t) => (t < 0.5 ? (1 - Math.pow(1 - 2 * t, 3)) / 2 : (1 + Math.pow(2 * t - 1, 3)) / 2),
  easeIn: (t) => t * t * t,
};

/** Depth -> relative dolly multiplier. z=0 nearest, z=1 farthest. */
export function depthFactor(z, parallax = 1) {
  const base = lerp(1.55, 0.28, clamp(z, 0, 1));
  return 1 + (base - 1) * clamp(parallax, 0, 3);
}

/** Zoom applied to a plane at depth z at shot progress k (0..1). */
export function zoomAt(z, k, params) {
  const dolly = params.dolly ?? DEFAULT_PARAMS.dolly;
  const parallax = params.parallax ?? DEFAULT_PARAMS.parallax;
  return 1 + k * dolly * depthFactor(z, parallax);
}

/**
 * Camera state at normalised shot time t (0..1).
 * Returns the eased progress plus a small handheld drift and roll so the move
 * does not read as a sterile digital zoom. The drift is the second depth cue:
 * because it is applied per-star weighted by (1 - z), near stars slide further
 * than far ones even before the zoom kicks in.
 */
export function cameraAt(t, params = {}, scene = null, frame = null) {
  const normT = clamp(t, 0, 1);
  const isPingPong = params.loopMode === 'pingpong';
  const effT = isPingPong ? 1 - Math.abs(2 * normT - 1) : normT;
  const ease = EASES[params.dollyEase] || EASES.inOut;
  const k = ease(clamp(effT, 0, 1));
  const driftAmp = params.drift ?? 0.012; // fraction of the frame's short edge
  const shortEdge = frame ? Math.min(frame.width, frame.height) : 900;
  const amp = driftAmp * shortEdge * (0.35 + 0.65 * k);
  // In pingpong mode, drift frequencies are integer multiples of 2*PI
  // so that t=0 and t=1 evaluate to the exact same sway and roll (seamless loop).
  const angle = isPingPong ? normT * Math.PI * 2 : normT * Math.PI;
  const dx = (Math.sin(angle * 1.0) * 0.6 + Math.sin(angle * 2.0) * 0.4) * amp;
  const dy = (Math.cos(angle * 1.0) * 0.6 + Math.cos(angle * 3.0) * 0.4) * amp * 0.7;
  const roll = Math.sin(angle * 2.0) * (params.roll ?? 0.0);
  const zoom = zoomAt(scene?.depth?.zNebula ?? 0.3, k, params);
  return { t: normT, k, ease: params.dollyEase || 'inOut', scale: zoom, ox: dx, oy: dy, roll, zoom, loopMode: params.loopMode || 'forward' };
}

// ---------------------------------------------------------------------------
// Plate preparation
// ---------------------------------------------------------------------------

/**
 * Resample the starless plate to the render size and store it in LINEAR light.
 * Nearest-neighbour is used on purpose: the plate has already been resized once by
 * sharp with a good kernel, and NN keeps the operation cheap and exactly repeatable.
 */
function preparePlate(scene, width, height) {
  const sw = scene.starless.width;
  const sh = scene.starless.height;
  const src = scene.starless.data;
  const out = new Float32Array(width * height * 3);

  if (sw === width && sh === height) {
    const N = width * height;
    for (let i = 0, s = 0, d = 0; i < N; i++, s += 4, d += 3) {
      out[d] = SRGB_TO_LIN[(src[s] * LUT_N / 255) | 0];
      out[d + 1] = SRGB_TO_LIN[(src[s + 1] * LUT_N / 255) | 0];
      out[d + 2] = SRGB_TO_LIN[(src[s + 2] * LUT_N / 255) | 0];
    }
    return out;
  }

  const sx = (sw - 1) / Math.max(1, width - 1);
  const sy = (sh - 1) / Math.max(1, height - 1);
  for (let y = 0; y < height; y++) {
    const fy = y * sy;
    const y0 = fy | 0;
    const y1 = Math.min(sh - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < width; x++) {
      const fx = x * sx;
      const x0 = fx | 0;
      const x1 = Math.min(sw - 1, x0 + 1);
      const wx = fx - x0;
      const w00 = (1 - wx) * (1 - wy);
      const w10 = wx * (1 - wy);
      const w01 = (1 - wx) * wy;
      const w11 = wx * wy;

      const s00 = (y0 * sw + x0) * 4;
      const s10 = (y0 * sw + x1) * 4;
      const s01 = (y1 * sw + x0) * 4;
      const s11 = (y1 * sw + x1) * 4;

      const r = src[s00] * w00 + src[s10] * w10 + src[s01] * w01 + src[s11] * w11;
      const g = src[s00 + 1] * w00 + src[s10 + 1] * w10 + src[s01 + 1] * w01 + src[s11 + 1] * w11;
      const b = src[s00 + 2] * w00 + src[s10 + 2] * w10 + src[s01 + 2] * w01 + src[s11 + 2] * w11;

      const d = (y * width + x) * 3;
      out[d] = SRGB_TO_LIN[(clamp(r, 0, 255) * LUT_N / 255) | 0];
      out[d + 1] = SRGB_TO_LIN[(clamp(g, 0, 255) * LUT_N / 255) | 0];
      out[d + 2] = SRGB_TO_LIN[(clamp(b, 0, 255) * LUT_N / 255) | 0];
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

function resolveParams(params = {}) {
  const p = { ...DEFAULT_PARAMS, ...params };
  p.durationSec = clamp(p.durationSec, 1, 60);
  p.fps = clamp(Math.round(p.fps), 6, 60);
  p.resolution = clamp(Math.round(p.resolution), 256, 3840);
  p.dolly = clamp(p.dolly, 0, 1);
  p.parallax = clamp(p.parallax, 0, 3);
  p.depthSpread = clamp(p.depthSpread, 0, 1);
  p.depthPower = clamp(p.depthPower, 0.3, 3);
  p.twinkle = clamp(p.twinkle, 0, 1);
  p.starScale = clamp(p.starScale, 0.2, 3);
  p.bloom = clamp(p.bloom, 0, 1);
  p.starGain = clamp(p.starGain, 0, 3);
  p.nebulaGain = clamp(p.nebulaGain, 0, 3);
  p.background = clamp(p.background, 0, 1);
  p.vignette = clamp(p.vignette, 0, 1);
  p.occlusion = clamp(p.occlusion, 0, 1);
  p.focus = clamp(p.focus, 0, 1);
  p.coc = clamp(p.coc, 0, 1);
  p.starColor = clamp(p.starColor ?? DEFAULT_PARAMS.starColor, 0, 2);
  p.loopMode = p.loopMode === 'pingpong' ? 'pingpong' : 'forward';
  return p;
}

/** Output dimensions from a long-edge resolution, preserving the scene aspect. */
export function outputSize(scene, params) {
  const p = resolveParams(params);
  const aspect = scene.width / scene.height;
  let width;
  let height;
  if (aspect >= 1) {
    width = p.resolution;
    height = Math.round(p.resolution / aspect);
  } else {
    height = p.resolution;
    width = Math.round(p.resolution * aspect);
  }
  // Even dimensions keep every encoder happy (yuv420p needs them).
  width += width % 2;
  height += height % 2;
  return { width, height };
}

export function createRenderer(scene, params = {}) {
  const p = resolveParams(params);
  const { width, height } = outputSize(scene, params);
  const N = width * height;

  const plateLin = preparePlate(scene, width, height);

  // Plate luminance at output resolution, used for star occlusion.
  const plateLuma = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    plateLuma[i] = 0.2126 * plateLin[i * 3] + 0.7152 * plateLin[i * 3 + 1] + 0.0722 * plateLin[i * 3 + 2];
  }

  const cx = width / 2;
  const cy = height / 2;
  const scaleX = width / scene.width;
  const scaleY = height / scene.height;
  const fwhmScale = (scaleX + scaleY) / 2;
  const zNebula = scene.depth?.zNebula ?? 0.3;
  const maxRadius = Math.hypot(cx, cy);

  // Star catalogue in output coordinates, with per-star derived quantities baked in.
  const stars = scene.stars.map((s) => {
    // Pinpoint Airy core: compress atmospheric turbulence seeing to compact optical Airy discs (~0.60x)
    const fwhm = clamp(s.fwhm * fwhmScale * p.starScale * 0.60, 0.55, 14);
    return {
      x: s.x * scaleX,
      y: s.y * scaleY,
      z: clamp(s.z ?? 0.5, 0, 1),
      fluxNorm: s.fluxNorm ?? clamp(s.peak ?? 0, 0, 1),
      // `peak` is the star's real measured brightness relative to the brightest
      // star in the frame. The renderer reproduces THAT rather than inventing a
      // brightness curve: the result is a faithful re-rendering of the original
      // field, and the catalogue's own photometry decides how prominent each
      // star looks.
      peak: clamp(s.peak ?? 0, 0, 1),
      // The same peak, in linear light. Stars are composited additively in
      // linear space, so this is what the sprite amplitude must use.
      peakLinear: srgbToLin(clamp(s.peak ?? 0, 0, 1)),
      // Sensor luminance the star contributes at its core, in the same units as
      // the plate. Used to keep the composite from clipping to white.
      measured: clamp(s.peakMeasured ?? s.peak ?? 0, 0, 4),
      fwhm,
      sigma: fwhm / 2.3548200450309493,
      phase: s.phase ?? 0,
      twinkleRate: s.twinkleRate ?? 1,
      cr: lerp(1, (Array.isArray(s.color) ? s.color[0] : 1) ?? 1, p.starColor),
      cg: lerp(1, (Array.isArray(s.color) ? s.color[1] : 1) ?? 1, p.starColor),
      cb: lerp(1, (Array.isArray(s.color) ? s.color[2] : 1) ?? 1, p.starColor),
    };
  });

  // Star radius multiplier normalises total energy so the field does not get
  // brighter or darker when the user changes star size.
  const energyNorm = 1 / Math.max(0.25, p.starScale * p.starScale);

  const acc = new Float32Array(N * 3);
  const starBuf = new Float32Array(N * 3);

  const total = Math.max(1, Math.round(p.durationSec * p.fps));

  function renderFrame(index, totalFrames, out) {
    const n = Math.max(1, totalFrames || total);
    const t = n <= 1 ? 0 : index / (n - 1);
    const cam = cameraAt(t, p, scene, { width, height });
    const k = cam.k;

    // ---- 1. Nebula plate -------------------------------------------------
    const zNeb = zoomAt(zNebula, k, p);
    const zoomBase = zNeb; // plate scale at its own depth
    const invZoom = 1 / zoomBase;
    const nebGain = p.nebulaGain * (1 + 0.22 * (zoomBase - 1)) + p.background * 0.5;
    const bgFloor = p.background * 0.06;
    const cosR = Math.cos(cam.roll);
    const sinR = Math.sin(cam.roll);

    for (let y = 0; y < height; y++) {
      const dy0 = y - cy - cam.oy;
      for (let x = 0; x < width; x++) {
        const dx0 = x - cx - cam.ox;
        const rx = dx0 * cosR - dy0 * sinR;
        const ry = dx0 * sinR + dy0 * cosR;
        const fx = rx * invZoom + cx;
        const fy = ry * invZoom + cy;
        let x0 = fx | 0;
        let y0 = fy | 0;
        let wx = fx - x0;
        let wy = fy - y0;
        if (wx < 0) { x0--; wx += 1; }
        if (wy < 0) { y0--; wy += 1; }
        if (x0 < 0) { x0 = 0; wx = 0; } else if (x0 >= width - 1) { x0 = Math.max(0, width - 2); wx = 1; }
        if (y0 < 0) { y0 = 0; wy = 0; } else if (y0 >= height - 1) { y0 = Math.max(0, height - 2); wy = 1; }
        const x1 = Math.min(width - 1, x0 + 1);
        const y1 = Math.min(height - 1, y0 + 1);
        const w00 = (1 - wx) * (1 - wy);
        const w10 = wx * (1 - wy);
        const w01 = (1 - wx) * wy;
        const w11 = wx * wy;

        const p00 = (y0 * width + x0) * 3;
        const p10 = (y0 * width + x1) * 3;
        const p01 = (y1 * width + x0) * 3;
        const p11 = (y1 * width + x1) * 3;
        const dp = (y * width + x) * 3;

        acc[dp]     = (plateLin[p00] * w00 + plateLin[p10] * w10 + plateLin[p01] * w01 + plateLin[p11] * w11) * nebGain + bgFloor;
        acc[dp + 1] = (plateLin[p00 + 1] * w00 + plateLin[p10 + 1] * w10 + plateLin[p01 + 1] * w01 + plateLin[p11 + 1] * w11) * nebGain + bgFloor;
        acc[dp + 2] = (plateLin[p00 + 2] * w00 + plateLin[p10 + 2] * w10 + plateLin[p01 + 2] * w01 + plateLin[p11 + 2] * w11) * nebGain + bgFloor;
      }
    }

    // ---- 2. Depth of field ----------------------------------------------
    // Two different blur sources, combined:
    //   * `focus` moves the focus plane through the depth range. `focus = 0`
    //     focuses on the nearest star plane, `focus = 1` on the farthest, and the
    //     default 0.5 sits between them (the nebula is near 0.3, so it lands
    //     close to the nebula plane, which is what a real shot would do).
    //   * `coc` is the maximum circle of confusion, i.e. how strong the effect is.
    // Stars whose depth is far from the focus plane get the largest radius.
    // Without this, `focus` was parsed and then ignored, so the WebGL preview
    // (which does implement it) and the exported video disagreed.
    const focusPlane = p.focus;
    const dofStrength = p.coc * 2.6 * (1 + 0.6 * k);

    // ---- 3. Stars --------------------------------------------------------
    starBuf.fill(0);
    const twinkleW = p.twinkle * 0.5;

    for (let si = 0; si < stars.length; si++) {
      const s = stars[si];
      const zf = zoomAt(s.z, k, p);
      const px = cx + (s.x - cx) * zf + cam.ox * (1 - s.z);
      const py = cy + (s.y - cy) * zf + cam.oy * (1 - s.z);

      // Cull off-frame stars (with room for their sprite and bloom).
      const pad = Math.max(s.sigma * 4 + 6, s.fluxNorm > 0.05 ? 64 : 16);
      if (px < -pad || py < -pad || px > width + pad || py > height + pad) continue;

      // Inverse-square-ish brightening as the camera closes in (gentler exponent to avoid bloated stars).
      const bright = p.starGain * Math.pow(zf, 1.20);
      // Twinkle: deterministic, seeded phase, smooth in time.
      const tw = 1 + twinkleW * Math.sin(s.phase + t * Math.PI * 2 * s.twinkleRate * 1.7);
      // A steeper exponent keeps the faint majority genuinely faint; without it
      // 2000 catalogue members all read at similar weight and the field looks
      // like noise rather than a star field.
      // Peak-normalised amplitude, converted into LINEAR light.
      //
      // This conversion is essential and was the source of a real bug: the
      // catalogue's brightness is measured on the sRGB-encoded raster, but the
      // compositor accumulates in linear light (the plate is linearised on
      // upload). Feeding an sRGB value straight into a linear sum makes every
      // faint star roughly 5-8x too bright, and the star field swamps the
      // nebula. `s.peakLinear` is the same measurement after the transfer
      // function.
      let amp = s.peakLinear * bright * tw * energyNorm;

      // Defocus: how far this star's plane is from the focus plane, in 0..1.
      // Tracked per star because the blur is applied per sprite, not globally.
      const defocus = dofStrength > 0.001 ? Math.abs(s.z - focusPlane) : 0;

      // Occlusion: stars behind the nebula fade where the nebula is bright.
      if (p.occlusion > 0.001 && s.z > zNebula) {
        const behind = Math.min(1, (s.z - zNebula) / Math.max(0.02, 1 - zNebula));
        // Sample the plate at the star's screen position.
        const ox = clamp(px | 0, 0, width - 1);
        const oy = clamp(py | 0, 0, height - 1);
        const luma = plateLuma[oy * width + ox];
        amp *= 1 - p.occlusion * behind * clamp(luma * 2.4, 0, 1);
      }
      if (amp <= 0.0004) continue;

      // --- sprite shape ------------------------------------------------------
      // In realistic astrophotography (PixInsight / SpaceEngine), 98%+ of stars are
      // razor-sharp point sources. Only the top ~1-2% brightest stars develop visible
      // optical bloom halos, and their surface brightness is subtle (sub-10% of core).
      const bl = clamp(s.fluxNorm, 0, 1);
      // Defocus widens the core instead of blurring the whole buffer, which keeps
      // in-focus stars sharp while out-of-focus ones soften — that difference is
      // what actually reads as depth of field.
      const sigma0 = Math.max(0.38, s.sigma * (1 + 0.28 * (zf - 1)));
      // Controlled defocus: soft falloff without exploding into massive blurry discs
      const defocusSigma = defocus > 0.001 ? sigma0 * (1 + dofStrength * Math.pow(defocus, 1.3) * 2.2) : sigma0;
      const sigma = defocusSigma;
      // Energy is conserved when the core spreads out, so a defocused star dims.
      const spread = defocus > 0.001 ? sigma0 / sigma : 1;

      const coreRad = Math.min(64, sigma * 3.8);
      const coreRad2 = coreRad * coreRad;
      const inv2s2 = 1 / (2 * sigma * sigma);

      // Soft threshold for bloom: negligible below bl=0.2, gently rising for primary bright stars.
      const bloomFactor = bl > 0.2 ? Math.pow((bl - 0.2) / 0.8, 3.5) : 0;
      const bloomStrength = p.bloom * bloomFactor * spread;
      const bloomSigma = sigma * (2.2 + 2.8 * bl);
      // Halo energy is kept subtle (~8% ratio) to avoid dominating nebula features.
      const bloomAmp = amp * bloomStrength * 0.08;
      const inv2sb = 1 / (2 * bloomSigma * bloomSigma);
      const hasBloom = bloomAmp > 0.0001;
      const bloomRad = hasBloom ? Math.min(84, bloomSigma * 3.8) : 0;
      const bloomRad2 = bloomRad * bloomRad;

      const drawRad = Math.max(coreRad, bloomRad);
      const x0 = Math.max(0, Math.floor(px - drawRad));
      const x1 = Math.min(width - 1, Math.ceil(px + drawRad));
      const y0 = Math.max(0, Math.floor(py - drawRad));
      const y1 = Math.min(height - 1, Math.ceil(py + drawRad));

      const coreAmp = amp * spread;
      const starR = coreAmp * s.cr;
      const starG = coreAmp * s.cg;
      const starB = coreAmp * s.cb;

      for (let y = y0; y <= y1; y++) {
        const dy = y - py;
        const dy2 = dy * dy;
        const row = y * width;
        for (let x = x0; x <= x1; x++) {
          const dx = x - px;
          const r2 = dx * dx + dy2;
          if (r2 > coreRad2 && (!hasBloom || r2 > bloomRad2)) continue;
          let v = 0;
          if (r2 <= coreRad2) v = fastExpNeg(r2 * inv2s2);
          if (hasBloom && r2 <= bloomRad2) v += fastExpNeg(r2 * inv2sb) * (bloomAmp / amp);
          if (v <= 0.0005) continue;
          const dp = (row + x) * 3;
          starBuf[dp] += v * starR;
          starBuf[dp + 1] += v * starG;
          starBuf[dp + 2] += v * starB;
        }
      }
    }

    // ---- 4. Composite stars over the plate --------------------------------
    // Defocus is baked into each sprite's width above, so the star buffer is
    // added directly: in-focus stars stay sharp, out-of-focus ones are soft.
    for (let i = 0; i < acc.length; i++) acc[i] += starBuf[i];

    // ---- 5. Vignette + tonemap + encode ----------------------------------
    const vig = p.vignette;
    const exposure = 1.0;
    for (let y = 0; y < height; y++) {
      const dy = (y - cy) / maxRadius;
      const dy2 = dy * dy;
      for (let x = 0; x < width; x++) {
        const dx = (x - cx) / maxRadius;
        const r2 = dx * dx + dy2;
        const v = vig > 0 ? 1 - vig * Math.pow(r2, 1.15) : 1;
        const i = (y * width + x) * 3;
        const o = (y * width + x) * 4;
        // Filmic-ish tonemap keeps star cores from turning into flat white discs.
        const r = acc[i] * v * exposure;
        const g = acc[i + 1] * v * exposure;
        const b = acc[i + 2] * v * exposure;
        out[o] = linToSrgbByte((r * (1 + r * 0.28)) / (1 + r));
        out[o + 1] = linToSrgbByte((g * (1 + g * 0.28)) / (1 + g));
        out[o + 2] = linToSrgbByte((b * (1 + b * 0.28)) / (1 + b));
        out[o + 3] = 255;
      }
    }
  }

  return {
    width,
    height,
    totalFrames: total,
    params: p,
    stars,
    renderFrame,
  };
}

/** One-shot helper: render frame `index` of `total` into `out` (RGBA). */
export function renderFrame(scene, params, index, total, out) {
  const r = createRenderer(scene, params);
  r.renderFrame(index, total, out);
  return r;
}

/**
 * Build a frameSource suitable for `encode.mjs` (see CONTRACTS.md §3.5).
 * Exposes `renderFrame(i, out)` with a shared RGBA scratch buffer so the encoder
 * can stream frames straight into ffmpeg without extra copies.
 */
export function createFrameSource(scene, params, { onProgress, signal } = {}) {
  const renderer = createRenderer(scene, params);
  const { width, height, totalFrames } = renderer;
  const rgba = new Uint8ClampedArray(width * height * 4);
  return {
    width,
    height,
    fps: renderer.params.fps,
    count: totalFrames,
    durationSec: renderer.params.durationSec,
    renderer,
    renderFrame(i, out) {
      if (signal?.aborted) throw Object.assign(new Error('canceled'), { code: 'CANCELED' });
      const target = out && out.length === rgba.length ? out : rgba;
      renderer.renderFrame(i, totalFrames, target);
      onProgress?.((i + 1) / totalFrames, i + 1, totalFrames);
    },
  };
}

/**
 * Wraps a frameSource with an on-demand frame cache.
 * Avoids redundant re-rendering when exporting multiple formats (e.g. mp4 + webp + apng + gif).
 *
 * @param {Object} frameSource Base frame source with renderFrame(i, out)
 * @param {Object} [opts]
 * @param {string} [opts.workDir] Directory to store the temp frame cache if spilling to disk
 * @param {AbortSignal} [opts.signal] Cancellation signal
 * @param {number} [opts.maxMemoryBytes] Threshold before spilling to disk (default 64MB)
 */
export function createCachedFrameSource(frameSource, opts = {}) {
  const { width, height, count, fps, durationSec } = frameSource;
  const frameBytes = width * height * 4;
  const totalBytes = frameBytes * count;
  const maxMemoryBytes = opts.maxMemoryBytes ?? 64 * 1024 * 1024;
  const signal = opts.signal;
  const workDir = opts.workDir;

  const cached = new Uint8Array(count);
  let memoryBuffers = null;
  let fd = null;
  let filePath = null;
  let disposed = false;
  let hits = 0;
  let misses = 0;

  const useDisk = Boolean(totalBytes > maxMemoryBytes && workDir);

  if (useDisk) {
    filePath = path.join(
      workDir,
      `.frames-cache-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.raw`
    );
    fd = fs.openSync(filePath, 'w+');
  } else {
    memoryBuffers = new Array(count).fill(null);
  }

  const scratch = new Uint8ClampedArray(frameBytes);

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (fd != null) {
      try {
        fs.closeSync(fd);
      } catch {}
      fd = null;
    }
    if (filePath) {
      try {
        fs.unlinkSync(filePath);
      } catch {}
      filePath = null;
    }
    memoryBuffers = null;
  }

  function renderFrame(i, out) {
    if (signal?.aborted) throw Object.assign(new Error('canceled'), { code: 'CANCELED' });
    if (disposed) throw Object.assign(new Error('Frame cache disposed'), { code: 'DISPOSED' });

    const target = out && out.length === frameBytes ? out : scratch;

    if (i < 0 || i >= count) {
      frameSource.renderFrame(i, target);
      return;
    }

    if (cached[i]) {
      hits++;
      if (useDisk && fd != null) {
        const buf = Buffer.from(target.buffer, target.byteOffset, frameBytes);
        fs.readSync(fd, buf, 0, frameBytes, i * frameBytes);
      } else if (memoryBuffers && memoryBuffers[i]) {
        target.set(memoryBuffers[i]);
      }
      return;
    }

    misses++;
    frameSource.renderFrame(i, target);

    if (useDisk && fd != null) {
      const buf = Buffer.from(target.buffer, target.byteOffset, frameBytes);
      fs.writeSync(fd, buf, 0, frameBytes, i * frameBytes);
      cached[i] = 1;
    } else if (memoryBuffers) {
      const copy = new Uint8Array(frameBytes);
      copy.set(target);
      memoryBuffers[i] = copy;
      cached[i] = 1;
    }
  }

  return {
    width,
    height,
    fps,
    count,
    durationSec,
    renderer: frameSource.renderer,
    isCached: true,
    renderFrame,
    dispose,
    getStats() {
      return { hits, misses, count, useDisk, filePath };
    },
  };
}

export { mulberry32, clamp, lerp, srgbToLin, linToSrgbByte };
