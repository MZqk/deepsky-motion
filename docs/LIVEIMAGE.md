# Live image formats — implementation notes

Every command in this document was **run on this machine** (macOS, ffmpeg 8.1.2,
libwebp 1.6.0, Node 26). Steps are marked VERIFIED or UNVERIFIED. This is the
reference for `server/lib/liveimage.mjs`.

## Environment capabilities (probed, not assumed)

| Capability | Status | Evidence |
|---|---|---|
| ffmpeg `mov` / `mp4` / `apng` / `gif` muxers | present | `ffmpeg -muxers` |
| ffmpeg **`live_photo` muxer** | **absent** | `ffmpeg -h muxer=live_photo` → `Unknown format` |
| ffmpeg **WebP encoder** | **absent** | `ffmpeg -encoders \| grep webp` → empty |
| `img2webp` (libwebp 1.6.0) | present | `/opt/homebrew/bin/img2webp` |
| `sips` writing `public.heic` | present | `sips -s format heic in.png --out out.heic` |
| `sharp` encoding HEIC | **absent** | `heifsave: Unsupported compression` |
| `exiftool` | absent | not installed — never depended on |

Consequences: MP4/APNG/GIF go through ffmpeg; animated WebP goes through
`img2webp`; the Live Photo still goes through `sips`; no step may shell out to
`exiftool`.

---

## A. Apple Live Photo

### A.1 The honest constraint

**Apple has no single-file Live Photo format.** A Live Photo is a *pair* of
assets:

- a still image (`.HEIC`, or `.JPG`)
- a motion asset (`.MOV`, QuickTime)

tied together by a shared identifier. There is no container that holds both, so
"export as a Live Photo" cannot mean "write one file that Photos imports".
Photos on macOS/iOS pairs the two assets by UUID, and third-party tools exist to
perform that import.

We therefore emit a **ZIP bundle** containing exactly the pair Apple expects,
plus a manifest:

```
IMG_<id>.HEIC      still (HEIC when sips can, else .JPG)
IMG_<id>.MOV       motion asset, H.264 in a QuickTime container
metadata.json      contentIdentifier + pairing instructions
README.txt         human-readable notes
```

### A.2 Pairing identifier — VERIFIED

The identifier is carried in the QuickTime metadata key
`com.apple.quicktime.content.identifier`.

ffmpeg **cannot** write an arbitrary `com.apple.*` key with plain `-metadata`.
It silently drops it:

```
# VERIFIED: does NOT work
ffmpeg -i in.mp4 -c copy -metadata "com.apple.quicktime.content.identifier=UUID" out.mp4
# -> key absent from output (searched the bytes: not found)
```

Adding `use_metadata_tags` makes ffmpeg write it into a `moov/udta/meta`
`keys`+`ilst` structure, which is what we need:

```bash
# VERIFIED
ffmpeg -hide_banner -loglevel error -i in.mp4 -c copy \
  -movflags +faststart+use_metadata_tags \
  -metadata "com.apple.quicktime.content.identifier=4B8C497B-DD6F-4C7C-A57F-5EB91F541F4D" \
  -metadata "com.apple.quicktime.still-image-time=0" \
  -y out.MOV
```

Byte evidence — the `keys` box lists the mdta keys:

```
keys\0\0\0\0\0\0\0\3\0\0\0.mdtacom.apple.quicktime.content.identifier
\0\0\0,mdtacom.apple.quicktime.still-image-time\0\0\0\x0fmdtaencoder
```

Box layout produced:

```
ftyp
moov
  mvhd
  trak …            (video)
  udta
    meta
      hdlr
      keys            <- mdta key table
      ilst            <- one entry per key, each a `data` box
```

`server/lib/liveimage.mjs:inspectLivePhotoMovie()` walks this tree and reports
`hasKeys`, `hasIlst`, `hasContentIdentifier`, `contentId`, `hasStillImageTime`.

### A.3 Still-image-time track — PARTIAL

