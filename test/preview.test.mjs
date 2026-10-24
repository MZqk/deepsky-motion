import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { createJob, cancelJob, runJob, updateJob, snapshot } from '../server/lib/job.mjs';
import { preparePreview, previewDirFor, clearPreview } from '../server/lib/preview.mjs';
import { runExport } from '../server/lib/pipeline.mjs';
import { PATHS } from '../server/config.mjs';
import { which, ffmpegPath, pipeRawFrames } from '../server/lib/encode.mjs';
import { inspectMotionPhoto } from '../server/lib/liveimage.mjs';
import { putSource } from '../server/lib/store.mjs';
import { start } from '../server/index.mjs';
import { frameAtTime, previewKey, PreviewRenderer } from '../web/renderer.js';

const exec = promisify(execFile);
const hasEncoders = which('ffmpeg') && which('ffprobe');

function sceneFixture() {
  const width = 64, height = 48;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    data.set([x * 3, y * 4, (x + y) * 2, 255], i);
  }
  return { width, height, stars: [], depth: { zNebula: 0.3 }, starless: { width, height, data }, meta: {} };
}

function zipMember(bytes, suffix) {
  let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    const method = bytes.readUInt16LE(offset + 8);
    const length = bytes.readUInt32LE(offset + 18);
    const nameLength = bytes.readUInt16LE(offset + 26);
    const extraLength = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 30, offset + 30 + nameLength).toString();
    const begin = offset + 30 + nameLength + extraLength;
    const compressed = bytes.subarray(begin, begin + length);
    if (name.endsWith(suffix)) return method === 8 ? inflateRawSync(compressed) : compressed;
    offset = begin + length;
  }
  throw new Error(`ZIP member not found: ${suffix}`);
}

async function videoHash(file) {
  const { stdout } = await exec(ffmpegPath(), [
    '-v', 'error', '-i', file, '-map', '0:v:0', '-c', 'copy', '-f', 'hash', '-hash', 'sha256', 'pipe:1',
  ]);
  return stdout.trim();
}

