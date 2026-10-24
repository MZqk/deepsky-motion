# Independent Verification — live-image artifacts

**Verifier:** `verify-agent` (adversarial). **Date:** 2026-10-12.
**Revision verified:** the build *after* the Lead's fixes to star colour space (`peakLinear`), APNG
`filename`, auto-stretch gating, the GIF filter chain, WebP `-lossy`, and job rehydration.

**Method.** Every parser below was written from the format specs under `/tmp/verify/`
(`parsers.py`, `verify_all.py`, `sharpframes.mjs`, `final_check.py`). **Nothing is imported from
`server/`.** System tools (`ffprobe`, `sips`, `sharp`, `unzip`, stdlib `zipfile`) are used only as
*second, independent* implementations, never as primary evidence.

**Artifacts under test** — source `samples/nebula-1600.png`, three independent jobs:

| Job | Params | Purpose |
|---|---|---|
| **F** `jmv5d9558y6uk95` | 4 s @ 24 fps, res 960 | full `format=all` suite (primary) |
| **C** `jmv5d2dv21s3kmm` | 2 s @ 15 fps, res 640 | motion-photo offset cross-check |
| **D** `jmv5dcugxfsbf0n` | 6 s @ 30 fps, res 1280 | motion-photo offset cross-check |

**Totals: 58 automated checks per full-job run, across 4 runs (232 checks), with 1 recurring
"failure" that is an ffmpeg limitation, not an app defect.** All six artifact kinds **PASS**.

> Note on earlier revisions: this report previously recorded three defects. All three have since
> been fixed and re-verified — see **Fix Verification** at the end. Findings from the pre-fix
> revision are retained there so the history is auditable.

---

## 1. MP4 — **PASS**

```
ffprobe -v error -print_format json -show_streams -show_format \
  work/jobs/job-jmv5d9558y6uk95/deepsky-motion-mv5d955i.mp4
```
```json
{"codec_name":"h264","profile":"High","width":960,"height":640,
 "avg_frame_rate":"24/1","nb_frames":"96","pix_fmt":"yuv420p","duration":"4.000000"}
format.duration=4.000000  format_name=mov,mp4,m4a,3gp,3g2,mj2
```

Own box walk of the raw bytes (decimal offsets) — **faststart confirmed**:
```
ftyp offset=0     size=32
moov offset=32    size=1946     <-- before mdat
free offset=1978  size=8
mdat offset=1986  size=860165
file bytes 862151
```

Motion check — decoded frames 0 / 48 / 95, hashed the PNGs:
```
sha256[:16] = 6226ff5706c1aedf, be6f8b082ccb4bd2, abde6ad6ece31945   (3 distinct)
```
`nb_frames == fps*duration` (96 == 24×4) ✔ · 8/8 checks PASS.

## 2. Motion Photo JPEG — **PASS**

Own JPEG marker walk on the 960 748-byte file:
```
APP1  offset=2      len=1113   (XMP, ns http://ns.adobe.com/xap/1.0/)
DQT   offset=1117, 1186
SOF0  offset=1255   (960x640, 3 components)
DHT   offset=1274, 1305, 1370, 1398
SOS   offset=1437   len=12
EOI   offset=98595            -> entropy data ends at 98597
```
XMP parsed independently **as XML** (`xml.etree.ElementTree`) — well-formed, root `{adobe:ns:meta/}xmpmeta`:
```
GCamera:MicroVideo="1"  GCamera:MicroVideoVersion="1"
GCamera:MicroVideoOffset="862151"  GCamera:MicroVideoPresentationTimestampUs="0"
Item:Mime="image/jpeg" Item:Semantic="Primary" Item:Length="0"
Item:Mime="video/mp4"  Item:Semantic="Motion"  Item:Length="862151"
```

**The offset is computed, not hardcoded — proven with three clips of different length:**

