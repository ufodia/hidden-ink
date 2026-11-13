/**
 * A minimal PNG reader and writer. Browsers premultiply alpha when they decode
 * an image, which destroys the colour of fully transparent pixels. Many AI
 * pipelines do the opposite — they drop the alpha channel and keep the raw
 * colour — so hidden content under transparency must be read from the file.
 */

export const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

export interface PngChunk {
  type: string;
  data: Uint8Array;
}

export interface RawImage {
  width: number;
  height: number;
  /** Straight (not premultiplied) RGBA, 8 bits per channel. */
  rgba: Uint8ClampedArray;
  /** Source precision, when decoded from PNG rather than a canvas. */
  bitDepth?: number;
}

export class PngError extends Error {}
/** A valid layout that needs a browser fallback, with reduced inspection coverage. */
export class PngUnsupportedError extends PngError {}
export const MAX_PNG_PIXELS = 40_000_000;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function isPng(bytes: Uint8Array): boolean {
  return PNG_SIGNATURE.every((b, i) => bytes[i] === b);
}

const ascii = (bytes: Uint8Array) => String.fromCharCode(...bytes);

export function readChunks(bytes: Uint8Array): PngChunk[] {
  if (!isPng(bytes)) throw new PngError('Not a PNG file.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: PngChunk[] = [];
  let offset = 8;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) throw new PngError('The PNG file is truncated.');
    const length = view.getUint32(offset);
    const type = ascii(bytes.subarray(offset + 4, offset + 8));
    if (!/^[A-Za-z]{4}$/.test(type)) throw new PngError('The PNG has an invalid chunk type.');
    if (offset + 12 + length > bytes.length) throw new PngError('The PNG file is truncated.');
    if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== view.getUint32(offset + 8 + length))
      throw new PngError(`The PNG ${type} checksum is invalid.`);
    if (chunks.length >= 100_000) throw new PngError('The PNG contains too many chunks.');
    chunks.push({ type, data: bytes.subarray(offset + 8, offset + 8 + length) });
    offset += 12 + length;
    if (type === 'IEND') {
      if (length !== 0) throw new PngError('The PNG end chunk is invalid.');
      return chunks;
    }
  }
  throw new PngError('The PNG has no end chunk.');
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const response = new Response(new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(stream));
  return new Uint8Array(await response.arrayBuffer());
}

