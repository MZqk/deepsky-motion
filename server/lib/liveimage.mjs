// "Live image" exporters.
//
// Three genuinely different containers, each aimed at a different platform:
//
//   makeMotionPhoto  -> ONE .jpg  [JPEG][MP4]  + XMP offsets. Google Photos /
//                       Pixel / Samsung / most Android galleries.
//   makeLivePhoto    -> a .zip bundle holding IMG_x.HEIC + IMG_x.MOV + metadata.json.
//                       Apple has no single-file Live Photo; the pair is tied by a
//                       shared `com.apple.quicktime.content.identifier` UUID and the
//                       MOV carries a `still-image-time` timed metadata track.
//   makeAnimatedWebp -> ONE .webp. The only "live image" that plays inline in every
//                       browser, incl. Safari on iOS 14+ and macOS.
//
// Everything is produced locally with ffmpeg + sharp + (on macOS) sips.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { encodeAnimatedWebp, which, runProcess } from './encode.mjs';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function uuid() {
  return randomUUID().toUpperCase();
}

function exec(cmd, args, opts = {}) {
  return runProcess(cmd, args, opts);
}

async function sipsToHeic(pngPath, outPath) {
  const sips = which('sips') || (fs.existsSync('/usr/bin/sips') ? '/usr/bin/sips' : null);
  if (!sips) return null;
  try {
    await exec(sips, ['-s', 'format', 'heic', pngPath, '--out', outPath]);
    const st = await fsp.stat(outPath);
    if (st.size < 512) return null;
    return outPath;
  } catch {
    return null;
  }
}

/** A neutral XMP packet for the still image, matching what Apple writes. */
function appleStillXmp(contentId) {
  return `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="web3astra 0.1">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:apple-fi="http://ns.apple.com/faceinfo/1.0/"
    xmlns:GCamera="http://ns.google.com/photos/1.0/camera/"
    xmlns:Container="http://ns.google.com/photos/1.0/container/"
    xmlns:Item="http://ns.google.com/photos/1.0/container/item/"
    GCamera:ContentIdentifier="${contentId}">
   <GCamera:MicroVideo>0</GCamera:MicroVideo>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

/** XMP packet for a Google Motion Photo. */
export function motionPhotoXmp({ offset, presentationTimestampUs = 0, length = 0, mime = 'video/mp4', version = 1 }) {
  return `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="web3astra 0.1">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:GCamera="http://ns.google.com/photos/1.0/camera/"
    xmlns:Container="http://ns.google.com/photos/1.0/container/"
    xmlns:Item="http://ns.google.com/photos/1.0/container/item/"
    GCamera:MotionPhoto="1"
    GCamera:MotionPhotoVersion="${version}"
    GCamera:MotionPhotoPresentationTimestampUs="${presentationTimestampUs}"
    GCamera:MicroVideo="1"
    GCamera:MicroVideoVersion="${version}"
    GCamera:MicroVideoOffset="${offset}"
    GCamera:MicroVideoPresentationTimestampUs="${presentationTimestampUs}">
   <Container:Directory>
    <rdf:Seq>
     <rdf:li rdf:parseType="Resource">
      <Container:Item
        Item:Mime="image/jpeg"
        Item:Semantic="Primary"
        Item:Length="0"
        Item:Padding="0"/>
     </rdf:li>
     <rdf:li rdf:parseType="Resource">
      <Container:Item
        Item:Mime="${mime}"
        Item:Semantic="Motion"
        Item:Length="${length}"
        Item:Padding="0"/>
     </rdf:li>
    </rdf:Seq>
   </Container:Directory>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

// ---------------------------------------------------------------------------
// JPEG segment surgery
// ---------------------------------------------------------------------------

/** Walk JPEG segments. Returns [{marker, start, length, dataStart}] for APPn. */
export function jpegSegments(buf) {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) throw Object.assign(new Error('not a JPEG'), { code: 'NOT_JPEG' });
  const segs = [];
  let i = 2;
  while (i < buf.length - 1) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buf[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (marker === 0xda) break; // start of scan: entropy data follows
    if (marker === 0xd9) break;
    const len = buf.readUInt16BE(i + 2);
    segs.push({ marker, start: i, length: len, dataStart: i + 4, dataEnd: i + 2 + len });
    i += 2 + len;
  }
  return segs;
}

