# deepsky-motion — Frozen Interface Contracts (v1)

**Do not change a signature in this file without asking the Lead.** Everything else in your
scope is yours to design. All modules are ESM (`.mjs`), Node >= 20, no TypeScript, no build step.

## 0. Product in one line

Local-only web app. User uploads one deep-sky astrophoto → the app renders a forward-dolly
("推进视角") 3D parallax video in which stars sit on depth shells behind the nebula → user
exports it as a normal video **and** as a "live image" (Apple Live Photo, Google Motion Photo,
and animated WebP).

## 1. Repo layout & ownership

```
server/
  index.mjs              [LEAD]      http server, static, route mount, config
  config.mjs             [LEAD]      paths, limits, constants
  lib/
    imageio.mjs          [LEAD]      decode/normalize any input -> {rgb,width,height}
    fits.mjs             [fits-agent] minimal FITS reader
    astro.mjs            [LEAD]      star detect, PSF, depth, starless, geometry  <-- core
    render.mjs           [LEAD]      pure pixel renderer (used by worker + tests)
    encode.mjs           [LEAD]      ffmpeg wrappers (mp4/apng/webp)
    liveimage.mjs        [LEAD]      Live Photo / Motion Photo / WebP muxing
    job.mjs              [LEAD]      job queue, progress, frame sink, cancel
    stars.mjs            [render-agent] optional: renderer acceleration if needed
  routes/
    upload.mjs           [LEAD]
    analyze.mjs          [LEAD]
    jobs.mjs             [LEAD]
    export.mjs           [LEAD]
web/
  index.html             [web-agent]
  app.js                 [web-agent]
  renderer.js            [web-agent]  final-artifact playback
  styles.css             [web-agent]
  vendor/                [web-agent]  any vendored libs (keep zero-CDN: must work offline)
test/
  *.test.mjs             [whoever owns the module]
tools/
  make-samples.mjs       [sample-agent]  synthetic deep-sky sample generator
samples/                 [sample-agent] generated .fits/.png fixtures
docs/
  CONTRACTS.md           [LEAD]  this file
  LIVEIMAGE.md           [live-agent] research + exact byte layout we implement
  README.md              [LEAD]
```

**Hard rule: one writer per file.** Never edit a file outside your scope. If you need a change
in someone else's file, message the Lead.

## 2. Shared data types

### 2.1 Raster (in-memory image)

```js
/** @typedef {{
 *   data: Float32Array,   // length = width*height*3, interleaved RGB, values 0..1, linear-ish sRGB
 *   width: number,
 *   height: number,
 *   meta: Object          // free-form: {exif, source, bitDepth, isLinear, wcs, ...}
 * }} Raster */
```

`imageio.mjs` is the **only** decoder. Everything downstream consumes `Raster`.

### 2.2 Star

```js
/** @typedef {{
 *   x: number,        // px, sub-pixel, origin top-left
 *   y: number,
 *   flux: number,     // background-subtracted total flux (sum of pixel values above local bg)
 *   peak: number,     // peak brightness 0..1 after normalization
 *   fwhm: number,     // px, from second moments, >= 1.0
 *   ellipticity: number, // 0 = round, 1 = fully elongated
 *   snr: number,
 *   mag: number       // instrumental magnitude = -2.5*log10(flux), lower = brighter
 * }} Star */
```

### 2.3 Scene — the single object passed from analysis to rendering

```js
/** @typedef {{
 *   width: number, height: number,      // render resolution (<= source)
 *   stars: Star[],                      // sorted by flux desc, length <= maxStars
 *   psf: { medianFwhm: number, medianEllipticity: number, starCount: number, density: number },
 *   starless: { data: Uint8ClampedArray, width: number, height: number }, // RGBA, sRGB 0..255
 *   depth: {                            // per-star + global depth plan, all in "scene units"
 *     zNebula: number,                  // 0.0  (nearest plane)
 *     zStarsNear: number,               // e.g. 0.35
 *     zStarsFar: number,                // e.g. 1.0
 *     magBright: number, magFaint: number, // mag range actually used for the mapping
 *     power: number,                    // user knob: depth contrast exponent
 *     spread: number                    // user knob: 0..1 how far apart the shells are
 *   },
 *   meta: { sourceName: string, sourceWidth: number, sourceHeight: number, notes: string[] }
 * }} Scene */
```

### 2.4 RenderParams — user-facing knobs (all optional, defaults live in `config.mjs`)

```js
/** @typedef {{
 *   durationSec: number,     // default 6
 *   fps: number,             // default 30
 *   resolution: number,      // long-edge px, default 1280
 *   dolly: number,           // 0..1 how far the camera pushes in, default 0.45
 *   dollyEase: 'inOut'|'linear'|'outIn'|'easeOut',
 *   parallax: number,        // 0..2 strength multiplier on the star field shift, default 1
 *   depthSpread: number,     // 0..1 -> depth.spread, default 0.6
 *   depthPower: number,      // 0.4..3 -> depth.power, default 1.35
 *   twinkle: number,         // 0..1 brightness shimmer, default 0.25
 *   starScale: number,       // 0.5..2 rendered star size multiplier, default 1
 *   bloom: number,           // 0..1 glow around bright stars, default 0.16
 *   starGain: number,        // 0.2..2 brightness of star layer, default 1
 *   nebulaGain: number,      // 0.2..2 brightness of nebula plate, default 1.05
 *   coc: number,             // 0..1 defocus blur, default 0.06
 *   background: number,      // extra sky-glow brightness 0..1, default 0
 *   vignette: number,        // 0..1, default 0.15
 *   seed: number             // deterministic randomness, default 1337
 * }} RenderParams */
```

