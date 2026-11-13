import { inflate, isPng, readChunks } from './png.ts';

/** A piece of human-readable text stored in the file rather than drawn in the pixels. */
export interface MetadataText {
  /** Where it was found, for example `PNG tEXt "Comment"` or `EXIF ImageDescription`. */
  source: string;
  text: string;
}

const latin1 = (bytes: Uint8Array) => {
  let out = '';
  for (const b of bytes) out += String.fromCharCode(b);
  return out;
};
const utf8 = (bytes: Uint8Array) => new TextDecoder('utf-8', { fatal: false }).decode(bytes);
const clean = (text: string) =>
  text
    .replace(/\u0000+$/g, '')
    .replace(/\u0000/g, ' ')
    .trim();

export type Format = 'png' | 'jpeg' | 'webp' | 'gif' | 'other';

export function sniff(bytes: Uint8Array): Format {
  if (isPng(bytes)) return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpeg';
  if (latin1(bytes.subarray(0, 4)) === 'RIFF' && latin1(bytes.subarray(8, 12)) === 'WEBP') return 'webp';
  if (latin1(bytes.subarray(0, 4)) === 'GIF8') return 'gif';
  return 'other';
}

/** Inspect supported metadata text fields within bounded sizes and traversal limits. */
const MAX_FIELD_BYTES = 1_048_576;
const MAX_TOTAL_TEXT = 4_194_304;
const MAX_FIELDS = 256;
type Warn = (message: string) => void;
const quiet: Warn = () => {};

export async function readMetadata(bytes: Uint8Array, warn: Warn = quiet): Promise<MetadataText[]> {
  const format = sniff(bytes);
  try {
    const fields =
      format === 'png'
        ? await pngText(bytes, warn)
        : format === 'jpeg'
          ? jpegText(bytes, warn)
          : format === 'webp'
            ? webpText(bytes, warn)
            : format === 'gif'
              ? gifText(bytes, warn)
              : [];
    const out: MetadataText[] = [];
    let remaining = MAX_TOTAL_TEXT;
    for (const field of fields) {
      if (out.length >= MAX_FIELDS || field.text.length > remaining) {
        warn('Some metadata was not inspected because the text or field-count limit was reached.');
        break;
      }
      remaining -= field.text.length;
      out.push(field);
    }
    return out;
  } catch {
    warn('Metadata could not be fully read. The pixel checks can still run.');
  }
  return [];
}

async function pngText(bytes: Uint8Array, warn: Warn): Promise<MetadataText[]> {
  const out: MetadataText[] = [];
  let remaining = MAX_TOTAL_TEXT;
  for (const chunk of readChunks(bytes)) {
    if (chunk.type === 'acTL') warn('Only the default image of this animated PNG is inspected.');
    if (!['tEXt', 'zTXt', 'iTXt', 'eXIf'].includes(chunk.type)) continue;
    if (out.length >= MAX_FIELDS || remaining <= 0) {
      warn('Some PNG metadata was not inspected because the text or field-count limit was reached.');
      break;
    }
    try {
      const bodyText = async (body: Uint8Array, compressed: boolean) => {
        const limit = Math.min(MAX_FIELD_BYTES, remaining);
        if (body.length > MAX_FIELD_BYTES) throw new Error('Metadata field too large.');
        const value = compressed ? await inflate(body, limit) : body;
        if (value.length > limit) throw new Error('Metadata field too large.');
        remaining -= value.length;
        return value;
      };
      const zero = chunk.data.indexOf(0);
      if (chunk.type !== 'eXIf' && (zero < 1 || zero > 79)) throw new Error('Invalid PNG text keyword.');
      if (chunk.type === 'tEXt') {
        out.push({
          source: `PNG tEXt "${latin1(chunk.data.subarray(0, zero))}"`,
          text: clean(latin1(await bodyText(chunk.data.subarray(zero + 1), false))),
        });
      } else if (chunk.type === 'zTXt') {
        if (chunk.data[zero + 1] !== 0) throw new Error('Invalid PNG text compression.');
        const text = latin1(await bodyText(chunk.data.subarray(zero + 2), true));
        out.push({ source: `PNG zTXt "${latin1(chunk.data.subarray(0, zero))}"`, text: clean(text) });
      } else if (chunk.type === 'iTXt') {
        const keyword = latin1(chunk.data.subarray(0, zero));
        if (![0, 1].includes(chunk.data[zero + 1]) || chunk.data[zero + 2] !== 0)
          throw new Error('Invalid PNG international text compression.');
        const compressed = chunk.data[zero + 1] === 1;
        let p = zero + 3;
        for (let i = 0; i < 2; i++) {
          const end = chunk.data.indexOf(0, p);
          if (end < p) throw new Error('Invalid PNG international text fields.');
          p = end + 1;
        }
        const body = chunk.data.subarray(p);
        const text = utf8(await bodyText(body, compressed));
        out.push({
          source: `PNG iTXt "${keyword}"`,
          text: keyword === 'XML:com.adobe.xmp' ? xmpText(text) : clean(text),
        });
      } else if (chunk.type === 'eXIf') {
        out.push(...exifText(await bodyText(chunk.data, false), warn));
      }
    } catch {
      warn(
        'A PNG metadata field was malformed or exceeded the inspection limit; other fields were retained.',
      );
    }
  }
  return out.filter((m) => m.text);
}