/** Remove every existing APP1/XMP segment, then insert ours right after SOI. */
export function setJpegXmp(jpegBuf, xmpString) {
  const segs = jpegSegments(jpegBuf);
  const xmpBody = Buffer.from(xmpString, 'utf8');
  const header = Buffer.from('http://ns.adobe.com/xap/1.0/\u0000', 'latin1');
  const payload = Buffer.concat([header, xmpBody]);
  if (payload.length + 2 > 0xffff) {
    throw Object.assign(new Error('XMP packet too large for a JPEG APP1 segment'), { code: 'XMP_TOO_LARGE' });
  }
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), Buffer.from([(payload.length + 2) >> 8, (payload.length + 2) & 0xff]), payload]);

  // Keep everything except existing APP1 segments that carry XMP.
  const drop = new Set();
  for (const s of segs) {
    if (s.marker !== 0xe1) continue;
    const head = jpegBuf.slice(s.dataStart, Math.min(s.dataEnd, s.dataStart + 29)).toString('latin1');
    if (head.startsWith('http://ns.adobe.com/xap/1.0/')) drop.add(s.start);
  }

  const parts = [jpegBuf.slice(0, 2)];
  if (!drop.has(2)) parts.push(app1);
  let i = 2;
  while (i < jpegBuf.length) {
    const s = segs.find((x) => x.start === i);
    if (s) {
      if (!drop.has(s.start)) parts.push(jpegBuf.slice(s.start, s.dataEnd));
      i = s.dataEnd;
      if (s.marker === 0xda) {
        parts.push(jpegBuf.slice(i));
        break;
      }
    } else {
      parts.push(jpegBuf.slice(i));
      break;
    }
  }
  if (drop.has(2)) parts.splice(1, 0, app1);
  return Buffer.concat(parts);
}

/** Read the first XMP packet out of a JPEG or an ISO-BMFF file (for verification). */
export function readXmp(buf) {
  const text = buf.toString('latin1');
  const start = text.indexOf('<x:xmpmeta');
  if (start < 0) {
    const alt = text.indexOf('http://ns.adobe.com/xap/1.0/');
    if (alt < 0) return null;
    const s2 = text.indexOf('<x:xmpmeta', alt);
    if (s2 < 0) return null;
    return parseXmpFields(text.slice(s2, text.indexOf('</x:xmpmeta>', s2) + 12));
  }
  const end = text.indexOf('</x:xmpmeta>', start);
  return parseXmpFields(text.slice(start, end > 0 ? end + 12 : undefined));
}

function parseXmpFields(xmp) {
  const fields = { raw: xmp };
  const re = /(?:GCamera|Container|Item|apple-fi):([A-Za-z]+)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(xmp))) fields[m[1]] = m[2];
  return fields;
}

// ---------------------------------------------------------------------------
// ISO-BMFF (QuickTime) inspection + patching
// ---------------------------------------------------------------------------

/** Parse top-level boxes. Returns [{type, start, size, headerSize, end}]. */
export function parseBoxes(buf, offset = 0, limit = buf.length, depth = 0) {
  const boxes = [];
  let i = offset;
  while (i + 8 <= limit) {
    let size = buf.readUInt32BE(i);
    const type = buf.slice(i + 4, i + 8).toString('latin1');
    let headerSize = 8;
    if (size === 1) {
      if (i + 16 > limit) break;
      const big = buf.readBigUInt64BE(i + 8);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) break;
      size = Number(big);
      headerSize = 16;
    } else if (size === 0) {
      size = limit - i;
    }
    if (size < headerSize || i + size > limit) break;
    const box = { type, start: i, size, headerSize, end: i + size, depth };
    if (['moov', 'trak', 'mdia', 'minf', 'stbl', 'udta', 'meta', 'ilst', 'dinf', 'edts'].includes(type)) {
      // `meta` is a full box: 4 bytes of version/flags before children.
      const inner = type === 'meta' ? i + headerSize + 4 : i + headerSize;
      box.children = parseBoxes(buf, inner, i + size, depth + 1);
    }
    boxes.push(box);
    i += size;
  }
  return boxes;
}

