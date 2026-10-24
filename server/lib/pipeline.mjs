// Render/export orchestration: Scene + RenderParams -> artifacts.
//
// One job produces one or more artifacts. The four "live image" targets are
// deliberately different containers (see server/lib/liveimage.mjs), so a user can
// pick whatever their device/album accepts.

import path from 'node:path';
import fsp from 'node:fs/promises';
import { PATHS, workDirFor } from '../config.mjs';
import { analyzeSync, assignDepth, applyDepth, depthHistogram } from './astro.mjs';
import { createFrameSource, createCachedFrameSource, outputSize } from './render.mjs';
import {
  encodeMp4,
  encodeMp4Buffer,
  encodeApng,
  encodeGif,
  encodeAnimatedWebp,
  makePosterJpeg,
  probe,
  which,
} from './encode.mjs';
import { makeLivePhoto, makeMotionPhoto, inspectArtifact } from './liveimage.mjs';
import { addArtifact, setProgress, jobSignal, addWarning } from './job.mjs';
import { previewDirFor } from './preview.mjs';

/** Analyze a source once and cache the Scene on the store record. */
export async function ensureScene(source, params = {}) {
  if (source.scene) return source.scene;
  if (source.scenePromise) return source.scenePromise;
  source.scenePromise = (async () => {
    const scene = analyzeSync(source.raster, params);
    source.scene = scene;
    return scene;
  })();
  return source.scenePromise;
}

/**
 * Re-derive the per-star depth from the current parameters without re-detecting
 * stars. Cheap enough to call on every parameter change.
 */
export function resceneDepth(scene, params = {}) {
  const baseStars = scene.stars.map(({ z, phase, twinkleRate, ...rest }) => rest);
  const plan = assignDepth(baseStars, params);
  const stars = applyDepth(baseStars, plan, params.seed ?? 1337);
  return {
    ...scene,
    stars,
    depth: {
      zNebula: plan.zNebula,
      zStarsNear: plan.zStarsNear,
      zStarsFar: plan.zStarsFar,
      magBright: plan.magBright,
      magFaint: plan.magFaint,
      power: plan.power,
      spread: plan.spread,
    },
  };
}

export function sceneSummary(scene) {
  return {
    psf: scene.psf,
    depth: scene.depth,
    starCount: scene.stars.length,
    depthHistogram: depthHistogram(scene.stars),
    width: scene.width,
    height: scene.height,
    recommended: scene.recommended,
    notes: scene.meta?.notes || [],
  };
}

const FORMATS = new Set(['mp4', 'webp', 'apng', 'gif', 'livephoto', 'motionphoto', 'all']);

export function isSupportedFormat(f) {
  return FORMATS.has(f);
}

export function capabilities() {
  return {
    ffmpeg: !!which(process.env.FFMPEG_PATH || 'ffmpeg'),
    ffprobe: !!which(process.env.FFPROBE_PATH || 'ffprobe'),
    img2webp: !!which('img2webp'),
    sips: !!which('/usr/bin/sips') || !!which('sips'),
    formats: [...FORMATS],
  };
}

/**
 * Run the export. `job` drives progress + artifacts; `signal` cancels.
 * Returns the list of artifacts.
 */
