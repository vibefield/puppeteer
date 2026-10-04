// The goldens' PNG codec: 8-bit RGB/RGBA, non-interlaced, which is what Chromium's capture writes.
// Decoding reads it back to RGBA for the per-pixel compare; encoding writes RGBA at deflate level 9
// with a per-row filter choice, so the committed goldens stay small. node:zlib only: the goldens
// add no dependency.

import { crc32, deflateSync, inflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** `{ width, height, data }`, `data` RGBA, row-major, 4 bytes a pixel. */
export function decodePng(buffer) {
  if (!buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG');
  let offset = 8;
  let header;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      header = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        depth: body[8],
        colour: body[9],
        interlace: body[12],
      };
    } else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  if (!header) throw new Error('PNG without IHDR');
  const { width, height, depth, colour, interlace } = header;
  if (depth !== 8 || (colour !== 6 && colour !== 2) || interlace !== 0) {
    throw new Error(`unsupported PNG: depth ${depth}, colour type ${colour}, interlace ${interlace}`);
  }
  const channels = colour === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  const rows = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = rows.subarray(y * stride, (y + 1) * stride);
    const previous = y > 0 ? rows.subarray((y - 1) * stride, y * stride) : undefined;
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? out[x - channels] : 0;
      const up = previous ? previous[x] : 0;
      const corner = previous && x >= channels ? previous[x - channels] : 0;
      out[x] = (line[x] + predict(filter, left, up, corner)) & 0xff;
    }
  }
  if (channels === 4) return { width, height, data: new Uint8Array(rows.buffer, rows.byteOffset, rows.length) };
  const data = new Uint8Array(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    data[pixel * 4] = rows[pixel * 3];
    data[pixel * 4 + 1] = rows[pixel * 3 + 1];
    data[pixel * 4 + 2] = rows[pixel * 3 + 2];
    data[pixel * 4 + 3] = 255;
  }
  return { width, height, data };
}

function predict(filter, left, up, corner) {
  switch (filter) {
    case 0:
      return 0;
    case 1:
      return left;
    case 2:
      return up;
    case 3:
      return (left + up) >> 1;
    case 4: {
      const estimate = left + up - corner;
      const toLeft = Math.abs(estimate - left);
      const toUp = Math.abs(estimate - up);
      const toCorner = Math.abs(estimate - corner);
      return toLeft <= toUp && toLeft <= toCorner ? left : toUp <= toCorner ? up : corner;
    }
    default:
      throw new Error(`bad PNG filter ${filter}`);
  }
}

/** RGBA in, PNG out: each row takes the filter whose output sums smallest (the usual heuristic). */
export function encodePng({ width, height, data }) {
  const stride = width * 4;
  const filtered = Buffer.alloc((stride + 1) * height);
  const candidate = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const row = data.subarray(y * stride, (y + 1) * stride);
    const previous = y > 0 ? data.subarray((y - 1) * stride, y * stride) : undefined;
    let best = 0;
    let bestScore = Infinity;
    for (let filter = 0; filter <= 4; filter += 1) {
      let score = 0;
      for (let x = 0; x < stride; x += 1) {
        const left = x >= 4 ? row[x - 4] : 0;
        const up = previous ? previous[x] : 0;
        const corner = previous && x >= 4 ? previous[x - 4] : 0;
        const value = (row[x] - predict(filter, left, up, corner)) & 0xff;
        score += value < 128 ? value : 256 - value;
      }
      if (score < bestScore) {
        bestScore = score;
        best = filter;
      }
    }
    const out = filtered.subarray(y * (stride + 1), (y + 1) * (stride + 1));
    out[0] = best;
    for (let x = 0; x < stride; x += 1) {
      const left = x >= 4 ? row[x - 4] : 0;
      const up = previous ? previous[x] : 0;
      const corner = previous && x >= 4 ? previous[x - 4] : 0;
      candidate[x] = (row[x] - predict(best, left, up, corner)) & 0xff;
    }
    candidate.copy(out, 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(filtered, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type, body) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  const tagged = Buffer.concat([Buffer.from(type, 'latin1'), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(tagged));
  return Buffer.concat([length, tagged, crc]);
}
