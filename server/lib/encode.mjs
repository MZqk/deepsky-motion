// Video encoding. Thin, explicit wrappers around the local ffmpeg / img2webp
// binaries. Nothing here touches the network.
//
// Frame transport: raw RGBA over stdin (`-f rawvideo`). It avoids a PNG
// encode/decode round-trip per frame and is ~4x faster than piping PNGs.
// Animated WebP is the exception — img2webp only reads files, so PNGs are
// written to a temp dir for that path.
//
// Capability notes (verified on this machine, ffmpeg 8.1.2):
//   mp4 (h264) : ffmpeg libx264            -> primary deliverable
//   apng       : ffmpeg apng muxer         -> lossless "live image" for browsers
//   gif        : ffmpeg gif                -> universal fallback
//   webp anim  : ffmpeg has NO webp encoder -> img2webp (libwebp) is primary,
//                sharp's `join.animated` is the in-memory fallback.
//
// frameSource = {
//   count: number,
//   fps: number,
//   width: number, height: number,
//   renderFrame(i, out: Uint8ClampedArray /* w*h*4 RGBA */): void
// }

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ENCODE, tmpDir } from '../config.mjs';

let _ffmpegPath = null;
let _ffprobePath = null;

export function ffmpegPath() {
  if (!_ffmpegPath) _ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';
  return _ffmpegPath;
}

export function ffprobePath() {
  if (!_ffprobePath) _ffprobePath = process.env.FFPROBE_PATH || 'ffprobe';
  return _ffprobePath;
}

/** Resolve an executable through PATH; returns null when missing. */
export function which(bin) {
  if (!bin) return null;
  if (bin.includes('/')) return fs.existsSync(bin) ? bin : null;
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    const p = path.join(d, bin);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

export function runProcess(cmd, args, { onStderr, signal, cwd } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error('canceled'), { code: 'CANCELED' }));
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      const s = d.toString();
      stderr += s;
      onStderr?.(s);
      if (stderr.length > 1 << 20) stderr = stderr.slice(-(1 << 19));
    });
    const onAbort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (err) => {
      signal?.removeEventListener('abort', onAbort);
      reject(Object.assign(new Error(`${cmd} failed to start: ${err.message}`), { code: 'SPAWN_FAILED' }));
    });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(Object.assign(new Error('canceled'), { code: 'CANCELED' }));
      if (code !== 0) {
        return reject(
          Object.assign(new Error(`${path.basename(cmd)} exited ${code}: ${stderr.slice(-1400)}`), {
            code: 'ENCODE_FAILED',
            stderr,
          })
        );
      }
      resolve({ stdout, stderr });
    });
  });
}

const run = runProcess;

/**
 * Pipe raw RGBA frames into ffmpeg. Returns { bytes, frames, width, height }.
 * Frames are rendered lazily and streamed, so memory stays flat.
 *
 * `extraFilters` are appended to the scale filter inside ONE `-vf` chain.
 * Passing a second `-vf` instead would silently win over the first: ffmpeg keeps
 * only the last `-vf`, which is how the GIF palette filter used to drop the
 * resize and emit full-resolution GIFs.
 */
export function pipeRawFrames(frameSource, outArgs, { signal, onProgress, scale = 1, extraFilters = [] } = {}) {
  const { width, height, count, fps } = frameSource;
  const outW = Math.max(2, Math.round(width * scale) & ~1);
  const outH = Math.max(2, Math.round(height * scale) & ~1);
  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    '-f', 'rawvideo',
    '-pixel_format', 'rgba',
    '-video_size', `${width}x${height}`,
    '-framerate', String(fps),
    '-i', 'pipe:0',
  ];
  const filters = [];
  if (outW !== width || outH !== height) filters.push(`scale=${outW}:${outH}:flags=lanczos`);
  for (const f of extraFilters) filters.push(f);

  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error('canceled'), { code: 'CANCELED' }));
    const child = spawn(ffmpegPath(), [...args, ...(filters.length ? ['-vf', filters.join(',')] : []), ...outArgs], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 1 << 20) stderr = stderr.slice(-(1 << 19));
    });
    child.stdout.resume();
    const onAbort = () => { child.stdin.destroy(); child.kill('SIGKILL'); };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdin.on('error', (err) => {
      if (!signal?.aborted) { child.kill('SIGKILL'); reject(err); }
    });

    const rgba = new Uint8ClampedArray(width * height * 4);

    (async () => {
      try {
        for (let i = 0; i < count; i++) {
          if (signal?.aborted) break;
          frameSource.renderFrame(i, rgba);
          const buf = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
          if (!child.stdin.write(buf)) {
            await new Promise((resolve) => {
              // Cancellation closes stdin before it can emit another drain.
              const ready = () => {
                child.stdin.off('drain', ready);
                child.stdin.off('close', ready);
                resolve();
              };
              child.stdin.once('drain', ready);
              child.stdin.once('close', ready);
            });
          }
          onProgress?.((i + 1) / count, i + 1, count);
        }
        child.stdin.end();
      } catch (err) {
        child.stdin.destroy();
        child.kill('SIGKILL');
        reject(err);
      }
    })();

    child.on('error', (err) =>
      reject(Object.assign(new Error(`ffmpeg failed to start: ${err.message}`), { code: 'SPAWN_FAILED' }))
    );
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(Object.assign(new Error('canceled'), { code: 'CANCELED' }));
      if (code !== 0) {
        return reject(
          Object.assign(new Error(`ffmpeg exited ${code}: ${stderr.slice(-1200)}`), { code: 'ENCODE_FAILED', stderr })
        );
      }
      resolve({ stderr, width: outW, height: outH });
    });
  });
}