/** Recursively find boxes of a type. */
export function findBoxes(boxes, type, out = []) {
  for (const b of boxes) {
    if (b.type === type) out.push(b);
    if (b.children) findBoxes(b.children, type, out);
  }
  return out;
}

/**
 * True when the file carries Apple's Live Photo pairing metadata.
 * Checks the `keys`/`ilst` metadata plus a raw byte scan (ffmpeg may store the
 * key as a plain udta string).
 */
export function inspectLivePhotoMovie(buf) {
  const boxes = parseBoxes(buf);
  const hasMoov = boxes.some((b) => b.type === 'moov');
  const text = buf.toString('latin1');
  const idKey = 'com.apple.quicktime.content.identifier';
  const stillKey = 'com.apple.quicktime.still-image-time';
  let contentId = null;
  const idx = text.indexOf(idKey);
  if (idx >= 0) {
    // Value lives in the data box that follows the key within the next ~128 bytes.
    const window = buf.slice(idx, idx + 512);
    const m = /[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}/.exec(window.toString('latin1'));
    if (m) contentId = m[0];
  }
  return {
    isIsoBmff: buf.length > 12 && buf.slice(4, 8).toString('latin1') === 'ftyp',
    brand: buf.length > 12 ? buf.slice(8, 12).toString('latin1') : null,
    hasMoov,
    hasKeys: findBoxes(boxes, 'keys').length > 0,
    hasIlst: findBoxes(boxes, 'ilst').length > 0,
    hasContentIdentifier: idx >= 0,
    contentId,
    hasStillImageTime: text.includes(stillKey),
  };
}

// ---------------------------------------------------------------------------
// Minimal ZIP writer (deflate or store) — used for the Live Photo bundle
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Build a ZIP archive. `entries` = [{name, data:Buffer, store?:boolean}] */
export function buildZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  const now = new Date();
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
  const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data);
    const crc = crc32(raw);
    const method = e.store ? 0 : 8;
    const body = method === 0 ? raw : zlib.deflateRawSync(raw, { level: 6 });
    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);
    locals.push(local, body);

    const cen = Buffer.alloc(46 + nameBuf.length);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(0x031e, 4); // made by: unix, v3.0
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt16LE(dosTime, 12);
    cen.writeUInt16LE(dosDate, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(raw.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt16LE(0, 30);
    cen.writeUInt16LE(0, 32);
    cen.writeUInt16LE(0, 34);
    cen.writeUInt16LE(0, 36);
    cen.writeUInt32LE(0, 38);
    cen.writeUInt32LE(offset, 42);
    nameBuf.copy(cen, 46);
    central.push(cen);

    offset += local.length + body.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, end]);
}

// ---------------------------------------------------------------------------
// Public exporters
// ---------------------------------------------------------------------------

function artifact(kind, filePath, { mime, urlBase, detail = {}, filename }) {
  const st = fs.statSync(filePath);
  const name = filename || path.basename(filePath);
  return {
    kind,
    path: filePath,
    filename: name,
    url: `${urlBase}/${encodeURIComponent(name)}`,
    bytes: st.size,
    mime,
    detail,
  };
}

/**
 * Google Motion Photo: a single JPEG whose trailing bytes are the MP4.
 * Layout: [JPEG][MP4]  with MicroVideoOffset = filesize - mp4Start.
 */