| Clip | file bytes | MicroVideoOffset | `len-offset` | JPEG EOI ends at | 4 bytes at video start |
|---|---|---|---|---|---|
| F (4 s @24, 960) | 960 748 | **862 151** | 98 597 | 98 597 | `00 00 00 20 66 74 79 70` → `ftyp` |
| C (2 s @15, 640) | 225 967 | **176 372** | 49 595 | 49 595 | `00 00 00 20 66 74 79 70` → `ftyp` |
| D (6 s @30, 1280) | 1 561 586 | **1 399 056** | 162 530 | 162 530 | `00 00 00 20 66 74 79 70` → `ftyp` |

All three offsets are **distinct** and each lands *exactly* on its JPEG EOI boundary, where bytes 4..8
are `ftyp`. A constant could not satisfy all three. ✔

Embedded MP4 extracted at `len-offset` and probed: `h264 960x640 nb_frames=96 duration=4.000000`,
**byte-identical to the standalone `.mp4`** (862 151 == 862 151) ✔. The still part (98 597 bytes)
decodes via `sips` → `pixelWidth 960, pixelHeight 640, format jpeg` ✔. 10/10 PASS.

## 3. Live Photo ZIP — **PASS**

Own ZIP parser walks local headers, the central directory and the EOCD, and **recomputes every CRC32
from the inflated bytes** — the app's stored CRC is never trusted:
```
EOCD offset=922469  n_total=4  cd_size=240  cd_offset=922229  trailing_bytes=0

entry                 method  crc_calc    crc_central  crc_local   match  size
IMG_MV5D955I.HEIC        8    176842be    176842be     176842be    yes    59885
IMG_MV5D955I.MOV         8    494e3cae    494e3cae     494e3cae    yes   862529
metadata.json            8    7458ca5b    7458ca5b     7458ca5b    yes      729
README.txt               8    9bd626e5    9bd626e5     9bd626e5    yes      382
```
All four match in both the local header and the central directory; zero trailing bytes after EOCD.
Corroborated by two further independent implementations: `unzip -t` → *"No errors detected"* and
Python stdlib `zipfile.testzip()` → `None`, with identical CRCs.

Entry set is exactly the four required. `contentIdentifier` = `CD75697A-BF7D-48AC-BFBE-4739879A90E1`
matches the UUID regex, and `still`/`motion` name real entries.

MOV re-parsed by my own box walker and `ffprobe`: `ftyp brand="qt  "`, `moov`, `wide`, `mdat`,
`codec=h264 960x640 nb_frames=96`. Raw byte searches:
```
b"com.apple.quicktime.content.identifier"  -> offset 2078
b"com.apple.quicktime.still-image-time"    -> offset 2034
b"CD75697A-BF7D-48AC-BFBE-4739879A90E1"    -> offset 2283   (same UUID as metadata.json)
```
The `keys` box declares both Apple keys in namespace `mdta`; `ilst` payload for key 4 is ASCII `"0"`
and for key 5 is the UUID string. Still decodes via `sips` (`960x640 heic`) ✔. 16/16 PASS.

## 4. Animated WebP — **PASS** (with an ffmpeg caveat, *not* an app defect)

Own RIFF walker:
```
bytes 0..12 = 52 49 46 46 | size | 57 45 42 50   ("RIFF" ... "WEBP")
riff_size=746080, file=746088  -> size+8 == file length exactly, no trailing bytes
chunk inventory: VP8X x1, ANIM x1, ANMF x96
VP8X flags_byte=0x12 -> ANIMATION (0x02) and ALPHA (0x10) set; canvas 800x532
ANIM  loop_count=0 (infinite)
```
`ANMF` count = **96**, equal to the app-reported frame count and to `4 s × 24 fps`. ✔

**Lossy encoding confirmed** — sub-chunk inventory across all 96 ANMF: `{'VP8 ': 96, 'ALPH': 95}`,
**no `VP8L`** (lossless) chunk anywhere. The explicit `-lossy` flag is taking effect; file is
746 088 bytes rather than the multi-MB lossless output.

**Independent decode (sharp / libwebp)** — `node /tmp/verify/sharpframes.mjs <file>`:
```
pages=96 pageHeight=532 width=800 channels=4 bufferLen=163430400 expectedLen=163430400
distinct frame hashes: 96 of 96
page 0/1/47/95 decoded individually -> distinct PNG hashes
```
A real, independent decoder accepts the file, agrees on 96 frames, and every frame differs. ✔