/** Read incrementally so compressed input cannot allocate an unbounded result. */
export async function inflate(bytes: Uint8Array, maxBytes = 1_048_576): Promise<Uint8Array> {
  const reader = new Blob([bytes as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new DecompressionStream('deflate'))
    .getReader();
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > maxBytes) {
        await reader.cancel();
        throw new PngError('Compressed data exceeds its permitted inspection size.');
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
export const deflate = (bytes: Uint8Array) => pipe(bytes, new CompressionStream('deflate'));

function paeth(a: number, b: number, c: number) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Decode 8- and 16-bit, non-interlaced greyscale, RGB, palette and alpha PNGs to straight RGBA. */
export async function decodePng(bytes: Uint8Array): Promise<RawImage> {
  const chunks = readChunks(bytes);
  const header = chunks[0];
  if (
    header?.type !== 'IHDR' ||
    header.data.length !== 13 ||
    chunks.filter((c) => c.type === 'IHDR').length !== 1
  )
    throw new PngError('The PNG header is invalid.');
  const h = new DataView(header.data.buffer, header.data.byteOffset, header.data.byteLength);
  const width = h.getUint32(0);
  const height = h.getUint32(4);
  const depth = header.data[8];
  const colorType = header.data[9];
  const interlace = header.data[12];
  if (!width || !height || width * height > MAX_PNG_PIXELS)
    throw new PngError('The PNG dimensions are invalid or exceed 40 megapixels.');
  if (header.data[10] !== 0 || header.data[11] !== 0 || interlace > 1)
    throw new PngError('The PNG compression or filtering method is invalid.');
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new PngError(`Colour type ${colorType} is not supported.`);
  const validDepth = colorType === 0 ? [1, 2, 4, 8, 16] : colorType === 3 ? [1, 2, 4, 8] : [8, 16];
  if (!validDepth.includes(depth)) throw new PngError('The PNG bit depth does not match its colour type.');
  if (interlace !== 0) throw new PngUnsupportedError('Interlaced PNGs need browser decoding.');
  if (depth !== 8 && depth !== 16)
    throw new PngUnsupportedError(`Bit depth ${depth} needs browser decoding.`);
  const bytesPerSample = depth / 8;
  const bpp = channels * bytesPerSample;
  const stride = width * bpp;

  const idat = chunks.filter((c) => c.type === 'IDAT');
  const joined = new Uint8Array(idat.reduce((n, c) => n + c.data.length, 0));
  let o = 0;
  for (const c of idat) {
    joined.set(c.data, o);
    o += c.data.length;
  }
  if (!idat.length) throw new PngError('The PNG has no image data.');
  const expected = (stride + 1) * height;
  const raw = await inflate(joined, expected);
  if (raw.length !== expected) throw new PngError('The PNG image data is incomplete.');

  const pixels = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    if (filter > 4) throw new PngError('The PNG scanline filter is invalid.');
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    const prev = y ? pixels.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const left = x >= bpp ? out[x - bpp] : 0;
      const up = prev ? prev[x] : 0;
      const upLeft = prev && x >= bpp ? prev[x - bpp] : 0;
      let value = line[x];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) value += paeth(left, up, upLeft);
      out[x] = value & 0xff;
    }
  }

  const palette = chunks.find((c) => c.type === 'PLTE')?.data;
  const transparency = chunks.find((c) => c.type === 'tRNS')?.data;
  if (colorType === 3 && (!palette || !palette.length || palette.length % 3 || palette.length > 768))
    throw new PngError('The PNG palette is invalid.');
  if (
    transparency &&
    ((colorType === 0 && transparency.length !== 2) ||
      (colorType === 2 && transparency.length !== 6) ||
      (colorType === 3 && transparency.length > palette!.length / 3) ||
      colorType === 4 ||
      colorType === 6)
  )
    throw new PngError('The PNG transparency chunk is invalid.');
  const rgba = new Uint8ClampedArray(width * height * 4);
  const sampleAt = (i: number, c: number) => pixels[(i * channels + c) * bytesPerSample];
  const fullSampleAt = (i: number, c: number) => {
    const at = (i * channels + c) * bytesPerSample;
    return depth === 16 ? (pixels[at] << 8) | pixels[at + 1] : pixels[at];
  };
  const transparentSample = (c: number) => (transparency![c * 2] << 8) | transparency![c * 2 + 1];
  for (let i = 0; i < width * height; i++) {
    const p = i * 4;
    if (colorType === 3) {
      const index = pixels[i];
      if (index * 3 + 2 >= palette!.length)
        throw new PngError('The PNG references a missing palette colour.');
      rgba[p] = palette![index * 3];
      rgba[p + 1] = palette![index * 3 + 1];
      rgba[p + 2] = palette![index * 3 + 2];
      rgba[p + 3] = transparency && index < transparency.length ? transparency[index] : 255;
    } else if (colorType === 0 || colorType === 4) {
      const g = sampleAt(i, 0);
      rgba[p] = rgba[p + 1] = rgba[p + 2] = g;
      rgba[p + 3] =
        colorType === 4
          ? sampleAt(i, 1)
          : transparency && fullSampleAt(i, 0) === transparentSample(0)
            ? 0
            : 255;
    } else {
      rgba[p] = sampleAt(i, 0);
      rgba[p + 1] = sampleAt(i, 1);
      rgba[p + 2] = sampleAt(i, 2);
      rgba[p + 3] =
        colorType === 6
          ? sampleAt(i, 3)
          : transparency && [0, 1, 2].every((c) => fullSampleAt(i, c) === transparentSample(c))
            ? 0
            : 255;
    }
  }
  return { width, height, rgba, bitDepth: depth };
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** Encode straight RGBA as an 8-bit RGBA PNG, with optional tEXt chunks. */
export async function encodePng(image: RawImage, text: Record<string, string> = {}): Promise<Uint8Array> {
  const { width, height, rgba } = image;
  const header = new Uint8Array(13);
  const hv = new DataView(header.buffer);
  hv.setUint32(0, width);
  hv.setUint32(4, height);
  header[8] = 8;
  header[9] = 6;
  const raw = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y++)
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  const parts = [
    Uint8Array.from(PNG_SIGNATURE),
    chunk('IHDR', header),
    ...Object.entries(text).map(([key, value]) => chunk('tEXt', latin1(`${key}\u0000${value}`))),
    chunk('IDAT', await deflate(raw)),
    chunk('IEND', new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function latin1(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

/** Insert a tEXt chunk after IHDR in an existing PNG. */
export function addTextChunk(png: Uint8Array, keyword: string, text: string): Uint8Array {
  const ihdrEnd = 8 + 12 + 13;
  const extra = chunk('tEXt', latin1(`${keyword}\u0000${text}`));
  const out = new Uint8Array(png.length + extra.length);
  out.set(png.subarray(0, ihdrEnd));
  out.set(extra, ihdrEnd);
  out.set(png.subarray(ihdrEnd), ihdrEnd + extra.length);
  return out;
}