export async function makeMotionPhoto({ imagePath, videoPath, outPath, urlBase = '', meta = {} }) {
  const jpeg = await fsp.readFile(imagePath);
  const mp4 = await fsp.readFile(videoPath);
  const offset = mp4.length; // bytes from EOF back to the start of the video
  const xmp = motionPhotoXmp({
    offset,
    presentationTimestampUs: meta.presentationTimestampUs ?? 0,
    length: mp4.length,
    mime: 'video/mp4',
  });
  const withXmp = setJpegXmp(jpeg, xmp);
  const out = Buffer.concat([withXmp, mp4]);
  await fsp.writeFile(outPath, out);
  const info = inspectMotionPhoto(out);
  return artifact('motionphoto', outPath, {
    mime: 'image/jpeg',
    urlBase,
    filename: meta.filename,
    detail: {
      format: 'google-motion-photo',
      jpegBytes: withXmp.length,
      videoBytes: mp4.length,
      microVideoOffset: offset,
      verified: info,
      platforms: ['Google Photos', 'Android gallery', 'Samsung Gallery'],
    },
  });
}

/** Verify a Motion Photo: locate the XMP, check the offset really points at the MP4. */
export function inspectMotionPhoto(buf) {
  const xmp = readXmp(buf);
  const offset = xmp?.MicroVideoOffset ? Number(xmp.MicroVideoOffset) : null;
  let videoStart = null;
  let ok = false;
  if (offset != null && offset > 0 && offset < buf.length) {
    videoStart = buf.length - offset;
    ok = buf.slice(videoStart + 4, videoStart + 8).toString('latin1') === 'ftyp';
  }
  return {
    hasXmp: !!xmp,
    microVideo: xmp?.MicroVideo ?? null,
    microVideoOffset: offset,
    videoStart,
    videoStartIsFtyp: ok,
    fileBytes: buf.length,
    ok: !!xmp && ok,
  };
}

/**
 * Apple Live Photo bundle.
 * Apple has no single-file Live Photo: Photos pairs a still (HEIC/JPEG) with a
 * MOV, linked by a shared content identifier. We emit exactly that pair inside a
 * ZIP, plus a metadata.json describing the pairing, so it can be dropped into
 * Photos via a converter or unzipped next to each other.
 */