**Caveat — ffmpeg 8.1.2 cannot demux *any* animated WebP.** `ffprobe`/`ffmpeg` on this file report
`[webp] image data not found`. I treated this as a possible app bug and ran controls:
- a 5-frame animated WebP built by `img2webp` from ffmpeg's own PNGs → **same error**;
- `ffmpeg -demuxers | grep webp` → only `webp_pipe`; `-decoders | grep webp` → only the static decoder;
- the `VP8 ` payload extracted from the app's **own first ANMF**, repackaged as a static WebP →
  `ffprobe` returns `webp,800,532` **OK** and sharp decodes it.

So the failure is ffmpeg's missing animated-WebP support, not a defect in the artifact. Recorded
rather than dropped because the task asked for an ffprobe check: that check is *unverifiable with
this ffmpeg build*, and sharp supplies the required independent decode instead.

Minor observation (not a failure): per-frame delay is 42 ms where 24 fps is 41.667 ms, so 96 frames
total 4032 ms rather than 4000 ms (+0.8%) — `img2webp`'s integer-millisecond rounding.

## 5. APNG — **PASS**

Own chunk walker over all 4 804 chunks with **every CRC32 recomputed** — all valid:
```
IHDR 640x426 bitdepth=8 colortype=6  pHYs  acTL  fcTL x48  IDAT x100  fdAT x4652  IEND
acTL: num_frames=48  num_plays=0
fcTL count = 48 == acTL.num_frames
fcTL+fdAT sequence numbers = 4700 values, contiguous 0..4699, no duplicates
chunk order head: IHDR, pHYs, acTL, fcTL, IDAT...  -> acTL precedes first IDAT, so frame 0 is
                   part of the animation (not a "static fallback" APNG)
```
Frame count 48 == `durationSec × min(fps,12)` = 4×12 ✔. Independent decode:
`ffprobe -count_frames` → `codec=apng nb_read_frames=48 640x426` ✔. Frames 0/24/47 decoded via
ffmpeg → 3 distinct hashes ✔. 9/9 PASS.

## 6. GIF — **PASS**

Own GIF block walker:
```
header b'GIF89a'  logical screen 560x372  GCT=256 entries
walk terminates exactly on trailer 0x3B at offset 6078796 (file 6078797) — no stray bytes
image descriptors = 40 == durationSec × min(fps,10) = 4×10
every frame rect = (0,0,560,372)  (full canvas)
GCE delays: unique {10} == round(100/min(24,10))
```
`ffprobe`: `codec=gif nb_frames=40 560x372` ✔.

**The logical screen (560×372) now equals `detail.width/height`** — the resize is genuinely applied,
and `detail` is derived from the dimensions `pipeRawFrames` actually produced rather than computed
independently, so the two agree exactly (including ffmpeg's even-number rounding: 640 × 560/960 =
373.3 → 372). Pre-fix, `detail` claimed 560×374 while the file was 960×640. Frames 0/20/39 decode to
3 distinct hashes ✔. 6/6 PASS.

---

## 7. HTTP layer — `GET /api/artifact/:jobId/:name`

Headers captured immediately after render, while the job record was still in memory
(`/tmp/verify/final_report.json`).

| kind | served Content-Type | artifact `mime` | Content-Disposition filename | `url` basename | `filename` | Content-Length |
|---|---|---|---|---|---|---|
| video | `video/mp4` | `video/mp4` ✔ | `…mv5d955i.mp4` | same ✔ | same ✔ | == `bytes` ✔ |
| webp | `image/webp` | `image/webp` ✔ | `…mv5d955i.webp` | same ✔ | same ✔ | == `bytes` ✔ |
| apng | `image/png` | `image/apng` *(intentional)* | `…mv5d955i.png` | same ✔ | same ✔ | == `bytes` ✔ |
| gif | `image/gif` | `image/gif` ✔ | `…mv5d955i.gif` | same ✔ | same ✔ | == `bytes` ✔ |
| livephoto | `application/zip` | `application/zip` ✔ | `…-livephoto.zip` | same ✔ | same ✔ | == `bytes` ✔ |
| motionphoto | `image/jpeg` | `image/jpeg` ✔ | `…-motionphoto.jpg` | same ✔ | same ✔ | == `bytes` ✔ |