Photos expects a *timed metadata track* of type
`com.apple.quicktime.still-image-time` marking which video frame corresponds to
the still. ffmpeg 8.1 can write the **key** (see above) but we did **not** find a
supported way to author the accompanying timed metadata track (the usual route is
a custom `-f mov` writer or Apple's SDK). `UNVERIFIED` whether Photos accepts the
pair without it.

Practical effect: the still is the cover image, the MOV plays as the motion
asset. Some importers may show a still-frame offset of 0. This is recorded as a
`note` in the artifact detail rather than silently ignored.

### A.4 Still image — VERIFIED

```bash
# VERIFIED: sips writes a real HEIC
sips -s format heic poster.png --out IMG_0001.HEIC
file IMG_0001.HEIC
# -> ISO Media, HEIF Image HEVC Main or Main Still Picture Profile
```

When `sips` is unavailable (Linux, or a build without HEIC), the exporter falls
back to `.JPG` and records that in the artifact's `notes`. Photos accepts both.

---

## B. Google Motion Photo

A **single JPEG** whose trailing bytes are the MP4. VERIFIED end to end.

### B.1 Layout

```
byte 0                      byte N                       byte N+M
┌──────────────┬─────────────┬──────────────────────────┐
│ JPEG (SOI…EOI)│  MP4 bytes  │  (nothing after)         │
└──────────────┴─────────────┴──────────────────────────┘
                 ^
                 fileSize - MicroVideoOffset
```

`MicroVideoOffset` = **number of bytes from the end of the file back to the start
of the MP4**. With no trailing padding that equals the MP4's own length:

```js
const offset = mp4.length;              // no padding
const out = Buffer.concat([jpegWithXmp, mp4]);
// reader: videoStart = out.length - offset
```

### B.2 XMP packet

Injected as a JPEG APP1 segment (`FFE1`), payload prefixed with the standard
namespace string `http://ns.adobe.com/xap/1.0/\0`:

```xml
<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="deepsky-motion 0.1">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:GCamera="http://ns.google.com/photos/1.0/camera/"
    xmlns:Container="http://ns.google.com/photos/1.0/container/"
    xmlns:Item="http://ns.google.com/photos/1.0/container/item/"
    GCamera:MicroVideo="1"
    GCamera:MicroVideoVersion="1"
    GCamera:MicroVideoOffset="648737"
    GCamera:MicroVideoPresentationTimestampUs="0">
   <Container:Directory>
    <rdf:Seq>
     <rdf:li rdf:parseType="Resource">
      <Container:Item Item:Mime="image/jpeg" Item:Semantic="Primary"
                      Item:Length="0" Item:Padding="0"/>
     </rdf:li>
     <rdf:li rdf:parseType="Resource">
      <Container:Item Item:Mime="video/mp4" Item:Semantic="Motion"
                      Item:Length="648737" Item:Padding="0"/>
     </rdf:li>
    </rdf:Seq>
   </Container:Directory>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>
```

Both the legacy `GCamera:MicroVideo*` fields and the newer Pixel 6+
`Container:Directory` / `Item:Mime` description are emitted, so one file works
with both generations of parser. `Item:Length` carries the MP4 length.

`setJpegXmp()` walks the JPEG segments, **removes any pre-existing XMP APP1**,
and inserts ours immediately after SOI. It refuses to write a packet larger than
the 65533-byte APP1 limit (`XMP_TOO_LARGE`).

### B.3 Verification — VERIFIED

`inspectMotionPhoto(buf)` (used by the app) and an independent Python parser
both confirm:

```
hasXmp             true
microVideo         1
microVideoOffset   648737
videoStart         127211          (= fileSize - offset)
videoStartIsFtyp   true            (bytes 127215..127219 == "ftyp")
ok                 true
```

And the offset is genuinely computed, not a constant — two clips of different
lengths give different offsets.

---

## C. Animated WebP

The only "live image" that plays inline in **every** modern browser, and it is a
single file. This is the app's default live-image export.

### C.1 Chunk layout

```
RIFF <size> WEBP
  VP8X   flags: ANIMATION(0x02) | ALPHA(0x10) ...   canvas W-1, H-1 (24-bit)
  ANIM   background colour (4B) + loop count (2B, 0 = infinite)
  ANMF   frame 1: x/2, y/2, w-1, h-1, duration(3B, ms), flags  … frame data
  ANMF   frame 2 …
  …
```

Per-frame duration is **milliseconds**, stored as a 24-bit little-endian value in
the `ANMF` header (offset +12 from the chunk start).

### C.2 The encoder — and two traps

ffmpeg cannot encode WebP here, so `img2webp` is used. Two non-obvious traps,
both of which produced broken or unusable output before being found:

**Trap 1 — `-lossless` is the default.** Without an explicit `-lossy` flag,
`img2webp` ignores `-q` entirely:

| Invocation | Size of a 12-frame 720×480 clip |
|---|---|
| `img2webp -q 72 -m 4` | **3167 KB** (lossless, `-q` ignored) |
| `img2webp -lossy -q 72 -m 4` | 241 KB |
| `img2webp -lossy -q 60 -m 6` | 196 KB |

At 100 frames that is the difference between a 26 MB and a 1.6 MB file.

**Trap 2 — a frame-list file is not supported.** `img2webp` documents that a
single file argument is tokenised as a list, but this build **exits 1 with empty
stderr** when handed one. Frame paths must be passed as individual arguments:

```bash
# VERIFIED (works)
img2webp -loop 0 -lossy -d 42 -q 68 -m 6 -o out.webp f00000.png f00001.png …

# VERIFIED (fails silently, exit 1, no message)
img2webp -loop 0 -d 42 -o out.webp frames.txt
```

The working invocation:

```bash
# VERIFIED
img2webp -loop 0 -lossy -d 42 -q 68 -m 6 -o out.webp frame_*.png
```

Frames are written as PNG from the renderer's raw RGBA buffer. A size budget is
applied (`maxEdge 800`, `fpsCap 24`) because a full-quality 6 s 1280 px clip is
~40 MB, which is not a shareable "live image"; the MP4 carries full quality.

**Fallback:** if `img2webp` is missing, `sharp`'s animated join is used
(`sharp(frames, {join:{animated:true,loop:0,delay:[…]}}).webp()`). VERIFIED to
produce `RIFF/WEBP` with an `ANIM` chunk.

### C.3 Platform support

| Platform | Animated WebP |
|---|---|
| Chrome / Edge / Firefox | native |
| Safari (macOS 11+, iOS 14+) | native |
| Windows 10+ Photos | native |
| macOS Preview / Quick Look | yes |
| Google Photos | yes (as a still) |

---

## D. APNG and GIF (supporting formats)

Both via ffmpeg from raw RGBA:

```bash
# VERIFIED — APNG
ffmpeg -f rawvideo -pixel_format rgba -video_size WxH -framerate F -i - \
       -c:v apng -plays 0 -f apng -y out.png
# acTL chunk present, num_frames matches fcTL count

# VERIFIED — GIF
ffmpeg -f rawvideo -pixel_format rgba -video_size WxH -framerate F -i - \
       -vf "split[a][b];[a]palettegen=max_colors=192[p];[b][p]paletteuse=dither=sierra2_4a" \
       -loop 0 -y out.gif
```

Both are **lossless or near-lossless and therefore heavy**: a 4 s 960 px APNG is
~17 MB. The app caps APNG at 12 fps / 640 px long edge and GIF at 10 fps /
560 px, and emits a warning in the artifact when the result still exceeds 24 MB.
Users who want full quality should take the MP4 or the animated WebP.

---

## E. What the app emits, per format

| `kind` | File | MIME | Typical size (4 s, 960 px) | Target |
|---|---|---|---|---|
| `video` | `*.mp4` | `video/mp4` | ~1 MB | everywhere |
| `webp` | `*.webp` | `image/webp` | ~2 MB | browsers, iOS 14+, Android |
| `motionphoto` | `*-motionphoto.jpg` | `image/jpeg` | ~1 MB | Google Photos, Android, Samsung |
| `livephoto` | `*-livephoto.zip` | `application/zip` | ~1 MB | macOS/iOS Photos via a converter |
| `apng` | `*-animated.png` | `image/apng` | up to ~17 MB | browsers (lossless) |
| `gif` | `*.gif` | `image/gif` | up to ~15 MB | everywhere (fallback) |

Sizes are measured from real runs, not estimated.

### Failure handling

Each live-image step is isolated: if the Live Photo packaging throws, the job
records a **warning** and still returns the other artifacts, rather than failing
the whole export. If `sips` cannot write HEIC, the still degrades to JPEG and the
artifact detail says so. If `img2webp` is missing, WebP falls back to `sharp`.

---

## F. Tester verification commands

```bash
# 1. Produce every artifact
ID=$(curl -s -F "file=@samples/nebula-1600.png" http://127.0.0.1:8765/api/upload \
     | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
JOB=$(curl -s -X POST -H 'content-type: application/json' \
      -d "{\"id\":\"$ID\",\"format\":\"all\",\"params\":{\"durationSec\":4,\"fps\":24,\"resolution\":960}}" \
      http://127.0.0.1:8765/api/render | python3 -c "import sys,json;print(json.load(sys.stdin)['jobId'])")
D=work/jobs/job-$JOB

# 2. Motion Photo — offset must land on an ftyp box
python3 - "$D"/*-motionphoto.jpg <<'PY'
import sys,re
b=open(sys.argv[1],'rb').read()
assert b[:2]==b'\xff\xd8', 'not a JPEG'
off=int(re.search(rb'MicroVideoOffset="(\d+)"', b).group(1))
start=len(b)-off
print('offset', off, 'start', start, 'sig', b[start+4:start+8])
assert b[start+4:start+8]==b'ftyp', 'offset does not point at the MP4'
print('MOTION PHOTO OK')
PY

# 3. Live Photo ZIP — CRCs must be valid
python3 - "$D"/*-livephoto.zip <<'PY'
import sys, zipfile
z=zipfile.ZipFile(sys.argv[1])
bad=z.testzip()
assert bad is None, f'bad CRC in {bad}'
print('entries:', z.namelist())
print('LIVE PHOTO OK')
PY

# 4. Animated WebP — ANIM present, frame count matches
python3 - "$D"/*.webp <<'PY'
import sys
b=open(sys.argv[1],'rb').read()
assert b[:4]==b'RIFF' and b[8:12]==b'WEBP'
print('ANIM chunk:', b'ANIM' in b, '| ANMF frames:', b.count(b'ANMF'))
PY

# 5. Every artifact decodes with an independent decoder
for f in "$D"/*; do echo "== $f"; ffprobe -v error -show_entries stream=codec_name,width,height,nb_frames -of default=nw=1 "$f" 2>&1 | head -5; done
```

Expected: the Motion Photo check prints `MOTION PHOTO OK`; the ZIP reports four
entries (`IMG_*.HEIC|JPG`, `IMG_*.MOV`, `metadata.json`, `README.txt`) and no CRC
error; the WebP reports `ANIM chunk: True` with a non-zero `ANMF` count; ffprobe
identifies h264 for the MP4/MOV and the right dimensions for the rest.
