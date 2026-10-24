// Job registry: one in-process queue for render/export work.
// Local single-user tool, so a tiny event-emitter registry is enough — but the
// pipeline is written so a worker thread could take over later.

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { SERVER, PATHS } from '../config.mjs';

const jobs = new Map();
const order = [];

function nowIso() {
  return new Date().toISOString();
}

export function createJob(spec = {}) {
  const id = spec.id || `j${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const job = {
    id,
    kind: spec.kind || 'render',
    status: 'queued',
    progress: 0,
    stage: '排队中',
    message: '',
    artifacts: [],
    warnings: [],
    params: spec.params || {},
    sourceId: spec.sourceId || null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    startedAt: null,
    finishedAt: null,
    error: null,
    _emitter: new EventEmitter(),
    _controller: new AbortController(),
  };
  job._emitter.setMaxListeners(64);
  jobs.set(id, job);
  order.push(id);
  // Keep the in-memory registry bounded. The newest SERVER.jobHistory records
  // stay fully addressable; older ones are dropped from memory but their FILES
  // remain on disk, so `getJob` below rehydrates a stub from the work dir rather
  // than 404ing a download whose bytes are still there.
  while (order.length > SERVER.jobHistory) {
    const old = order.shift();
    const j = jobs.get(old);
    if (j && (j.status === 'done' || j.status === 'error' || j.status === 'canceled')) {
      j._emitter.removeAllListeners();
      jobs.delete(old);
    } else if (j) {
      order.push(old); // still running, keep it
      break;
    }
  }
  return job;
}

export function getJob(id) {
  const live = jobs.get(id);
  if (live) return live;
  // Not in memory. The artifact files may still be on disk — either because the
  // record was evicted by the history cap, or because the server restarted since
  // the job ran. Rehydrate a read-only stub so downloads keep working instead of
  // 404ing on bytes that are still there.
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return undefined;
  const dir = path.join(PATHS.jobs, `job-${id}`);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return undefined;
  }
  const stub = {
    id,
    kind: 'unknown',
    status: 'done',
    progress: 1,
    stage: '已归档',
    message: '该任务的记录已从内存中释放，但产物文件仍可下载。',
    artifacts: [],
    warnings: [],
    params: {},
    sourceId: null,
    createdAt: null,
    updatedAt: null,
    startedAt: null,
    finishedAt: null,
    error: null,
    evicted: true,
    _emitter: new EventEmitter(),
    _controller: new AbortController(),
  };
  for (const name of names) {
    const p = path.join(dir, name);
    try {
      if (!fs.statSync(p).isFile()) continue;
    } catch {
      continue;
    }
    // Report the same `kind`/`mime` a live record would, so a rehydrated job
    // looks identical to the UI. The `archived` flag lives inside `detail` rather
    // than in `kind`, where it would leak into UI logic that switches on kind.
    const mime = mimeForName(name);
    stub.artifacts.push({
      kind: kindForName(name, mime),
      path: p,
      filename: name,
      url: `/api/artifact/${id}/${encodeURIComponent(name)}`,
      bytes: fs.statSync(p).size,
      mime,
      detail: { archived: true, format: 'archived' },
    });
  }
  return stub;
}

/**
 * Map an extension back to the artifact `kind` used by live records, so an
 * archived job's artifacts are shaped like a fresh one.
 * The APNG suffix is inferred from the pipeline's naming: an animated PNG is
 * `<base>.png` alongside no other `.png` in the job dir, but we cannot tell it
 * apart from a poster by name alone — so `.png` maps to `apng`, which is what
 * the pipeline actually writes.
 */
function kindForName(name, mime) {
  const ext = path.extname(name).toLowerCase();
  if (ext === '.mp4' || ext === '.mov') return 'video';
  if (ext === '.webp') return 'webp';
  if (ext === '.png') return 'apng';
  if (ext === '.gif') return 'gif';
  if (ext === '.zip') return 'livephoto';
  if (ext === '.jpg' || ext === '.jpeg') return mime === 'image/jpeg' && name.includes('motionphoto') ? 'motionphoto' : 'poster';
  return 'archived';
}

/** Content type from an extension, for rehydrated (archived) artifacts. */
function mimeForName(name) {
  const map = {
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.png': 'image/apng',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.zip': 'application/zip',
  };
  return map[path.extname(name).toLowerCase()] || 'application/octet-stream';
}

export function listJobs() {
  return order.map((id) => jobs.get(id)).filter(Boolean);
}

export function cancelJob(id) {
  const job = jobs.get(id);
  if (!job) return false;
  if (job.status === 'done' || job.status === 'error' || job.status === 'canceled') return false;
  job._controller.abort();
  updateJob(job, { status: 'canceled', stage: '已取消', message: '用户取消了任务' });
  return true;
}

export function jobSignal(job) {
  return job._controller.signal;
}

export function updateJob(job, patch) {
  Object.assign(job, patch, { updatedAt: nowIso() });
  if (patch.status && !job.startedAt && ['analyzing', 'rendering', 'encoding', 'running'].includes(patch.status)) {
    job.startedAt = nowIso();
  }
  if (['done', 'error', 'canceled'].includes(job.status) && !job.finishedAt) {
    job.finishedAt = nowIso();
  }
  job._emitter.emit('update', snapshot(job));
  return job;
}

export function setProgress(job, progress, stage, message = '') {
  const p = Math.max(0, Math.min(1, progress));
  // Monotonic within a stage so the bar never jumps backwards.
  if (p >= job.progress - 0.001 || stage !== job.stage) {
    updateJob(job, { progress: p, stage, message });
  } else {
    updateJob(job, { stage, message });
  }
}

export function addArtifact(job, artifact) {
  job.artifacts = [...job.artifacts, artifact];
  job._emitter.emit('update', snapshot(job));
  return artifact;
}

export function addWarning(job, warning) {
  job.warnings = [...job.warnings, String(warning)];
  job._emitter.emit('update', snapshot(job));
}

/** Plain serialisable view of a job (no emitter, no controller). */
export function snapshot(job) {
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    progress: Math.round(job.progress * 1000) / 1000,
    stage: job.stage,
    message: job.message,
    artifacts: job.artifacts,
    warnings: job.warnings,
    params: job.params,
    sourceId: job.sourceId,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    error: job.error,
    ...(job.preview ? { preview: job.preview } : {}),
    elapsedMs: job.startedAt ? (job.finishedAt ? Date.parse(job.finishedAt) : Date.now()) - Date.parse(job.startedAt) : 0,
  };
}

export function subscribe(id, cb) {
  const job = jobs.get(id);
  if (!job) return () => {};
  const handler = (snap) => cb(snap);
  job._emitter.on('update', handler);
  cb(snapshot(job));
  return () => job._emitter.off('update', handler);
}

/** Run `fn` as the job body, mapping failures onto the job record. */
export async function runJob(job, fn) {
  if (job._controller.signal.aborted) return { ok: false, canceled: true };
  updateJob(job, { status: 'running', stage: '开始', progress: 0 });
  try {
    const result = await fn(job);
    if (job._controller.signal.aborted) {
      updateJob(job, { status: 'canceled', stage: '已取消' });
      return { ok: false, canceled: true };
    }
    updateJob(job, { status: 'done', progress: 1, stage: '完成', message: '' });
    return { ok: true, result };
  } catch (err) {
    if (job._controller.signal.aborted || err?.code === 'CANCELED') {
      updateJob(job, { status: 'canceled', stage: '已取消', message: '' });
      return { ok: false, canceled: true };
    }
    updateJob(job, {
      status: 'error',
      stage: '失败',
      error: err?.message || String(err),
      message: err?.code ? `(${err.code})` : '',
    });
    return { ok: false, error: err };
  }
}