All six now satisfy `url` basename == `artifact.filename` == `Content-Disposition` filename, and
`Content-Length` == `artifact.bytes`.

**APNG `image/apng` vs served `image/png` — intentional divergence, not scored as a failure.** The
Lead's rationale (accurate semantic type on the artifact, correct wire type for a `.png` file) is
sound: `image/png` is a legal type for an APNG, and a browser rendering an `<img>` needs no more.
I verified the divergence is *deliberate and consistent* rather than an oversight. Two notes for the
record: (a) any client that keys behaviour off `artifact.mime` sees a value the server never sends,
so that field should be documented as descriptive, not authoritative for transport; (b) the
rehydrated archived stub reports `image/png` for the same file, so the two code paths disagree —
see Observation 4. Path-traversal probes (`..%2f…`, `%2e%2e%2f…`) return 404; unknown job → 404
`NO_JOB`; unknown artifact → 404 `NO_ARTIFACT`.

---

# Fix Verification

### Defect 1 — GIF resize silently discarded → **FIXED ✔**

*Original finding:* `encodeGif` passed its palette filter as a literal `-vf` in `outArgs` while
`pipeRawFrames` prepended its own `-vf scale=…`; ffmpeg keeps only the last `-vf`, so the resize was
dropped and GIFs were emitted at full render resolution (960×640 actual, while `detail` claimed
560×374).

*Fix:* `pipeRawFrames` now accepts `extraFilters: []` and composes one `-vf` chain;
`encodeGif` passes the palette filter through it.

*Re-verified:*
- New filter chain validated standalone — `-vf "scale=160:120:flags=lanczos,split[a][b];…"` on a
  320×240 source yields **160×120** (previously 320×240 with the two-`-vf` form).
- End-to-end through the running server, **apples-to-apples at 4 s @24 fps, res 960**: pre-fix
  **14 818 843 B (14.13 MB)** at a wrong 960×640 → post-fix **6 078 797 B (5.80 MB)** at the
  correct 560×372. A separate GIF-only 2 s @12 fps render gave 3 102 391 B at 560×372.
- Full-suite run (job F): independent block walker reports `logical screen 560x372`, every frame
  descriptor `(0,0,560,372)`, `ffprobe` → `gif,560,372,40`.
- **APNG unaffected, as expected** — its `outArgs` never contained a `-vf`, and it still reports
  640×426 matching its `detail`.

### Defect 2 — APNG `filename` did not match the file on disk → **FIXED ✔**

*Original finding:* `pipeline.mjs` set `filename: deepsky-motion-${stamp}-animated.png` while the file on
disk and the `url` were `${baseName}.png`; the served `Content-Disposition` therefore lost the
`-animated` suffix.

*Fix:* `filename` is now `path.basename(outPath)`.

*Re-verified:* across all six kinds, `url` basename == `artifact.filename` == `Content-Disposition`
filename, and the download returns `200` with the correct byte count. The `-animated` suffix no
longer appears anywhere.

### Observation 3 — evicted jobs unreachable → **FIXED ✔**

*Original finding:* `SERVER.jobHistory = 24` evicted finished records from memory, and
`handleArtifact` began with `getJob(jobId)` → 404 `NO_JOB`, leaving files on disk permanently
unreachable.

*Fix:* `getJob()` rehydrates a read-only stub from `work/jobs/job-<id>/`.

*Re-verified:* three jobs created earlier in this session — including two whose records had already
been evicted when I first tested them (I got `404 NO_JOB` then, `200` now) — return
`status: "done"` with their full artifact lists, and `GET /api/artifact/…` returns `200` with
correct types, e.g. `jmv5cb2vd2eui9f/deepsky-motion-mv5cb2vl.gif → 200 image/gif 14818843 B`. Unknown ids
still return `404 NO_JOB`.