**Determinism:** for a fixed `Scene` + `RenderParams`, `renderFrame(i, n)` must be
bit-identical across runs and across processes. Twinkle must be driven by a seeded PRNG
(`mulberry32(seed)`), never `Math.random()`.

### 2.5 Live image artifacts

```js
/** @typedef {{
 *   kind: 'livephoto'|'motionphoto'|'webp'|'video',
 *   path: string,       // absolute path inside work dir
 *   url: string,        // /api/artifact/<jobId>/<basename>
 *   bytes: number,
 *   mime: string,
 *   detail: Object      // free-form per-kind metadata shown in UI
 * }} Artifact */
```

## 3. Module APIs (exact)

### 3.1 `server/lib/imageio.mjs` — LEAD

```js
export async function loadRaster(input, opts = {}): Promise<Raster>
// input: { path?: string, buffer?: Buffer, filename?: string }
// Handles: png jpg jpeg webp tif tiff avif gif bmp heic heif fits fit fts
//  - HEIC/HEIF: sharp may lack the codec -> fall back to `sips -s format png` on darwin,
//    then sharp. If both fail throw Error with code 'UNSUPPORTED_FORMAT'.
//  - FITS: delegate to server/lib/fits.mjs (import lazily so it stays optional).
//  - Auto-stretch: if the image is very dark (median < 0.02) apply an asinh/percentile
//    stretch and record it in meta.notes.
//  - Downscale so max(w,h) <= opts.maxEdge (default 4096) using sharp 'lanczos3'.
export async function loadRasterFromUrl(url): Promise<Raster>
export async function rasterToPng(raster, path, {longEdge} = {}): Promise<void>
export async function rasterToSrgb8(raster): Promise<{data: Uint8ClampedArray, width, height}>
```

### 3.2 `server/lib/fits.mjs` — fits-agent

```js
export function parseFitsHeader(buf: Buffer): { header: Object, dataOffset: number, dataSize: number }
export function readFits(buf: Buffer, opts = {}): {
  data: Float32Array,   // raw sample values, length = naxis1*naxis2 (first HDU with image data)
  width: number, height: number,
  header: Object,       // keys lowercased, values parsed (BITPIX, NAXIS*, BZERO, BSCALE, EXPTIME,
                        // OBJECT, TELESCOP, INSTRUME, FILTER, DATE-OBS, plus WCS: CRPIX1/2, CRVAL1/2,
                        // CDELT1/2 or CD1_1.., CTYPE1/2, RADESYS)
  stats: { min: number, max: number, mean: number, median: number, p1: number, p99: number }
}
export function fitsToRgb(buf: Buffer, opts = {}): Raster   // handles mono, 3-plane RGB, BAYERPAT debayer
export function stretchLinear(arr: Float32Array, opts = {}): Float32Array  // percentile + asinh
export function isFits(buf: Buffer): boolean   // checks 'SIMPLE  =' at offset 0
```
Must handle: 2880-byte block padding, `END` keyword, BITPIX 8/16/32/-32/-64, big-endian,
BZERO/BSCALE, multi-HDU (skip to first image HDU), NAXIS=3 with NAXIS3=3 (RGB).

### 3.3 `server/lib/astro.mjs` — LEAD

```js
export async function analyze(raster, params = {}): Promise<Scene>
export function detectStars(raster, opts = {}): Star[]
export function estimatePsf(stars): { medianFwhm, medianEllipticity, starCount, density }
export function buildStarless(raster, stars, opts = {}): {data:Uint8ClampedArray,width,height}
export function assignDepth(stars, params = {}): Scene['depth'] & { zOf(star): number }
export function sceneFromRaster(raster, params = {}): Promise<Scene>
```

### 3.4 `server/lib/render.mjs` — LEAD

```js
export function renderFrame(scene, params, index, total, out /* Uint8ClampedArray RGBA w*h*4 */): void
export function createRenderer(scene, params): { width, height, renderFrame(i, total, out) }
export function cameraAt(t, params, scene): { scale, ox, oy, zoom }   // t in 0..1
export function mulberry32(seed): () => number
```

### 3.5 `server/lib/encode.mjs` — LEAD

```js
export function ffmpegPath(): string
export async function encodeMp4({frameSource, width, height, fps, outPath, codec, crf, onProgress, signal}): Promise<{path,bytes}>
export async function encodeApng({frameSource, width, height, fps, outPath, onProgress, signal}): Promise<{path,bytes}>
export async function encodeAnimatedWebp({frameSource, width, height, fps, outPath, quality, onProgress, signal}): Promise<{path,bytes}>
export async function encodeGif({frameSource, width, height, fps, outPath, onProgress, signal}): Promise<{path,bytes}>
export async function makePosterJpeg({frameSource, width, height, outPath}): Promise<{path,bytes}>
// frameSource = { count: number, fps: number, getFrame(i): Promise<Buffer|Uint8Array> }  // PNG bytes
```

