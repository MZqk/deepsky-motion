// HTTP routing helpers: body parsing, JSON responses, static file serving.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { readBody, parseMultipart } from './multipart.mjs';
import { SERVER } from '../config.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.zip': 'application/zip',
  '.fits': 'application/fits',
  '.fit': 'application/fits',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.heic': 'image/heic',
};

export function mimeFor(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

export function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

export function sendError(res, status, message, code = 'ERROR') {
  sendJson(res, status, { error: message, code });
}

export function sendBuffer(res, status, buf, { mime = 'application/octet-stream', filename = null, cache = 'no-store' } = {}) {
  const headers = {
    'content-type': mime,
    'content-length': buf.length,
    'cache-control': cache,
  };
  if (filename) {
    headers['content-disposition'] = `attachment; filename="${filename.replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
  }
  res.writeHead(status, headers);
  res.end(buf);
}

/** Stream a local media file, including single byte ranges for video seeking. */
export async function sendFile(req, res, file, { mime = mimeFor(file), filename = null, cache = 'no-store' } = {}) {
  const handle = await fsp.open(file, 'r');
  try {
    const { size } = await handle.stat();
    let start = 0;
    let end = size - 1;
    const range = req.headers.range;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (match && (match[1] || match[2])) {
        start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
        end = match[1] && match[2] ? Math.min(end, Number(match[2])) : end;
      }
      if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(start) ||
          !Number.isSafeInteger(end) || start < 0 || start > end || start >= size ||
          (!match[1] && Number(match[2]) === 0)) {
        await handle.close();
        res.writeHead(416, { 'content-range': `bytes */${size}` });
        res.end();
        return;
      }
    }
    const headers = {
      'content-type': mime, 'accept-ranges': 'bytes', 'cache-control': cache,
      'content-length': Math.max(0, end - start + 1),
    };
    if (range) headers['content-range'] = `bytes ${start}-${end}/${size}`;
    if (filename) headers['content-disposition'] = `attachment; filename="${filename.replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
    res.writeHead(range ? 206 : 200, headers);
    if (!size || req.method === 'HEAD') {
      await handle.close();
      res.end();
      return;
    }
    const stream = handle.createReadStream({ start, end });
    stream.on('error', (err) => res.destroy(err));
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  } catch (err) {
    await handle.close().catch(() => {});
    throw err;
  }
}

export async function readJsonBody(req, limit = 2 * 1024 * 1024) {
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw Object.assign(new Error('invalid JSON body'), { code: 'BAD_JSON', status: 400 });
  }
}

export async function readMultipart(req, limit = SERVER.maxUploadBytes) {
  const contentType = req.headers['content-type'] || '';
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!boundary) throw Object.assign(new Error('expected multipart/form-data'), { code: 'BAD_CONTENT_TYPE', status: 400 });
  const buf = await readBody(req, limit);
  const b = (boundary[1] || boundary[2] || '').trim();
  return parseMultipart(buf, b);
}

/**
 * Serve a file from `rootDir`, refusing anything that escapes it.
 * Returns true when a response was sent.
 */
export async function serveStatic(res, rootDir, urlPath, { download = false, cache = 'no-cache' } = {}) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel.endsWith('/')) rel += 'index.html';
  const safe = path.normalize(rel).replace(/^([/\\])+/, '');
  const full = path.resolve(rootDir, safe);
  const rootResolved = path.resolve(rootDir);
  if (full !== rootResolved && !full.startsWith(rootResolved + path.sep)) {
    sendError(res, 403, 'forbidden', 'FORBIDDEN');
    return true;
  }
  let st;
  try {
    st = await fsp.stat(full);
  } catch {
    return false;
  }
  if (st.isDirectory()) {
    return serveStatic(res, rootDir, `${safe}/index.html`, { download, cache });
  }
  const buf = await fsp.readFile(full);
  sendBuffer(res, 200, buf, {
    mime: mimeFor(full),
    filename: download ? path.basename(full) : null,
    cache: download ? 'private, max-age=31536000, immutable' : cache,
  });
  return true;
}

export function existsSync(p) {
  return fs.existsSync(p);
}