Restart survival is demonstrated indirectly rather than by a controlled test I performed: the server
was restarted mid-session by the Lead (the GIF/APNG fixes took effect without me restarting
anything), and jobs created *before* that restart — e.g. `jmv5cb2vd2eui9f` at 22:22 — still
rehydrate afterwards. I did not restart the server myself, since that would have disrupted peers.

---

# Remaining observations (not failures)

### Observation 4 — rehydrated stub disagrees with the live record on APNG mime (minor, new)

The archived stub derives MIME from the file extension, so the same APNG file is reported as
`mime: "image/png"` when rehydrated but `mime: "image/apng"` on the live in-memory record. It also
reports `kind: "archived"` rather than `"apng"`, and carries `detail: {archived: true}` instead of
the format metadata. This is a cosmetic consistency issue in the new rehydration path — the
download itself is correct and the `url`/`filename` agree. Worth aligning if any client branches on
`kind` or `mime`, since a rehydrated job renders differently in the UI than a fresh one.

### Observation 5 — unreachable files still accumulate

`work/jobs/` grows without bound; nothing prunes it. Now that jobs are rehydratable this is less
harmful (the files stay useful), but it is still an unbounded disk-growth path with no eviction
policy. A product decision, not a format bug.

---

# Claims I could NOT verify

1. **ffprobe acceptance of the animated WebP.** ffmpeg 8.1.2 here cannot demux *any* animated WebP
   (proven against an `img2webp` control file, not just the app's output). The independent decode
   requirement was met with **sharp/libwebp** (96 pages, 96 distinct frames). Other ffmpeg builds
   were not tested.
2. **Real-device behaviour.** The Live Photo bundle's structure, CRCs, UUID linkage and MOV/HEIC
   validity are all verified, but there is no iOS/macOS Photos importer available here, so I cannot
   confirm Apple Photos actually accepts the pair (the bundled README itself says a converter is
   required). Google Photos' handling of the Motion Photo JPEG was likewise **not** tested
   end-to-end — only byte-level spec conformance.
3. **Visual/pixel correctness of the render.** I proved frames are decodable and differ from one
   another; I did not evaluate whether the parallax/dolly *looks* right. The Lead's `peakLinear`
   colour-space fix changes frame content substantially, so the frame hashes in this report differ
   from those of the pre-fix revision — that is expected, not a regression.
4. **Determinism** (§2.4, bit-identical frames for fixed Scene + RenderParams) is outside this
   task's scope and was not assessed.

# Reproduce

```bash
python3 /tmp/verify/verify_all.py <jobDir> <durationSec> <fps> <resolution>   # 58 checks/kind-set
python3 /tmp/verify/final_check.py        # render + headers + url/filename/ct/dims agreement
node    /tmp/verify/sharpframes.mjs <file.webp>
```

## Accurate export preview — 2026-10-13

Implemented manual final-artifact preview. The existing export pipeline produces the
actual selected file once; export/download reuses that file. WebGL approximation has
been replaced with video playback or decoded image frames with their encoded timing.

Validation performed:

- `node --test test/*.test.mjs`: 72 passed, zero failures or skips.
- Syntax checks passed for all changed JavaScript modules.
- All six export formats were generated and displayed in the desktop in-app browser.
- MP4 and Motion Photo seeking reached the final frame at 1.917 / 2.000 seconds.
- Animated WebP paused without advancing, sought to 1.909 / 1.992 seconds, and reset
  to 0.000 / 1.992 seconds. These timings came from the actual 24 encoded frames.
- Preview and download URLs referenced the same job and original artifact; exporting
  an already-prepared preview reused the existing result. Export during preparation
  also used the same task.
- A parameter change during generation left the previous preview unchanged and
  reported that the completed result was stale. Canceling a long 2560-pixel render
  did not publish a new preview. No browser warning/error logs were observed.
- Automated tests compared first/middle/last decoded animation frames, variable WebP
  timing and alpha, Motion Photo embedded bytes, Live Photo MOV packet hashes after
  remuxing, valid/invalid byte ranges, resource allowlists and cache cleanup.

Not validated: mobile Photos import, other browser engines, or full 4K/load testing.
Accurate preview requires complete encoding; image-frame preparation also adds temporary
disk usage. Derived resources are disposable, while original exports remain available.