### 3.6 `server/lib/liveimage.mjs` — LEAD

```js
export async function makeLivePhoto({ imagePath, videoPath, outPath, meta }): Promise<Artifact>
export async function makeMotionPhoto({ imagePath, videoPath, outPath, meta }): Promise<Artifact>
export async function makeAnimatedWebp({ frames, fps, outPath, quality }): Promise<Artifact>
export function readXmp(containerBuf): Object | null     // verification helper
```

### 3.7 `server/lib/job.mjs` — LEAD

```js
export function createJob(spec): Job
export function getJob(id): Job | undefined
export function listJobs(): Job[]
export function cancelJob(id): boolean
// Job: { id, status:'queued'|'analyzing'|'rendering'|'encoding'|'done'|'error'|'canceled',
//        progress:0..1, stage:string, message:string, artifacts:Artifact[], error?:string,
//        createdAt, updatedAt, scene?, params }
export function subscribe(id, cb): () => void
```

### 3.8 HTTP API — LEAD (web-agent consumes exactly this)

```
GET  /                       -> web/index.html
GET  /app.js /renderer.js /styles.css /vendor/*   -> static from web/

POST /api/upload             multipart/form-data field `file`
                             -> { id, filename, width, height, previewUrl, meta, warnings:[] }
GET  /api/preview/:id        -> PNG of the normalized upload (downscaled to <=1600 long edge)
GET  /api/scene/:id          -> { scene, previewUrl, sourceUrl, starlessUrl, plateUrl,
                                  depthHistogram }        (analysis, cached; first call is slow)
                                `scene.starless` is REDUCED to { width, height, url } — pixel data is
                                NOT in the JSON. `starlessUrl === plateUrl` === /api/scene/:id/plate.png
                                `scene.stars[i].z` (0=nearest,1=farthest), `.phase`, `.twinkleRate`
                                are authoritative — the client must use them verbatim.
GET  /api/scene/:id/plate.png -> PNG RGBA starless plate (preview resolution)
GET  /samples/*              -> static files from the repo `samples/` dir
POST /api/scene/:id/params   body: RenderParams -> { ok, scene }          (recompute depth plan)
POST /api/render             body: { id, params, format:'mp4'|'webp'|'apng'|'gif'|'livephoto'|'motionphoto' }
                             -> { jobId }
GET  /api/jobs/:jobId        -> Job  (poll ~4/s)
GET  /api/jobs/:jobId/events -> text/event-stream of Job snapshots
POST /api/jobs/:jobId/cancel -> { ok }
GET  /api/artifact/:jobId/:name -> the file, correct content-type, Content-Disposition attachment
GET  /api/health             -> { ok:true, version, ffmpeg, sharp, caps:{...} }
```

### 3.9 Accurate final-artifact previews

`POST /api/render` additionally accepts `preview: true` for one of the six single formats.
The default remains export-only. Preview requests also require ffprobe; `format: 'all'`
with `preview: true` returns `BAD_FORMAT`. A preview job completes only after its
final encoded artifact and playback resources are ready. Decode failures retain any
successfully exported artifacts, with the job reporting the preview error.

Completed preview jobs include the optional field:

```js
preview: {
  type: 'video' | 'frames',
  artifactFilename: string,
  width: number, height: number,
  durationMs: number, frameCount: number, fps: number,
  frames: Array<{ durationMs: number, url?: string }>,
  videoUrl?: string,
}
```

Frame delays come from the final file, including animation timing quantization.
MP4 uses its original download URL with `inline=1`. Motion Photo playback extracts
the embedded MP4 unchanged. Live Photo playback stream-copies the exact bundled MOV
into MP4; this does not guarantee native Photos import compatibility.

`GET /api/jobs/:jobId/preview/:filename` serves only registered derived media from a
completed job. Media routes support single byte ranges (206), with invalid or
unsatisfiable ranges returning 416. Unknown, cleared or unregistered preview files
return `NO_PREVIEW` (404).

`POST /api/jobs/:jobId/preview/clear` clears only derived playback resources from a
terminal job; active jobs return 409. Original artifacts remain downloadable.
Clients bind previews to the source, complete parameter snapshot and selected format,
ignore stale results, reuse matching tasks for export, and clear the preceding derived
cache after a replacement preview loads successfully.

Errors: HTTP 4xx/5xx with `{ error: string, code: string }`.

## 4. Style / quality bar

- Node ESM, 2-space indent, no semicolon-free style, `const`/`let` only.
- Every module exports pure functions where possible; side effects only in `server/index.mjs`, `job.mjs`.
- No network access at runtime. No CDN. No telemetry. Bind to `127.0.0.1` only.
- Unit tests with `node:test` + `node:assert/strict`. `pnpm test` must pass.
- Never commit binary blobs > 2 MB into `web/vendor`; vendor only small libs.