async function statSize(p) {
  const st = await fsp.stat(p);
  return st.size;
}

let _detectedH264Encoder = null;

export function _resetDetectedH264Encoder() {
  _detectedH264Encoder = null;
}

export function _setDetectedH264Encoder(val) {
  _detectedH264Encoder = val;
}

/**
 * Detect available H.264 encoder, preferring hardware acceleration (e.g. h264_videotoolbox on macOS).
 */
export async function detectH264Encoder({ force = false } = {}) {
  if (_detectedH264Encoder && !force) return _detectedH264Encoder;
  if (process.env.DISABLE_HWACCEL === '1' || process.env.DISABLE_HWACCEL === 'true') {
    _detectedH264Encoder = { name: 'libx264', isHardware: false };
    return _detectedH264Encoder;
  }
  try {
    const { stdout } = await runProcess(ffmpegPath(), ['-hide_banner', '-encoders']);
    const candidates = [];
    if (process.platform === 'darwin') {
      candidates.push('h264_videotoolbox');
    }
    candidates.push('h264_nvenc', 'h264_qsv');

    for (const name of candidates) {
      const regex = new RegExp(`^\\s*V[FS.]{5}\\s+${name}\\b`, 'm');
      if (regex.test(stdout)) {
        _detectedH264Encoder = { name, isHardware: true };
        return _detectedH264Encoder;
      }
    }
  } catch {
    /* fallback to software encoder */
  }
  _detectedH264Encoder = { name: 'libx264', isHardware: false };
  return _detectedH264Encoder;
}

export function getH264EncoderArgs(encoder, { crf, preset, fps, outPath }) {
  if (encoder === 'h264_videotoolbox') {
    return [
      '-c:v', 'h264_videotoolbox',
      '-b:v', '8M',
      '-pix_fmt', 'yuv420p',
      '-profile:v', 'high',
      '-movflags', '+faststart',
      '-r', String(fps),
      '-y', outPath,
    ];
  }
  if (encoder === 'h264_nvenc') {
    return [
      '-c:v', 'h264_nvenc',
      '-preset', 'p4',
      '-cq', String(crf ?? 19),
      '-pix_fmt', 'yuv420p',
      '-profile:v', 'high',
      '-movflags', '+faststart',
      '-r', String(fps),
      '-y', outPath,
    ];
  }
  return [
    '-c:v', 'libx264',
    '-preset', preset,
    '-crf', String(crf),
    '-pix_fmt', 'yuv420p',
    '-profile:v', 'high',
    '-movflags', '+faststart',
    '-r', String(fps),
    '-y', outPath,
  ];
}

