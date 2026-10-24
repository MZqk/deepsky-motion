// deepsky-motion — local-only deep-sky "dolly-in" studio.
//
// A single-process Node HTTP server bound to 127.0.0.1. No database, no network
// access, no telemetry. Everything (decode, analysis, render, encode, mux) runs
// on this machine with ffmpeg + sharp.

import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { PATHS, SERVER, DEFAULT_PARAMS, CAPS } from './config.mjs';
import { sendJson, sendError, serveStatic } from './lib/http.mjs';
import { handleUpload, handlePreview, handleScene, handlePlate, handleSceneParams } from './routes/upload.mjs';
import { handleRender, handleJob, handleJobEvents, handleJobCancel, handleArtifact, handlePreviewAsset, handlePreviewClear } from './routes/jobs.mjs';
import { capabilities } from './lib/pipeline.mjs';
import { pruneWorkDirectory } from './lib/store.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
void here;

const routes = [];

function route(method, pattern, handler) {
  // pattern: '/api/scene/:id/plate.png'  ->  keys ['id']
  const keys = [];
  let src = '^';
  for (const part of pattern.split('/')) {
    if (!part) continue;
    if (part.startsWith(':')) {
      keys.push(part.slice(1));
      src += '/([^/]+)';
    } else if (part === '*') {
      keys.push('rest');
      src += '/(.*)';
    } else {
      src += '/' + part.replace(/[.+*?^${}()|[\]\\]/g, '\\$&');
    }
  }
  src += '$';
  routes.push({ method, regex: new RegExp(src), keys, handler });
}

// ---- API ------------------------------------------------------------------
route('POST', '/api/upload', async (req, res) => handleUpload(req, res));
route('GET', '/api/preview/:id', async (req, res, p) => handlePreview(res, p.id));
route('GET', '/api/source/:id', async (req, res, p) => handlePreview(res, p.id, { full: true }));
route('GET', '/api/scene/:id/plate.png', async (req, res, p) => handlePlate(res, p.id));
route('GET', '/api/scene/:id', async (req, res, p, url) => handleScene(req, res, p.id, url));
route('POST', '/api/scene/:id/params', async (req, res, p) => handleSceneParams(req, res, p.id));
route('POST', '/api/render', async (req, res) => handleRender(req, res));
route('GET', '/api/jobs/:id/events', async (req, res, p) => handleJobEvents(req, res, p.id));
route('GET', '/api/jobs/:id', async (req, res, p) => handleJob(res, p.id));
route('POST', '/api/jobs/:id/cancel', async (req, res, p) => handleJobCancel(res, p.id));
route('GET', '/api/jobs/:id/preview/:name', async (req, res, p) => handlePreviewAsset(req, res, p.id, p.name));
route('POST', '/api/jobs/:id/preview/clear', async (req, res, p) => handlePreviewClear(res, p.id));
route('GET', '/api/artifact/:jobId/:name', async (req, res, p, url) =>
  handleArtifact(req, res, p.jobId, p.name, { download: !url.includes('inline=1') })
);
route('GET', '/api/health', async (req, res) => {
  const caps = capabilities();
  return sendJson(res, 200, {
    ok: true,
    version: SERVER.version,
    name: 'deepsky-motion',
    platform: CAPS.platform,
    node: CAPS.node,
    cpus: os.cpus().length,
    ffmpeg: caps.ffmpeg,
    ffprobe: caps.ffprobe,
    img2webp: caps.img2webp,
    sips: caps.sips,
    sharp: true,
    defaults: DEFAULT_PARAMS,
    caps: {
      formats: caps.formats,
      liveImages: {
        livephoto: true,
        motionphoto: true,
        webp: true,
        apng: true,
      },
    },
  });
});
route('GET', '/api/defaults', async (req, res) => sendJson(res, 200, { params: DEFAULT_PARAMS }));

const server = http.createServer(async (req, res) => {
  const url = req.url || '/';
  const pathname = url.split('?')[0];

  // Same-origin only, but be permissive for local tooling.
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');

  try {
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.regex.exec(pathname);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => {
        params[k] = decodeURIComponent(m[i + 1]);
      });
      await r.handler(req, res, params, url);
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      // Samples are served so the UI's "示例" button can fetch them.
      if (pathname.startsWith('/samples/')) {
        const served = await serveStatic(res, PATHS.samples, pathname.slice('/samples'.length), {
          cache: 'private, max-age=3600',
        });
        if (served) return;
      }
      const served = await serveStatic(res, PATHS.web, pathname, { cache: 'no-cache' });
      if (served) return;
      // SPA-ish fallback for the app shell.
      if (!pathname.startsWith('/api/')) {
        const fallback = await serveStatic(res, PATHS.web, '/index.html');
        if (fallback) return;
      }
    }

    sendError(res, 404, `未找到路由 ${req.method} ${pathname}`, 'NOT_FOUND');
  } catch (err) {
    const status = err?.status || 500;
    if (!res.headersSent) {
      sendError(res, status, err?.message || '服务器内部错误', err?.code || 'INTERNAL');
    } else {
      res.end();
    }
    if (status >= 500) console.error('[deepsky-motion]', err);
  }
});

server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

export function start(port = SERVER.port, host = SERVER.host) {
  try {
    pruneWorkDirectory();
  } catch {}
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const actual = server.address().port;
      const url = `http://${host}:${actual}`;
      resolve({ server, url, port: actual });
    });
  });
}

export { server };

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const requested = Number(process.env.PORT || SERVER.port);
  start(requested)
    .then(({ url }) => {
      const caps = capabilities();
      console.log('');
      console.log('  deepsky-motion · 深空影像推进工作室');
      console.log(`  ➜  ${url}`);
      console.log(`  work dir: ${PATHS.work}`);
      console.log(
        `  ffmpeg:${caps.ffmpeg ? 'ok' : 'MISSING'}  img2webp:${caps.img2webp ? 'ok' : '-'}  sips:${caps.sips ? 'ok' : '-'}`
      );
      console.log('');
    })
    .catch((err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`端口 ${requested} 已被占用，请用 PORT=其他端口 启动，例如：PORT=8899 pnpm start`);
      } else {
        console.error('启动失败：', err);
      }
      process.exit(1);
    });
}
