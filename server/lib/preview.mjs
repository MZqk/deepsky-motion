// Accurate previews decode the delivered artifact; they never re-render a scene.
import path from 'node:path';
import fsp from 'node:fs/promises';
import sharp from 'sharp';
import { PATHS } from '../config.mjs';
import { ffmpegPath, ffprobePath, runProcess } from './encode.mjs';
import { inspectMotionPhoto } from './liveimage.mjs';
import { jobSignal, setProgress, updateJob } from './job.mjs';

export function previewDirFor(id) {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('Invalid job ID');
  return path.join(PATHS.jobs, `job-${id}`, 'preview');
}

function checkCanceled(signal) {
  signal.throwIfAborted();
}

async function probeFrames(file, signal) {
  const { stdout } = await runProcess(ffprobePath(), [
    '-v', 'error', '-select_streams', 'v:0', '-show_frames', '-show_streams',
    '-show_entries', 'stream=width,height,avg_frame_rate,duration,nb_frames:frame=best_effort_timestamp_time,duration_time,pkt_duration_time',
    '-of', 'json', file,
  ], { signal });
  checkCanceled(signal);
  const data = JSON.parse(stdout);
  const stream = data.streams?.[0];
  if (!stream || !data.frames?.length) throw new Error('No decodable preview frames');
  const [num, den] = String(stream.avg_frame_rate).split('/').map(Number);
  const fallback = num > 0 && den > 0 ? 1000 * den / num : null;
  const delays = data.frames.map((frame, i, frames) => {
    const next = frames[i + 1];
    const interval = next ? (Number(next.best_effort_timestamp_time) - Number(frame.best_effort_timestamp_time)) * 1000 : NaN;
    const recorded = Number(frame.duration_time ?? frame.pkt_duration_time) * 1000;
    const delay = interval > 0 ? interval : recorded > 0 ? recorded : fallback;
    if (!(delay > 0) || !Number.isFinite(delay)) throw new Error('Missing preview frame timing');
    return delay;
  });
  return { width: stream.width, height: stream.height, delays };
}

/** Remove only derived media, preserving every original export. */
export async function clearPreview(job) {
  if (!job || !/^[A-Za-z0-9_-]+$/.test(job.id)) return;
  // Invalidate URLs before unlinking files, including an already-open tab.
  if (job.preview) updateJob(job, { preview: null });
  await fsp.rm(previewDirFor(job.id), { recursive: true, force: true });
}

/** Prepare one selected artifact, recording an allowlist for its media URLs. */
export async function preparePreview(job, artifact) {
  const signal = jobSignal(job);
  const dir = previewDirFor(job.id);
  const url = (name) => `/api/jobs/${job.id}/preview/${encodeURIComponent(name)}`;
  setProgress(job, 0, '准备预览', '解码最终产物');
  try {
    checkCanceled(signal);
    if (!artifact) throw new Error('The selected format did not produce an artifact');
    await fsp.mkdir(dir, { recursive: true });
    let media = artifact.path;
    let videoUrl = null;
    const files = new Set();

    if (artifact.kind === 'motionphoto') {
      const bytes = await fsp.readFile(media);
      const info = inspectMotionPhoto(bytes);
      if (!info.ok) throw new Error('Invalid Motion Photo video offset');
      media = path.join(dir, 'motion.mp4');
      await fsp.writeFile(media, bytes.subarray(info.videoStart));
      files.add('motion.mp4');
      videoUrl = url('motion.mp4');
    } else if (artifact.kind === 'livephoto') {
      // liveimage writes the same MOV bytes that it puts into the ZIP here.
      media = path.join(dir, 'motion.mp4');
      await runProcess(ffmpegPath(), [
        '-hide_banner', '-loglevel', 'error', '-i', path.join(dir, 'motion.mov'),
        '-map', '0:v:0', '-c', 'copy', '-movflags', '+faststart', '-y', media,
      ], { signal });
      files.add('motion.mp4');
      videoUrl = url('motion.mp4');
      await fsp.unlink(path.join(dir, 'motion.mov'));
    } else if (artifact.kind === 'video') {
      videoUrl = `${artifact.url}?inline=1`;
    }

    let timing;
    if (artifact.kind === 'webp') {
      const meta = await sharp(media, { animated: true }).metadata();
      if (!meta.pages || meta.delay?.length !== meta.pages || meta.delay.some((d) => !(d > 0))) {
        throw new Error('Invalid animated WebP frame timing');
      }
      timing = { width: meta.width, height: meta.pageHeight || meta.height, delays: meta.delay };
      for (let i = 0; i < meta.pages; i++) {
        checkCanceled(signal);
        const name = `frame-${i}.png`;
        await sharp(media, { page: i, pages: 1 }).png().toFile(path.join(dir, name));
        files.add(name);
        setProgress(job, (i + 1) / meta.pages, '准备预览', `${i + 1}/${meta.pages} 帧`);
      }
    } else {
      timing = await probeFrames(media, signal);
      if (!videoUrl) {
        await runProcess(ffmpegPath(), [
          '-hide_banner', '-loglevel', 'error', '-i', media,
          '-map', '0:v:0', '-fps_mode', 'passthrough', '-start_number', '0',
          '-pix_fmt', 'rgba', '-y', path.join(dir, 'frame-%d.png'),
        ], { signal });
        for (let i = 0; i < timing.delays.length; i++) {
          const name = `frame-${i}.png`;
          await fsp.access(path.join(dir, name));
          files.add(name);
        }
      }
    }
    checkCanceled(signal);
    const durationMs = timing.delays.reduce((a, b) => a + b, 0);
    const preview = {
      type: videoUrl ? 'video' : 'frames', artifactFilename: artifact.filename,
      width: timing.width, height: timing.height, durationMs,
      frameCount: timing.delays.length, fps: timing.delays.length * 1000 / durationMs,
      frames: timing.delays.map((durationMs, i) => ({ durationMs, ...(videoUrl ? {} : { url: url(`frame-${i}.png`) }) })),
      ...(videoUrl ? { videoUrl } : {}),
    };
    job._previewFiles = files;
    updateJob(job, { preview });
    setProgress(job, 1, '准备预览', '准确预览已就绪');
    return preview;
  } catch (err) {
    await clearPreview(job);
    throw err;
  }
}