/** H.264 MP4 — the primary deliverable. */
export async function encodeMp4({
  frameSource,
  outPath,
  crf = ENCODE.mp4.crf,
  preset = ENCODE.mp4.preset,
  onProgress,
  signal,
  scale = 1,
  preferHardware = true,
}) {
  const { fps, count } = frameSource;
  const detected = preferHardware ? await detectH264Encoder() : { name: 'libx264', isHardware: false };
  let selectedEncoder = detected.name;

  let info;
  try {
    const outArgs = getH264EncoderArgs(selectedEncoder, { crf, preset, fps, outPath });
    info = await pipeRawFrames(frameSource, outArgs, { signal, onProgress, scale });
  } catch (err) {
    if (selectedEncoder !== 'libx264' && err.code !== 'CANCELED' && !signal?.aborted) {
      selectedEncoder = 'libx264';
      const fallbackArgs = getH264EncoderArgs('libx264', { crf, preset, fps, outPath });
      info = await pipeRawFrames(frameSource, fallbackArgs, { signal, onProgress, scale });
    } else {
      throw err;
    }
  }

  return {
    path: outPath,
    bytes: await statSize(outPath),
    width: info.width,
    height: info.height,
    fps,
    frames: count,
    durationSec: count / fps,
    codec: 'h264',
    encoder: selectedEncoder,
  };
}