export async function makeLivePhoto({ imagePath, videoPath, outPath, urlBase = '', meta = {}, baseName = 'IMG_0001', previewDir = null }) {
  const contentId = meta.contentIdentifier || uuid();
  const dir = await fsp.mkdtemp(path.join(path.dirname(outPath), 'lp-'));
  const notes = [];
  try {
    // 1. Still image -> HEIC when sips can, otherwise keep the JPEG.
    let stillPath = path.join(dir, `${baseName}.HEIC`);
    let stillMime = 'image/heic';
    const heic = await sipsToHeic(imagePath, stillPath);
    if (!heic) {
      stillPath = path.join(dir, `${baseName}.JPG`);
      stillMime = 'image/jpeg';
      await fsp.copyFile(imagePath, stillPath);
      notes.push('HEIC encoder unavailable — the still is a JPEG (Photos accepts both).');
    }
    // Tag the still with the shared identifier so third-party tools can pair it.
    if (stillMime === 'image/jpeg') {
      const tagged = setJpegXmp(await fsp.readFile(stillPath), appleStillXmp(contentId));
      await fsp.writeFile(stillPath, tagged);
    }

    // 2. Motion asset -> MOV carrying com.apple.quicktime.content.identifier.
    const movPath = path.join(dir, `${baseName}.MOV`);
    await exec(
      (await import('./encode.mjs')).ffmpegPath(),
      [
        '-hide_banner', '-loglevel', 'error',
        '-i', videoPath,
        '-c', 'copy',
        '-movflags', '+faststart+use_metadata_tags',
        '-metadata', `com.apple.quicktime.content.identifier=${contentId}`,
        '-metadata', `com.apple.quicktime.still-image-time=0`,
        '-y', movPath,
      ]
    );
    const movBuf = await fsp.readFile(movPath);
    if (previewDir) {
      await fsp.mkdir(previewDir, { recursive: true });
      await fsp.writeFile(path.join(previewDir, 'motion.mov'), movBuf);
    }
    const movieInfo = inspectLivePhotoMovie(movBuf);
    if (!movieInfo.hasContentIdentifier) {
      notes.push('The MOV could not be tagged with the Apple content identifier; pairing will need an external tool.');
    }

    // 3. Bundle.
    const metadata = {
      format: 'apple-live-photo-pair',
      producer: 'web3astra',
      contentIdentifier: contentId,
      still: path.basename(stillPath),
      motion: path.basename(movPath),
      width: meta.width ?? null,
      height: meta.height ?? null,
      durationSec: meta.durationSec ?? null,
      fps: meta.fps ?? null,
      createdAt: new Date().toISOString(),
      howToUse: [
        'Apple has no single-file Live Photo format; a Live Photo is a still + a MOV tied by a shared content identifier.',
        'This bundle contains that exact pair plus this manifest.',
        'macOS: unzip and use a converter (e.g. the `make-livephoto` style tools) to import into Photos, or drop both files into an iCloud Photos folder.',
        'The MOV alone plays anywhere; the HEIC alone is a normal still.',
      ],
    };
    const zip = buildZip([
      { name: path.basename(stillPath), data: await fsp.readFile(stillPath) },
      { name: path.basename(movPath), data: movBuf },
      { name: 'metadata.json', data: Buffer.from(JSON.stringify(metadata, null, 2), 'utf8') },
      { name: 'README.txt', data: Buffer.from(metadata.howToUse.join('\n\n') + '\n', 'utf8') },
    ]);
    await fsp.writeFile(outPath, zip);

    return artifact('livephoto', outPath, {
      mime: 'application/zip',
      urlBase,
      filename: meta.filename,
      detail: {
        format: 'apple-live-photo-pair (zip bundle)',
        contentIdentifier: contentId,
        still: { name: path.basename(stillPath), mime: stillMime },
        motion: { name: path.basename(movPath), mime: 'video/quicktime', verified: movieInfo },
        notes,
        platforms: ['macOS Photos (via converter)', 'iOS Photos (via converter)', 'any player (MOV)'],
      },
    });
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Animated WebP export. `frames` is a frameSource from render.createFrameSource(). */
export async function makeAnimatedWebp({ frames, outPath, quality = 78, urlBase = '', meta = {}, signal, onProgress }) {
  const info = await encodeAnimatedWebp({
    frameSource: frames,
    outPath,
    quality,
    signal,
    onProgress,
  });
  return artifact('webp', outPath, {
    mime: 'image/webp',
    urlBase,
    filename: meta.filename,
    detail: {
      format: 'animated-webp',
      frames: frames.count,
      fps: frames.fps,
      encoder: info.encoder,
      loop: 'infinite',
      platforms: ['all modern browsers', 'iOS 14+ (Photos/Share sheet)', 'Android', 'Windows 10+'],
    },
  });
}

/** Inspect any produced live-image artifact and report what a tester should see. */
export async function inspectArtifact(kind, filePath) {
  const buf = await fsp.readFile(filePath);
  if (kind === 'motionphoto') return inspectMotionPhoto(buf);
  if (kind === 'livephoto') return { isZip: buf.slice(0, 2).toString('latin1') === 'PK', bytes: buf.length };
  if (kind === 'webp') {
    return {
      isWebp: buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP',
      animated: buf.includes(Buffer.from('ANIM')),
      frames: countAnmf(buf),
      bytes: buf.length,
    };
  }
  return { bytes: buf.length };
}

export function countAnmf(buf) {
  let n = 0;
  let i = 0;
  while ((i = buf.indexOf('ANMF', i)) >= 0) {
    n++;
    i += 4;
  }
  return n;
}

export { uuid as newContentIdentifier };
