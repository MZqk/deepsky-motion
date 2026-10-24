// Upload + analysis routes.

import path from 'node:path';
import fsp from 'node:fs/promises';
import { readMultipart, sendJson, sendError, sendBuffer, readJsonBody } from '../lib/http.mjs';
import { loadRaster, writeRgbaPng, rasterToPng } from '../lib/imageio.mjs';
import { putSource, getSource, touchSource, previewPathFor, platePathFor, originalPathFor } from '../lib/store.mjs';
import { ensureScene, resceneDepth, sceneSummary } from '../lib/pipeline.mjs';
import { DEFAULT_PARAMS, SERVER } from '../config.mjs';

/** POST /api/upload */
export async function handleUpload(req, res) {
  let parts;
  try {
    parts = await readMultipart(req);
  } catch (err) {
    return sendError(res, err.status || 400, err.message, err.code || 'BAD_UPLOAD');
  }
  const file = parts.files.find((f) => f.name === 'file') || parts.files[0];
  if (!file || !file.data?.length) {
    return sendError(res, 400, '没有收到文件（表单字段名应为 file）', 'NO_FILE');
  }

  const warnings = [];
  let raster;
  try {
    raster = await loadRaster(
      { buffer: file.data, filename: file.filename },
      { maxEdge: SERVER.maxDecodeEdge }
    );
  } catch (err) {
    const msg =
      err.code === 'UNSUPPORTED_FORMAT'
        ? `不支持的文件格式：${file.filename}。支持 PNG / JPG / WebP / TIFF / AVIF / HEIC / FITS。`
        : `无法解码该图像：${err.message}`;
    return sendError(res, 422, msg, err.code || 'DECODE_FAILED');
  }

  if (Math.min(raster.width, raster.height) < 64) {
    warnings.push('图像尺寸很小，星点检测可能不稳定。');
  }
  if (raster.width * raster.height > 24e6) {
    warnings.push('图像很大，分析可能需要几秒钟。');
  }
  for (const n of raster.meta.notes || []) warnings.push(n);

  const rec = putSource({ filename: file.filename, raster, warnings });

  // Cache a preview PNG (downscaled) and the full-size normalized PNG.
  const previewPath = previewPathFor(rec.id);
  const origPath = originalPathFor(rec.id);
  await rasterToPng(raster, previewPath, { longEdge: SERVER.previewEdge });
  await rasterToPng(raster, origPath, { longEdge: null });
  rec.previewPath = previewPath;
  rec.originalPath = origPath;

  return sendJson(res, 200, {
    id: rec.id,
    filename: rec.filename,
    width: rec.width,
    height: rec.height,
    previewUrl: `/api/preview/${rec.id}`,
    sourceUrl: `/api/source/${rec.id}`,
    meta: {
      format: raster.meta.format || 'raster',
      source: raster.meta.source || 'raster',
      bitDepth: raster.meta.bitDepth,
      isLinear: raster.meta.isLinear,
      stretched: !!raster.meta.stretched,
      notes: raster.meta.notes || [],
    },
    warnings,
  });
}

/** GET /api/preview/:id — normalized upload, downscaled. */
export async function handlePreview(res, id, { full = false } = {}) {
  const rec = getSource(id);
  if (!rec) return sendError(res, 404, '未找到该图像，请重新上传', 'NO_SOURCE');
  touchSource(id);
  const p = full ? rec.originalPath : rec.previewPath;
  try {
    const buf = await fsp.readFile(p);
    return sendBuffer(res, 200, buf, { mime: 'image/png', cache: 'private, max-age=600' });
  } catch {
    return sendError(res, 404, '预览图尚未生成', 'NO_PREVIEW');
  }
}

/** GET /api/scene/:id — analyze on demand, then cache. */
export async function handleScene(req, res, id, url) {
  const rec = getSource(id);
  if (!rec) return sendError(res, 404, '未找到该图像，请重新上传', 'NO_SOURCE');
  touchSource(id);

  const q = new URL(url, 'http://localhost').searchParams;
  const params = { ...DEFAULT_PARAMS };
  for (const [k, v] of q.entries()) {
    const n = Number(v);
    if (Number.isFinite(n)) params[k] = n;
  }

  let scene;
  try {
    scene = await ensureScene(rec, params);
  } catch (err) {
    return sendError(res, 500, `分析失败：${err.message}`, 'ANALYZE_FAILED');
  }

  // Produce the starless plate PNG once.
  if (!rec.platePath) {
    rec.platePath = platePathFor(rec.id);
    await writeRgbaPng(scene.starless, rec.platePath, { compressionLevel: 6 });
  }

  const reduced = reduceScene(scene);
  return sendJson(res, 200, {
    scene: reduced,
    previewUrl: `/api/preview/${id}`,
    sourceUrl: `/api/source/${id}`,
    starlessUrl: `/api/scene/${id}/plate.png`,
    plateUrl: `/api/scene/${id}/plate.png`,
    ...sceneSummary(scene),
  });
}

/** GET /api/scene/:id/plate.png — the starless plate. */
export async function handlePlate(res, id) {
  const rec = getSource(id);
  if (!rec) return sendError(res, 404, '未找到该图像', 'NO_SOURCE');
  if (!rec.platePath) return sendError(res, 409, '请先完成分析', 'NOT_ANALYZED');
  try {
    const buf = await fsp.readFile(rec.platePath);
    return sendBuffer(res, 200, buf, { mime: 'image/png', cache: 'private, max-age=600' });
  } catch {
    return sendError(res, 404, '星点去除图层尚未生成', 'NO_PLATE');
  }
}

/** POST /api/scene/:id/params — recompute the depth plan without re-detecting. */
export async function handleSceneParams(req, res, id) {
  const rec = getSource(id);
  if (!rec) return sendError(res, 404, '未找到该图像，请重新上传', 'NO_SOURCE');
  if (!rec.scene) return sendError(res, 409, '请先完成分析', 'NOT_ANALYZED');
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return sendError(res, err.status || 400, err.message, err.code || 'BAD_JSON');
  }
  const params = { ...DEFAULT_PARAMS, ...(body.params || body) };
  const scene = resceneDepth(rec.scene, params);
  rec.scene = scene;
  return sendJson(res, 200, { ok: true, scene: reduceScene(scene), ...sceneSummary(scene) });
}

/** Strip pixel data so the JSON stays small (CONTRACTS §3.8). */
function reduceScene(scene) {
  return {
    width: scene.width,
    height: scene.height,
    stars: scene.stars,
    psf: scene.psf,
    depth: scene.depth,
    starless: { width: scene.starless.width, height: scene.starless.height },
    recommended: scene.recommended,
    meta: scene.meta,
  };
}

export { reduceScene };
