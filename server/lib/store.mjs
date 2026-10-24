// In-memory source store: one entry per uploaded image.
// A local single-user tool does not need a database; entries are dropped by LRU.

import fs from 'node:fs';
import path from 'node:path';
import { PATHS, SERVER } from '../config.mjs';

const sources = new Map();
const order = [];
let counter = 0;

export function newId(prefix = 'src') {
  counter += 1;
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}`;
}

export function putSource(entry) {
  const id = entry.id || newId();
  const rec = {
    id,
    filename: entry.filename || 'upload',
    raster: entry.raster,
    width: entry.raster.width,
    height: entry.raster.height,
    meta: entry.meta || {},
    warnings: entry.warnings || [],
    scene: null,
    scenePromise: null,
    platePath: null,
    previewPath: null,
    createdAt: Date.now(),
  };
  sources.set(id, rec);
  order.push(id);
  while (order.length > 12) {
    const old = order.shift();
    sources.delete(old);
    try {
      if (fs.existsSync(previewPathFor(old))) fs.unlinkSync(previewPathFor(old));
      if (fs.existsSync(platePathFor(old))) fs.unlinkSync(platePathFor(old));
      if (fs.existsSync(originalPathFor(old))) fs.unlinkSync(originalPathFor(old));
    } catch {}
  }
  return rec;
}

export function getSource(id) {
  return sources.get(id);
}

export function touchSource(id) {
  const i = order.indexOf(id);
  if (i >= 0) {
    order.splice(i, 1);
    order.push(id);
  }
}

export function previewPathFor(id) {
  return path.join(PATHS.uploads, `${id}.preview.png`);
}

export function platePathFor(id) {
  return path.join(PATHS.uploads, `${id}.plate.png`);
}

export function originalPathFor(id) {
  return path.join(PATHS.uploads, `${id}.orig.png`);
}

export function ensureUploadDir() {
  if (!fs.existsSync(PATHS.uploads)) fs.mkdirSync(PATHS.uploads, { recursive: true });
  return PATHS.uploads;
}

function getDirSize(dir) {
  let total = 0;
  try {
    const files = fs.readdirSync(dir);
    for (const f of files) {
      const p = path.join(dir, f);
      try {
        const st = fs.statSync(p);
        if (st.isDirectory()) total += getDirSize(p);
        else total += st.size;
      } catch {}
    }
  } catch {}
  return total;
}

/**
 * Scans jobs and uploads in workDir, pruning:
 *   1. Entries older than maxAgeMs (default: SERVER.workMaxAgeMs);
 *   2. Oldest entries if total size exceeds maxBytes (default: SERVER.workMaxBytes).
 * Returns { removedCount, freedBytes }.
 */
export function pruneWorkDirectory({
  workDir = PATHS.work,
  maxAgeMs = SERVER.workMaxAgeMs,
  maxBytes = SERVER.workMaxBytes,
  now = Date.now(),
} = {}) {
  let removedCount = 0;
  let freedBytes = 0;
  if (!fs.existsSync(workDir)) return { removedCount, freedBytes };

  const entries = [];
  const dirs = [path.join(workDir, 'jobs'), path.join(workDir, 'uploads')];

  for (const d of dirs) {
    if (!fs.existsSync(d)) continue;
    try {
      const names = fs.readdirSync(d);
      for (const name of names) {
        if (name.startsWith('.')) continue;
        const p = path.join(d, name);
        try {
          const st = fs.statSync(p);
          let size = st.size;
          if (st.isDirectory()) {
            size = getDirSize(p);
          }
          entries.push({ path: p, isDir: st.isDirectory(), mtimeMs: st.mtimeMs, size });
        } catch {}
      }
    } catch {}
  }

  // 1. TTL-based removal
  const keep = [];
  for (const entry of entries) {
    if (now - entry.mtimeMs > maxAgeMs) {
      try {
        if (entry.isDir) fs.rmSync(entry.path, { recursive: true, force: true });
        else fs.unlinkSync(entry.path);
        freedBytes += entry.size;
        removedCount++;
      } catch {}
    } else {
      keep.push(entry);
    }
  }

  // 2. Capacity-based removal (oldest first)
  let currentBytes = keep.reduce((acc, e) => acc + e.size, 0);
  if (currentBytes > maxBytes) {
    keep.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const entry of keep) {
      if (currentBytes <= maxBytes) break;
      try {
        if (entry.isDir) fs.rmSync(entry.path, { recursive: true, force: true });
        else fs.unlinkSync(entry.path);
        freedBytes += entry.size;
        removedCount++;
        currentBytes -= entry.size;
      } catch {}
    }
  }

  return { removedCount, freedBytes };
}

export const LIMITS = {
  maxUploadBytes: SERVER.maxUploadBytes,
  previewEdge: SERVER.previewEdge,
};
