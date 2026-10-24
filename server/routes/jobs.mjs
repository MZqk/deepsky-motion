// Render job routes: create, poll, stream, cancel, download artifacts.

import path from 'node:path';
import { sendJson, sendError, sendFile, readJsonBody, mimeFor } from '../lib/http.mjs';
import { getSource } from '../lib/store.mjs';
import { ensureScene, runExport, isSupportedFormat, capabilities, resceneDepth } from '../lib/pipeline.mjs';
import { createJob, getJob, snapshot, subscribe, cancelJob, runJob, updateJob, jobSignal } from '../lib/job.mjs';
import { preparePreview, previewDirFor, clearPreview } from '../lib/preview.mjs';
import { DEFAULT_PARAMS } from '../config.mjs';
import { PATHS } from '../config.mjs';

const FORMAT_LABEL = {
  mp4: 'MP4 视频',
  webp: '动态 WebP（实况图）',
  apng: 'APNG 动图',
  gif: 'GIF 动图',
  livephoto: 'Apple Live Photo 包',
  motionphoto: 'Google Motion Photo',
  all: '全部格式',
};

/** POST /api/render  body: { id, params, format } */
export async function handleRender(req, res) {
  let body;
  try {
    body = await readJsonBody(req, 1 << 20);
  } catch (err) {
    return sendError(res, err.status || 400, err.message, err.code || 'BAD_JSON');
  }
  const id = body.id || body.sourceId;
  const rec = getSource(id);
  if (!rec) return sendError(res, 404, '未找到该图像，请重新上传', 'NO_SOURCE');

  const format = String(body.format || 'mp4');
  const preview = body.preview === true;
  if (!isSupportedFormat(format) || (preview && format === 'all')) {
    return sendError(res, 400, `不支持的导出格式：${format}`, 'BAD_FORMAT');
  }

  const params = sanitizeParams({ ...DEFAULT_PARAMS, ...(body.params || {}) });
  const caps = capabilities();
  if (!caps.ffmpeg) {
    return sendError(res, 503, '本机未找到 ffmpeg，无法编码视频。请先安装 ffmpeg。', 'NO_FFMPEG');
  }
  if (preview && !caps.ffprobe) {
    return sendError(res, 503, '本机未找到 ffprobe，无法读取准确预览的帧时间。请安装 ffmpeg / ffprobe。', 'NO_FFPROBE');
  }

  let scene;
  try {
    scene = await ensureScene(rec, params);
  } catch (err) {
    return sendError(res, 500, `分析失败：${err.message}`, 'ANALYZE_FAILED');
  }

  const job = createJob({ kind: format, sourceId: id, params });
  job.format = format;
  updateJob(job, { stage: '排队中', message: FORMAT_LABEL[format] || format });

  // Fire and forget; the client polls /api/jobs/:id.
  setImmediate(() => {
    runJob(job, async () => {
      try {
        const artifacts = await runExport({ job, source: rec, scene, params, format, preview });
        if (preview) await preparePreview(job, artifacts[0]);
        return artifacts;
      } finally {
        if (preview && (jobSignal(job).aborted || !job.preview)) await clearPreview(job);
      }
    }).catch((err) => {
      updateJob(job, { status: 'error', error: err?.message || String(err), stage: '失败' });
    });
  });

  return sendJson(res, 202, { jobId: job.id, format, job: snapshot(job) });
}

/** GET /api/jobs/:id */
export function handleJob(res, id) {
  const job = getJob(id);
  if (!job) return sendError(res, 404, '未找到该任务', 'NO_JOB');
  return sendJson(res, 200, snapshot(job));
}

/** GET /api/jobs */
export function handleJobList(res) {
  return sendJson(res, 200, { jobs: [] });
}

/** GET /api/jobs/:id/events — SSE progress stream. */
export function handleJobEvents(req, res, id) {
  const job = getJob(id);
  if (!job) return sendError(res, 404, '未找到该任务', 'NO_JOB');
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(': connected\n\n');
  const unsubscribe = subscribe(id, (snap) => {
    res.write(`data: ${JSON.stringify(snap)}\n\n`);
    if (snap.status === 'done' || snap.status === 'error' || snap.status === 'canceled') {
      res.write('event: end\ndata: {}\n\n');
    }
  });
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => {
    clearInterval(keepAlive);
    unsubscribe();
  });
}

/** POST /api/jobs/:id/cancel */
export function handleJobCancel(res, id) {
  const ok = cancelJob(id);
  return sendJson(res, ok ? 200 : 409, { ok });
}

/** GET /api/artifact/:jobId/:name */
export async function handleArtifact(req, res, jobId, name, { download = true } = {}) {
  const job = getJob(jobId);
  if (!job) return sendError(res, 404, '未找到该任务', 'NO_JOB');
  const safe = path.basename(name);
  if (safe !== name) return sendError(res, 403, 'forbidden', 'FORBIDDEN');
  const dir = path.resolve(PATHS.jobs, `job-${jobId}`);
  const full = path.resolve(dir, safe);
  if (!full.startsWith(dir + path.sep)) return sendError(res, 403, 'forbidden', 'FORBIDDEN');
  try {
    return await sendFile(req, res, full, {
      mime: mimeFor(full),
      filename: download ? safe : null,
      cache: 'private, max-age=86400',
    });
  } catch {
    return sendError(res, 404, '产物不存在或已被清理', 'NO_ARTIFACT');
  }
}

/** Serve only the derived resources registered by a completed preview job. */
export async function handlePreviewAsset(req, res, id, name) {
  const job = getJob(id);
  if (!job || job.status !== 'done' || !job.preview || !job._previewFiles?.has(name) || path.basename(name) !== name) {
    return sendError(res, 404, '预览资源不存在或已清理，请重新生成准确预览', 'NO_PREVIEW');
  }
  try {
    return await sendFile(req, res, path.join(previewDirFor(id), name), { cache: 'private, max-age=86400' });
  } catch {
    return sendError(res, 404, '预览资源不存在或已清理', 'NO_PREVIEW');
  }
}

export async function handlePreviewClear(res, id) {
  const job = getJob(id);
  if (!job) return sendError(res, 404, '未找到该任务', 'NO_JOB');
  if (!['done', 'error', 'canceled'].includes(job.status)) return sendError(res, 409, '任务尚未完成', 'JOB_ACTIVE');
  await clearPreview(job);
  return sendJson(res, 200, { ok: true });
}

function sanitizeParams(p) {
  const out = { ...p };
  out.durationSec = clampNum(out.durationSec, 1, 60, DEFAULT_PARAMS.durationSec);
  out.fps = clampNum(out.fps, 6, 60, DEFAULT_PARAMS.fps);
  out.resolution = clampNum(out.resolution, 256, 3840, DEFAULT_PARAMS.resolution);
  for (const k of ['dolly', 'parallax', 'depthSpread', 'depthPower', 'twinkle', 'starScale', 'bloom', 'starGain', 'nebulaGain', 'background', 'vignette', 'occlusion', 'focus', 'coc']) {
    if (out[k] != null) out[k] = clampNum(out[k], -10, 10, DEFAULT_PARAMS[k]);
  }
  if (typeof out.dollyEase !== 'string') out.dollyEase = DEFAULT_PARAMS.dollyEase;
  out.seed = Math.max(0, Math.floor(Number(out.seed) || DEFAULT_PARAMS.seed));
  return out;
}

function clampNum(v, lo, hi, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
}

export { sanitizeParams, resceneDepth };