function jpegText(bytes: Uint8Array, warn: Warn): MetadataText[] {
  const out: MetadataText[] = [];
  let p = 2;
  while (p + 4 <= bytes.length && bytes[p] === 0xff) {
    if (bytes[p + 1] === 0xff) {
      p++;
      continue;
    }
    const marker = bytes[p + 1];
    if (marker === 0xda || marker === 0xd9) break; // start of scan / end of image
    const length = (bytes[p + 2] << 8) | bytes[p + 3];
    if (length < 2 || p + 2 + length > bytes.length) {
      warn('A JPEG metadata segment was truncated; later segments were not inspected.');
      break;
    }
    const body = bytes.subarray(p + 4, p + 2 + length);
    if (marker === 0xe1 && latin1(body.subarray(0, 6)) === 'Exif\u0000\u0000')
      out.push(...exifText(body.subarray(6), warn));
    else if (marker === 0xe1 && latin1(body.subarray(0, 29)) === 'http://ns.adobe.com/xap/1.0/\u0000')
      out.push({ source: 'XMP', text: xmpText(utf8(body.subarray(29))) });
    else if (marker === 0xfe) out.push({ source: 'JPEG comment', text: clean(utf8(body)) });
    p += 2 + length;
    if (out.length >= MAX_FIELDS) {
      warn('The metadata field-count limit was reached.');
      break;
    }
  }
  return out.filter((m) => m.text);
}