/** H.264 MP4 into a buffer (used as the motion asset for live images). */
export async function encodeMp4Buffer({ frameSource, crf = 20, preset = ENCODE.mp4.preset, onProgress, signal }) {
  const { fps } = frameSource;
  const dir = await fsp.mkdtemp(path.join(tmpDir('w3amp4'), '-'));
  const outPath = path.join(dir, 'clip.mp4');
  try {
    const info = await encodeMp4({ frameSource, outPath, crf, preset, onProgress, signal });
    return { buffer: await fsp.readFile(outPath), ...info };
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * APNG — lossless animated PNG, plays natively in every browser.
 *
 * Lossless means *large*: a photographic 960x640 frame is ~500 KB of PNG, so a
 * 96-frame clip lands around 50 MB, which is not a deliverable anyone can use.
 * We therefore cap both the frame rate and the output size for this format and
 * report the trade in the artifact detail. Users who want full quality at full
 * size should take the MP4 or the animated WebP.
 */
export async function encodeApng({ frameSource, outPath, onProgress, signal, loops = 0, maxEdge = 640 }) {
  const { fps, width, height } = frameSource;
  const effFps = Math.min(fps, ENCODE.apng.fpsCap);
  const src = decimate(frameSource, effFps);
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  const info = await pipeRawFrames(src, ['-c:v', 'apng', '-plays', String(loops), '-f', 'apng', '-y', outPath], {
    signal,
    onProgress,
    scale,
  });
  return {
    path: outPath,
    bytes: await statSize(outPath),
    width: info.width,
    height: info.height,
    fps: effFps,
    frames: src.count,
    codec: 'apng',
    scale,
  };
}

/** GIF — lowest common denominator fallback. */
export async function encodeGif({ frameSource, outPath, onProgress, signal, loops = 0, maxEdge = ENCODE.gif.maxEdge }) {
  const { fps, width, height } = frameSource;
  const effFps = Math.min(fps, ENCODE.gif.fpsCap);
  const src = decimate(frameSource, effFps);
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  // The palette filter goes through `extraFilters` so it lands in the SAME -vf
  // chain as the scale filter. Supplying it as a separate `-vf` in outArgs made
  // ffmpeg discard the resize (it keeps only the last -vf), so GIFs came out at
  // full render resolution.
  const info = await pipeRawFrames(src, ['-loop', String(loops), '-y', outPath], {
    signal,
    onProgress,
    scale,
    extraFilters: ['split[a][b];[a]palettegen=max_colors=192[p];[b][p]paletteuse=dither=sierra2_4a'],
  });
  return {
    path: outPath,
    bytes: await statSize(outPath),
    width: info.width,
    height: info.height,
    fps: effFps,
    frames: src.count,
    codec: 'gif',
    scale,
  };
}

/** Drop frames so `fps` does not exceed `cap` (keeps playback speed correct). */
function decimate(frameSource, cap) {
  if (frameSource.fps <= cap) return frameSource;
  const step = frameSource.fps / cap;
  const count = Math.max(1, Math.floor(frameSource.count / step));
  return {
    ...frameSource,
    fps: cap,
    count,
    renderFrame: (i, out) => frameSource.renderFrame(Math.min(frameSource.count - 1, Math.round(i * step)), out),
  };
}

/**
 * Animated WebP — the most portable "live image" (iOS 14+, Android, all modern
 * browsers). ffmpeg has no WebP encoder here, so `img2webp` is used when present
 * and sharp's animated join is the fallback.
 */
export async function encodeAnimatedWebp({
  frameSource,
  outPath,
  quality = ENCODE.webp.quality,
  maxEdge = ENCODE.webp.maxEdge,
  onProgress,
  signal,
}) {
  const { width, height } = frameSource;
  const img2webp = which('img2webp');
  // Size budget: cap both the frame rate and the long edge. A 6 s 1280px clip at
  // full rate lands around 40 MB, which is not a shareable "live image".
  const effFps = Math.min(frameSource.fps, ENCODE.webp.fpsCap);
  const src = decimate(frameSource, effFps);
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  const outW = Math.max(2, Math.round(width * scale) & ~1);
  const outH = Math.max(2, Math.round(height * scale) & ~1);
  const { count } = src;
  const delayMs = Math.max(20, Math.round(1000 / effFps));
  const sharp = (await import('sharp')).default;
  const rgba = new Uint8ClampedArray(width * height * 4);
  let pipe = null;

  const pngAt = async (i) => {
    src.renderFrame(i, rgba);
    pipe = sharp(Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength), {
      raw: { width, height, channels: 4 },
    });
    if (scale < 1) pipe = pipe.resize(outW, outH, { kernel: 'lanczos3' });
    return pipe.png({ compressionLevel: 1 }).toBuffer();
  };

  if (img2webp) {
    const dir = await fsp.mkdtemp(path.join(tmpDir('w3awebp'), '-'));
    try {
      const list = [];
      for (let i = 0; i < count; i++) {
        if (signal?.aborted) throw Object.assign(new Error('canceled'), { code: 'CANCELED' });
        const p = path.join(dir, `f${String(i).padStart(5, '0')}.png`);
        await fsp.writeFile(p, await pngAt(i));
        list.push(p);
        onProgress?.(((i + 1) / count) * 0.9, i + 1, count);
      }
      // NOTE 1: this libwebp build does NOT support a `-list.txt` frame list, and
      // it silently exits 1 when given one. Pass the files as arguments instead.
      // For long clips the argument vector gets big but stays far below ARG_MAX.
      // NOTE 2: `-lossless` is img2webp's DEFAULT. Without the explicit `-lossy`
      // flag the `-q` value is ignored entirely and a 6 s clip comes out ~25 MB
      // instead of ~2 MB. This is the single most important flag here.
      await run(
        img2webp,
        ['-loop', '0', '-lossy', '-d', String(delayMs), '-q', String(quality), '-m', '6', '-o', outPath, ...list],
        { signal }
      );
      onProgress?.(1, count, count);
      return {
        path: outPath,
        bytes: await statSize(outPath),
        width: outW,
        height: outH,
        fps: effFps,
        frames: count,
        codec: 'webp-anim',
        encoder: 'img2webp',
      };
    } finally {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  const frames = [];
  for (let i = 0; i < count; i++) {
    if (signal?.aborted) throw Object.assign(new Error('canceled'), { code: 'CANCELED' });
    frames.push(await pngAt(i));
    onProgress?.(((i + 1) / count) * 0.7, i + 1, count);
  }
  const out = await sharp(frames, {
    join: { animated: true, loop: 0, delay: new Array(frames.length).fill(delayMs) },
  })
    .webp({ quality, effort: 3 })
    .toBuffer();
  await fsp.writeFile(outPath, out);
  onProgress?.(1, count, count);
  return {
    path: outPath,
    bytes: out.length,
    width: outW,
    height: outH,
    fps: effFps,
    frames: count,
    codec: 'webp-anim',
    encoder: 'sharp',
  };
}

/** A single JPEG still — the cover image for Live Photo / Motion Photo. */
export async function makePosterJpeg({ frameSource, outPath, quality = ENCODE.posterQuality, index = null }) {
  const sharp = (await import('sharp')).default;
  const { width, height } = frameSource;
  const rgba = new Uint8ClampedArray(width * height * 4);
  frameSource.renderFrame(index == null ? 0 : index, rgba);
  await sharp(Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength), {
    raw: { width, height, channels: 4 },
  })
    .jpeg({ quality, chromaSubsampling: '4:4:4' })
    .toFile(outPath);
  return { path: outPath, bytes: await statSize(outPath), width, height };
}

/** ffprobe a produced file. Returns null when ffprobe is unavailable. */
export async function probe(file) {
  const bin = which(ffprobePath());
  if (!bin) return null;
  try {
    const { stdout } = await run(bin, [
      '-v', 'error',
      '-show_entries', 'stream=codec_name,width,height,nb_frames,duration,avg_frame_rate',
      '-show_entries', 'format=format_name,duration,size',
      '-of', 'json',
      file,
    ]);
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}