export async function runExport({ job, source, scene, params, format, baseUrl = '/api/artifact', preview = false }) {
  const signal = jobSignal(job);
  const dir = workDirFor('job', job.id);
  const urlBase = `${baseUrl}/${job.id}`;
  const jobScene = resceneDepth(scene, params);

  const wants = (f) => format === 'all' || format === f;
  const isMultiFormat = format === 'all' ||
    (wants('mp4') && (wants('webp') || wants('apng') || wants('gif'))) ||
    (wants('livephoto') || wants('motionphoto'));

  const baseSource = createFrameSource(jobScene, params, {
    signal,
    onProgress: (frac, i, n) => {
      // Rendering shares the bar with encoding: 0..0.62 render, rest encode.
      setProgress(job, frac * 0.62, '渲染帧', `${i}/${n} 帧`);
    },
  });

  const frameSource = isMultiFormat
    ? createCachedFrameSource(baseSource, { workDir: dir, signal })
    : baseSource;

  const { width, height, count, fps } = frameSource;
  job.width = width;
  job.height = height;

  const stamp = Date.now().toString(36);
  const baseName = `web3astra-${stamp}`;
  const artifacts = [];

  const finish = (a) => {
    addArtifact(job, a);
    artifacts.push(a);
    return a;
  };

  try {
    // --- Motion asset: reused by livephoto/motionphoto and mp4 -----------------
  let motionBuffer = null;
  let motionInfo = null;
  const needMotion = wants('mp4') || wants('livephoto') || wants('motionphoto');

  if (needMotion) {
    setProgress(job, 0.62, '编码视频', 'H.264 / MP4');
    if (wants('mp4')) {
      const outPath = path.join(dir, `${baseName}.mp4`);
      motionInfo = await encodeMp4({
        frameSource,
        outPath,
        onProgress: (f, i, n) => setProgress(job, 0.62 + f * 0.24, '编码视频', `${i}/${n} 帧`),
        signal,
      });
      const probed = await probe(outPath);
      finish({
        kind: 'video',
        path: outPath,
        filename: path.basename(outPath),
        url: `${urlBase}/${encodeURIComponent(path.basename(outPath))}`,
        bytes: motionInfo.bytes,
        mime: 'video/mp4',
        detail: {
          format: 'mp4/h264',
          width: motionInfo.width,
          height: motionInfo.height,
          fps: motionInfo.fps,
          frames: count,
          durationSec: Number((count / fps).toFixed(2)),
          probed: probed?.streams?.[0] || null,
          platforms: ['everywhere'],
        },
      });
    } else {
      const enc = await encodeMp4Buffer({
        frameSource,
        onProgress: (f, i, n) => setProgress(job, 0.62 + f * 0.24, '编码视频', `${i}/${n} 帧`),
        signal,
      });
      motionBuffer = enc.buffer;
      motionInfo = enc;
    }
  }

  // --- Animated WebP ---------------------------------------------------------
  if (wants('webp')) {
    setProgress(job, 0.86, '编码动图', 'animated WebP');
    const outPath = path.join(dir, `${baseName}.webp`);
    const info = await encodeAnimatedWebp({
      frameSource,
      outPath,
      onProgress: (f, i, n) => setProgress(job, 0.86 + f * 0.08, '编码动图', `${i}/${n} 帧`),
      signal,
    });
    const verified = await inspectArtifact('webp', outPath);
    finish({
      kind: 'webp',
      path: outPath,
      filename: path.basename(outPath),
      url: `${urlBase}/${encodeURIComponent(path.basename(outPath))}`,
      bytes: info.bytes,
      mime: 'image/webp',
      detail: {
        format: 'animated-webp',
        encoder: info.encoder,
        frames: verified.frames,
        fps: info.fps,
        width: info.width,
        height: info.height,
        loop: 'infinite',
        verified,
        platforms: ['所有现代浏览器', 'iOS 14+', 'Android', 'Windows 10+'],
      },
    });
  }

  // --- APNG ------------------------------------------------------------------
  if (wants('apng')) {
    setProgress(job, 0.9, '编码动图', 'APNG');
    const outPath = path.join(dir, `${baseName}.png`);
    const info = await encodeApng({
      frameSource,
      outPath,
      onProgress: (f, i, n) => setProgress(job, 0.9 + f * 0.05, '编码动图', `${i}/${n} 帧`),
      signal,
    });
    // Lossless APNG is heavy: report the size/rate trade-off honestly.
    if (info.bytes > 24 * 1024 * 1024) {
      addWarning(job, `APNG 为无损格式，本次输出约 ${(info.bytes / 1048576).toFixed(0)} MB（${info.width}x${info.height} @ ${info.fps}fps）。如需更小体积请用动态 WebP 或 MP4。`);
    }
    finish({
      kind: 'apng',
      path: outPath,
      // Must match the file on disk, because `url` (and the download endpoint)
      // resolve against the real basename. A friendly name here would 404.
      filename: path.basename(outPath),
      url: `${urlBase}/${encodeURIComponent(path.basename(outPath))}`,
      bytes: info.bytes,
      mime: 'image/apng',
      detail: {
        format: 'apng',
        fps: info.fps,
        frames: info.frames,
        width: info.width,
        height: info.height,
        loop: 'infinite',
        lossless: true,
        platforms: ['所有浏览器（原生支持）'],
      },
    });
  }

  // --- GIF -------------------------------------------------------------------
  if (wants('gif')) {
    setProgress(job, 0.93, '编码动图', 'GIF');
    const outPath = path.join(dir, `${baseName}.gif`);
    const info = await encodeGif({
      frameSource,
      outPath,
      onProgress: (f, i, n) => setProgress(job, 0.93 + f * 0.03, '编码动图', `${i}/${n} 帧`),
      signal,
    });
    finish({
      kind: 'gif',
      path: outPath,
      filename: path.basename(outPath),
      url: `${urlBase}/${encodeURIComponent(path.basename(outPath))}`,
      bytes: info.bytes,
      mime: 'image/gif',
      detail: {
        format: 'gif',
        fps: info.fps,
        frames: info.frames,
        width: info.width,
        height: info.height,
        platforms: ['everywhere'],
      },
    });
  }

  // --- Live Photo / Motion Photo need a still cover --------------------------
  if (wants('livephoto') || wants('motionphoto')) {
    setProgress(job, 0.94, '生成实况图', '封面帧');
    const posterPath = path.join(dir, `${baseName}.jpg`);
    await makePosterJpeg({ frameSource, outPath: posterPath, quality: 92 });
    const motionPath = path.join(dir, `${baseName}.motion.mp4`);
    await fsp.writeFile(motionPath, motionBuffer || (await fsp.readFile(path.join(dir, `${baseName}.mp4`))));

    if (wants('livephoto')) {
      setProgress(job, 0.96, '生成实况图', 'Live Photo (HEIC + MOV)');
      const outPath = path.join(dir, `${baseName}-livephoto.zip`);
      try {
        const a = await makeLivePhoto({
          previewDir: preview ? previewDirFor(job.id) : null,
          imagePath: posterPath,
          videoPath: motionPath,
          outPath,
          urlBase,
          baseName: `IMG_${stamp.toUpperCase()}`,
          meta: {
            filename: `web3astra-${stamp}-livephoto.zip`,
            width,
            height,
            fps,
            durationSec: count / fps,
          },
        });
        finish(a);
      } catch (err) {
        addWarning(job, `Live Photo 打包失败：${err.message}`);
      }
    }

    if (wants('motionphoto')) {
      setProgress(job, 0.975, '生成实况图', 'Motion Photo (JPEG + MP4)');
      const outPath = path.join(dir, `${baseName}-motionphoto.jpg`);
      try {
        const a = await makeMotionPhoto({
          imagePath: posterPath,
          videoPath: motionPath,
          outPath,
          urlBase,
          meta: { filename: `web3astra-${stamp}-motionphoto.jpg` },
        });
        finish(a);
      } catch (err) {
        addWarning(job, `Motion Photo 打包失败：${err.message}`);
      }
    }
    await fsp.rm(motionPath, { force: true }).catch(() => {});
  }

    setProgress(job, 1, '完成', `${artifacts.length} 个产物`);
    return artifacts;
  } finally {
    if (frameSource.dispose) frameSource.dispose();
  }
}

export { PATHS, outputSize };
