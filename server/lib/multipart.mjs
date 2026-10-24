// Minimal, dependency-free multipart/form-data parser.
// Scoped to what an upload form needs: one file part + optional text fields.

/** Parse `Content-Type: multipart/form-data; boundary=...` */
export function parseBoundary(contentType = '') {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!m) return null;
  return (m[1] || m[2] || '').trim();
}

function parseHeaders(block) {
  const headers = {};
  for (const line of block.split('\r\n')) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return headers;
}

/**
 * @returns {{fields: Object<string,string>, files: Array<{name:string,filename:string,contentType:string,data:Buffer}>}}
 */
export function parseMultipart(body, boundary) {
  const fields = {};
  const files = [];
  if (!boundary) return { fields, files };

  const delim = Buffer.from(`--${boundary}`);
  let start = body.indexOf(delim);
  if (start < 0) return { fields, files };
  start += delim.length;

  while (start < body.length) {
    // Terminating delimiter is followed by "--".
    if (body[start] === 0x2d && body[start + 1] === 0x2d) break;
    // Skip CRLF after the boundary.
    if (body[start] === 0x0d && body[start + 1] === 0x0a) start += 2;

    const headerEnd = body.indexOf('\r\n\r\n', start);
    if (headerEnd < 0) break;
    const headers = parseHeaders(body.slice(start, headerEnd).toString('utf8'));
    const dataStart = headerEnd + 4;

    const next = body.indexOf(delim, dataStart);
    if (next < 0) break;
    // The CRLF before the next boundary belongs to the delimiter, not the data.
    let dataEnd = next;
    if (body[dataEnd - 2] === 0x0d && body[dataEnd - 1] === 0x0a) dataEnd -= 2;

    const data = body.slice(dataStart, dataEnd);
    const disposition = headers['content-disposition'] || '';
    const nameMatch = /name="([^"]*)"/i.exec(disposition);
    const fileMatch = /filename="([^"]*)"/i.exec(disposition);
    const name = nameMatch ? nameMatch[1] : '';

    if (fileMatch) {
      files.push({
        name,
        filename: fileMatch[1],
        contentType: headers['content-type'] || 'application/octet-stream',
        data,
      });
    } else if (name) {
      fields[name] = data.toString('utf8');
    }
    start = next + delim.length;
  }
  return { fields, files };
}

/** Read a request body up to `limit` bytes. Rejects when exceeded. */
export function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error(`payload too large (> ${limit} bytes)`), { code: 'TOO_LARGE', status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