function webpText(bytes: Uint8Array, warn: Warn): MetadataText[] {
  const out: MetadataText[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = 12;
  while (p + 8 <= bytes.length) {
    const type = latin1(bytes.subarray(p, p + 4));
    const size = view.getUint32(p + 4, true);
    if (size > bytes.length - p - 8) {
      warn('A WebP chunk was truncated; later metadata was not inspected.');
      break;
    }
    const body = bytes.subarray(p + 8, p + 8 + size);
    if (['EXIF', 'XMP '].includes(type) && size > MAX_FIELD_BYTES) {
      warn('A WebP metadata field exceeded the inspection limit.');
      p += 8 + size + (size % 2);
      continue;
    }
    if (type === 'EXIF')
      out.push(
        ...exifText(latin1(body.subarray(0, 6)) === 'Exif\u0000\u0000' ? body.subarray(6) : body, warn),
      );
    if (type === 'XMP ') out.push({ source: 'XMP', text: xmpText(utf8(body)) });
    p += 8 + size + (size % 2);
    if (out.length >= MAX_FIELDS) {
      warn('The metadata field-count limit was reached.');
      break;
    }
  }
  return out.filter((m) => m.text);
}

function gifText(bytes: Uint8Array, warn: Warn): MetadataText[] {
  const out: MetadataText[] = [];
  let p = 13 + (bytes[10] & 0x80 ? 3 * 2 ** ((bytes[10] & 7) + 1) : 0);
  while (p < bytes.length) {
    const marker = bytes[p++];
    if (marker === 0x3b) break;
    let comment = false;
    if (marker === 0x21) {
      comment = bytes[p++] === 0xfe;
    } else if (marker === 0x2c) {
      if (p + 9 > bytes.length) break;
      const packed = bytes[p + 8];
      p += 9 + (packed & 0x80 ? 3 * 2 ** ((packed & 7) + 1) : 0) + 1;
    } else {
      warn('GIF metadata parsing stopped at an invalid block.');
      break;
    }
    const parts: string[] = [];
    let length = 0;
    let tooLarge = false;
    while (p < bytes.length && bytes[p]) {
      const size = bytes[p++];
      if (p + size > bytes.length) {
        warn('A GIF metadata block was truncated.');
        return out;
      }
      if (comment) {
        length += size;
        if (length <= MAX_FIELD_BYTES) parts.push(latin1(bytes.subarray(p, p + size)));
        else tooLarge = true;
      }
      p += size;
    }
    p++;
    if (tooLarge) warn('A GIF comment exceeded the inspection limit.');
    else if (comment) out.push({ source: 'GIF comment', text: clean(parts.join('')) });
    if (out.length >= MAX_FIELDS) {
      warn('The metadata field-count limit was reached.');
      break;
    }
  }
  return out.filter((m) => m.text);
}

const EXIF_TAGS: Record<number, string> = {
  0x010e: 'ImageDescription',
  0x010f: 'Make',
  0x0110: 'Model',
  0x0131: 'Software',
  0x013b: 'Artist',
  0x8298: 'Copyright',
  0x9286: 'UserComment',
  0x9c9b: 'XPTitle',
  0x9c9c: 'XPComment',
  0x9c9d: 'XPAuthor',
  0x9c9e: 'XPKeywords',
  0x9c9f: 'XPSubject',
};

/** Text-valued tags from a TIFF/EXIF block (IFD0 and the EXIF sub-IFD). */
export function exifText(tiff: Uint8Array, warn: Warn = quiet): MetadataText[] {
  if (tiff.length < 8) return [];
  if (!(
    (tiff[0] === 0x49 && tiff[1] === 0x49 && tiff[2] === 42 && tiff[3] === 0) ||
    (tiff[0] === 0x4d && tiff[1] === 0x4d && tiff[2] === 0 && tiff[3] === 42)
  )) {
    warn('An EXIF block had an invalid TIFF header.');
    return [];
  }
  const little = tiff[0] === 0x49;
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const u16 = (o: number) => view.getUint16(o, little);
  const u32 = (o: number) => view.getUint32(o, little);
  const out: MetadataText[] = [];
  const visited = new Set<number>();
  let entries = 0;
  const visit = (offset: number, depth: number) => {
    if (depth > 2 || visited.has(offset)) {
      warn('An EXIF directory exceeded the traversal limit or repeated an earlier directory.');
      return;
    }
    if (offset + 2 > tiff.length) {
      warn('An EXIF directory pointed outside the metadata block.');
      return;
    }
    visited.add(offset);
    const count = u16(offset);
    for (let i = 0; i < count; i++) {
      const e = offset + 2 + i * 12;
      if (e + 12 > tiff.length) {
        warn('An EXIF directory was truncated.');
        return;
      }
      if (++entries > 4096 || out.length >= MAX_FIELDS) {
        warn('The EXIF inspection limit was reached.');
        return;
      }
      const tag = u16(e);
      const type = u16(e + 2);
      const n = u32(e + 4);
      if (tag === 0x8769) {
        visit(u32(e + 8), depth + 1);
        continue;
      }
      const name = EXIF_TAGS[tag];
      if (!name) continue;
      const size = type === 2 || type === 7 || type === 1 ? n : 0;
      if (!size) continue;
      if (size > MAX_FIELD_BYTES) {
        warn('An EXIF text field exceeded the inspection limit.');
        continue;
      }
      const start = size <= 4 ? e + 8 : u32(e + 8);
      if (start + size > tiff.length) {
        warn('An EXIF text field pointed outside the metadata block.');
        continue;
      }
      let value = tiff.subarray(start, start + size);
      let text: string;
      if (tag >= 0x9c9b) text = new TextDecoder('utf-16le').decode(value);
      else if (tag === 0x9286) {
        const charset = latin1(value.subarray(0, 8));
        value = value.subarray(8);
        text = charset.startsWith('UNICODE')
          ? new TextDecoder(little ? 'utf-16le' : 'utf-16be').decode(value)
          : utf8(value);
      } else text = utf8(value);
      out.push({ source: `EXIF ${name}`, text: clean(text) });
    }
  };
  visit(u32(4), 0);
  return out.filter((m) => m.text);
}

/** Text content of an XMP packet: element text and attribute values, without the markup. */
export function xmpText(xml: string): string {
  const values = new Set<string>();
  for (const m of xml.matchAll(/>([^<>]+)</g)) {
    const v = decodeEntities(m[1]).trim();
    if (v) values.add(v);
  }
  for (const m of xml.matchAll(
    /\s(?:dc|photoshop|xmp|Iptc4xmpCore|exif|tiff):[\w]+=(?:"([^"]+)"|'([^']+)')/g,
  )) {
    const v = decodeEntities(m[1] ?? m[2]).trim();
    if (v && !/^[\d.:+\-TZ]+$/.test(v) && !/^(?:uuid|xmp\.(?:did|iid)):/i.test(v)) values.add(v);
  }
  return [...values].join('\n');
}

const decodeEntities = (s: string) =>
  s.replace(
    /&(?:#(x[0-9a-f]+|[0-9]+)|(lt|gt|quot|apos|amp));/gi,
    (match, numeric: string | undefined, named: string | undefined) => {
      if (numeric) {
        const value = numeric[0].toLowerCase() === 'x' ? parseInt(numeric.slice(1), 16) : Number(numeric);
        return value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff)
          ? String.fromCodePoint(value)
          : match;
      }
      return ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' } as Record<string, string>)[
        named!.toLowerCase()
      ];
    },
  );