async function originalPixels(file) {
  const { stdout } = await exec(ffmpegPath(), [
    '-v', 'error', '-i', file, '-map', '0:v:0', '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1',
  ], { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

test('preview identity includes all parameters, format and source, independent of key order', () => {
  assert.equal(previewKey('a', { fps: 24, seed: 0 }, 'mp4'), previewKey('a', { seed: 0, fps: 24 }, 'mp4'));
  for (const [id, params, format] of [['b', { fps: 24, seed: 0 }, 'mp4'], ['a', { fps: 24, seed: 1 }, 'mp4'], ['a', { fps: 24, seed: 0 }, 'gif']]) {
    assert.notEqual(previewKey('a', { fps: 24, seed: 0 }, 'mp4'), previewKey(id, params, format));
  }
});

test('frame lookup respects variable encoded delays and frame boundaries', () => {
  const starts = [0, 42, 122, 272];
  for (const [time, index] of [[0, 0], [41.9, 0], [42, 1], [121.9, 1], [122, 2], [272, 3], [999, 3]]) {
    assert.equal(frameAtTime(starts, time), index);
  }
});

test('layout preserves portrait source proportions and only scales final frames with CSS', () => {
  const player = {
    manifest: null, scene: null, _plate: { naturalWidth: 600, naturalHeight: 900 },
    canvas: { width: 600, height: 900, style: {}, parentElement: { style: {} } }, video: { style: {} },
  };
  assert.deepEqual(PreviewRenderer.prototype.layout.call(player, 600, 600), { width: 400, height: 600 });
  player.manifest = { width: 800, height: 532 };
  PreviewRenderer.prototype.layout.call(player, 300, 200);
  assert.equal(player.canvas.width, 600);
  assert.equal(player.canvas.height, 900);
  assert.equal(player.canvas.parentElement.style.width, '300px');
});

test('canceled jobs do not start their render body', async () => {
  const job = createJob();
  cancelJob(job.id);
  let called = false;
  await runJob(job, () => { called = true; });
  assert.equal(called, false);
  assert.equal(job.status, 'canceled');
});

test('canceling ffmpeg during input backpressure settles the job without an unhandled pipe error', { skip: !hasEncoders, timeout: 3000 }, async () => {
  const controller = new AbortController();
  const source = { width: 2048, height: 2048, fps: 30, count: 100, renderFrame: (i, out) => out.fill(32) };
  const timer = setTimeout(() => controller.abort(), 1);
  try {
    await assert.rejects(pipeRawFrames(source, ['-f', 'null', '-'], { signal: controller.signal }), { code: 'CANCELED' });
  } finally { clearTimeout(timer); }
});

test('all six formats preview the encoded export and preserve original files', { skip: !hasEncoders }, async (t) => {
  for (const format of ['mp4', 'webp', 'gif', 'apng', 'motionphoto', 'livephoto']) {
    await t.test(format, async () => {
      const job = createJob({ kind: format });
      const dir = path.join(PATHS.jobs, `job-${job.id}`);
      try {
        const artifacts = await runExport({ job, scene: sceneFixture(), params: { resolution: 256, durationSec: 1, fps: 6 }, format, preview: true });
        assert.equal(artifacts.length, 1);
        const artifact = artifacts[0];
        const original = await fsp.readFile(artifact.path);
        const retainedMovie = format === 'livephoto' ? await fsp.readFile(path.join(previewDirFor(job.id), 'motion.mov')) : null;
        const preview = await preparePreview(job, artifact);
        assert.equal(snapshot(job).preview, preview);
        assert.equal(preview.artifactFilename, artifact.filename);
        assert.equal(preview.frameCount, preview.frames.length);
        assert.ok(preview.durationMs > 0);
        if (format === 'mp4') {
          assert.equal(preview.videoUrl, artifact.url + '?inline=1');
          assert.equal(preview.frameCount, 6);
          assert.ok(Math.abs(preview.durationMs - 1000) < 0.01);
        } else if (format === 'motionphoto') {
          const info = inspectMotionPhoto(original);
          assert.deepEqual(await fsp.readFile(path.join(previewDirFor(job.id), 'motion.mp4')), original.subarray(info.videoStart));
        } else if (format === 'livephoto') {
          assert.deepEqual(retainedMovie, zipMember(original, '.MOV'));
          const reference = path.join(dir, 'reference.mov');
          await fsp.writeFile(reference, retainedMovie);
          assert.equal(await videoHash(reference), await videoHash(path.join(previewDirFor(job.id), 'motion.mp4')));
        } else {
          const frameBytes = preview.width * preview.height * 4;
          const reference = format === 'webp' ? null : await originalPixels(artifact.path);
          const metadata = format === 'webp' ? await sharp(artifact.path, { animated: true }).metadata() : null;
          for (const i of [0, Math.floor(preview.frameCount / 2), preview.frameCount - 1]) {
            const decoded = await sharp(path.join(previewDirFor(job.id), `frame-${i}.png`)).ensureAlpha().raw().toBuffer();
            const expected = format === 'webp'
              ? await sharp(artifact.path, { page: i, pages: 1 }).ensureAlpha().raw().toBuffer()
              : reference.subarray(i * frameBytes, (i + 1) * frameBytes);
            assert.deepEqual(decoded, expected);
            if (metadata) assert.equal(preview.frames[i].durationMs, metadata.delay[i]);
          }
        }
        await clearPreview(job);
        assert.equal(job.preview, null);
        await assert.rejects(fsp.access(previewDirFor(job.id)));
        assert.deepEqual(await fsp.readFile(artifact.path), original);
      } finally {
        await fsp.rm(dir, { recursive: true, force: true });
      }
    });
  }
});

test('WebP previews retain transparency and variable delays from the final file', async () => {
  const job = createJob();
  const dir = path.join(PATHS.jobs, `job-${job.id}`);
  await fsp.mkdir(dir, { recursive: true });
  try {
    const images = await Promise.all([0, 1, 2].map((i) => sharp({ create: { width: 8, height: 8, channels: 4, background: { r: i * 60, g: 20, b: 30, alpha: i ? 0.5 : 0 } } }).png().toBuffer()));
    const file = path.join(dir, 'test.webp');
    await sharp(images, { join: { animated: true } }).webp({ lossless: true, delay: [42, 80, 150], loop: 0 }).toFile(file);
    const preview = await preparePreview(job, { kind: 'webp', path: file, filename: 'test.webp' });
    assert.equal(preview.durationMs, 272);
    assert.deepEqual(preview.frames.map((f) => f.durationMs), [42, 80, 150]);
    const first = await sharp(path.join(previewDirFor(job.id), 'frame-0.png')).ensureAlpha().raw().toBuffer();
    assert.equal(first[3], 0);
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test('preview failures and cancellation clean only derived files', async () => {
  for (const canceled of [false, true]) {
    const job = createJob();
    const dir = path.join(PATHS.jobs, `job-${job.id}`);
    await fsp.mkdir(previewDirFor(job.id), { recursive: true });
    const original = path.join(dir, 'original.webp');
    await fsp.writeFile(original, 'not an image');
    await fsp.writeFile(path.join(previewDirFor(job.id), 'temporary.png'), 'partial');
    if (canceled) cancelJob(job.id);
    await assert.rejects(preparePreview(job, { kind: 'webp', path: original }));
    await assert.rejects(fsp.access(previewDirFor(job.id)));
    assert.equal(await fsp.readFile(original, 'utf8'), 'not an image');
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('media routes support ranges, reject unregistered assets and preserve legacy render requests', { skip: !hasEncoders }, async () => {
  const { server, url } = await start(0);
  const job = createJob();
  const dir = path.join(PATHS.jobs, `job-${job.id}`);
  await fsp.mkdir(previewDirFor(job.id), { recursive: true });
  try {
    const bytes = Buffer.from('0123456789');
    await fsp.writeFile(path.join(dir, 'file.mp4'), bytes);
    await fsp.writeFile(path.join(previewDirFor(job.id), 'motion.mp4'), bytes);
    updateJob(job, { status: 'done', preview: { type: 'video' } });
    job._previewFiles = new Set(['motion.mp4']);
    for (const route of [`/api/artifact/${job.id}/file.mp4?inline=1`, `/api/jobs/${job.id}/preview/motion.mp4`]) {
      for (const [range, content, header] of [['bytes=2-5', '2345', 'bytes 2-5/10'], ['bytes=-3', '789', 'bytes 7-9/10'], ['bytes=8-', '89', 'bytes 8-9/10']]) {
        const res = await fetch(url + route, { headers: { Range: range } });
        assert.equal(res.status, 206);
        assert.equal(res.headers.get('content-range'), header);
        assert.equal(await res.text(), content);
      }
      for (const range of ['bytes=20-', 'bytes=-0', 'bytes=5-2', 'bytes=0-1,3-4', 'bytes=-']) {
        const res = await fetch(url + route, { headers: { Range: range } });
        assert.equal(res.status, 416);
        assert.equal(res.headers.get('content-range'), 'bytes */10');
      }
    }
    assert.equal((await fetch(`${url}/api/jobs/${job.id}/preview/not-registered.png`)).status, 404);
    assert.equal((await fetch(`${url}/api/jobs/${job.id}/preview/%2e%2e%2ffile.mp4`)).status, 404);
    assert.equal((await fetch(`${url}/api/artifact/${job.id}/%2e%2e%2ffile.mp4`)).status, 403);
    await fetch(`${url}/api/jobs/${job.id}/preview/clear`, { method: 'POST' });
    assert.equal((await fetch(`${url}/api/jobs/${job.id}/preview/motion.mp4`)).status, 404);
    assert.equal(await (await fetch(`${url}/api/artifact/${job.id}/file.mp4`)).text(), bytes.toString());
    const source = putSource({ raster: { width: 64, height: 48, data: new Float32Array(64 * 48 * 3), meta: {} } });
    source.scene = sceneFixture();
    const request = (body) => fetch(url + '/api/render', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: source.id, params: { resolution: 256, fps: 6, durationSec: 1 }, ...body }) });
    assert.equal((await request({ format: 'all', preview: true })).status, 400);
    const response = await request({ format: 'mp4' });
    assert.equal(response.status, 202);
    const { jobId } = await response.json();
    let done;
    do { done = await (await fetch(`${url}/api/jobs/${jobId}`)).json(); } while (!['done', 'error', 'canceled'].includes(done.status));
    assert.equal(done.status, 'done');
    assert.equal(done.preview, undefined);
    assert.equal(done.artifacts.length, 1);
    await fsp.rm(path.join(PATHS.jobs, `job-${jobId}`), { recursive: true, force: true });
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
