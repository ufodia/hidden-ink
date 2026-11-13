/**
 * Pixel analyses: "lenses" that make faint or hidden content visible, a
 * detector for low-contrast content, transparency checks and an LSB probe.
 * Everything works on straight RGBA so it runs in a worker and in Node tests.
 */

export interface Rgba {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export type Lens =
  | 'amplify'
  | 'invert'
  | 'equalize'
  | 'red'
  | 'green'
  | 'blue'
  | 'on-black'
  | 'on-white'
  | 'alpha-dropped'
  | 'alpha'
  | 'lsb';

const LUMA = (r: number, g: number, b: number) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

/** Luma of the image as a viewer on a white page would see it. */
export function visibleLuma(img: Rgba): Float32Array {
  const out = new Float32Array(img.width * img.height);
  const d = img.data;
  for (let i = 0; i < out.length; i++) {
    const a = d[i * 4 + 3] / 255;
    out[i] = LUMA(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]) * a + (1 - a);
  }
  return out;
}

/** Box mean with clamped edges, O(n). */
export function boxMean(data: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const size = 2 * r + 1;
  const cx = (x: number) => (x < 0 ? 0 : x >= w ? w - 1 : x);
  const cy = (y: number) => (y < 0 ? 0 : y >= h ? h - 1 : y);
  for (let y = 0; y < h; y++) {
    let s = 0;
    for (let k = -r; k <= r; k++) s += data[y * w + cx(k)];
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = s / size;
      s += data[y * w + cx(x + r + 1)] - data[y * w + cx(x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let k = -r; k <= r; k++) s += tmp[cy(k) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = s / size;
      s += tmp[cy(y + r + 1) * w + x] - tmp[cy(y - r) * w + x];
    }
  }
  return out;
}

const gray = (w: number, h: number, value: (i: number) => number): Rgba => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const v = value(i);
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = v;
    data[i * 4 + 3] = 255;
  }
  return { width: w, height: h, data };
};

/** The radius of the local background estimate: large enough to cover a word. */
export const radiusFor = (w: number, h: number) => Math.max(6, Math.round(Math.max(w, h) / 80));

/**
 * Local contrast amplification: subtract the local background and stretch the
 * remainder so that a 1 % brightness difference becomes clearly visible.
 */
export function amplify(img: Rgba, strength = 1): Rgba {
  const { width: w, height: h } = img;
  const L = visibleLuma(img);
  const mean = boxMean(L, w, h, radiusFor(w, h));
  const dev = new Float32Array(L.length);
  for (let i = 0; i < L.length; i++) dev[i] = Math.abs(L[i] - mean[i]);
  const spread = boxMean(dev, w, h, radiusFor(w, h) * 2);
  return gray(w, h, (i) => {
    const local = Math.max(spread[i], 0.004);
    return 128 + ((L[i] - mean[i]) / local) * 42 * strength;
  });
}

/** Global histogram equalization of luma. */
export function equalize(img: Rgba): Rgba {
  const L = visibleLuma(img);
  const hist = new Uint32Array(256);
  for (const v of L) hist[Math.round(v * 255)]++;
  const cdf = new Float64Array(256);
  let sum = 0;
  for (let i = 0; i < 256; i++) cdf[i] = sum += hist[i];
  const min = cdf.find((v) => v > 0) ?? 0;
  const span = Math.max(1, L.length - min);
  return gray(img.width, img.height, (i) => ((cdf[Math.round(L[i] * 255)] - min) / span) * 255);
}

export function lens(img: Rgba, kind: Lens): Rgba {
  const { width: w, height: h, data: d } = img;
  switch (kind) {
    case 'amplify':
      return amplify(img);
    case 'invert': {
      const a = amplify(img);
      return gray(w, h, (i) => 255 - a.data[i * 4]);
    }
    case 'equalize':
      return equalize(img);
    case 'red':
    case 'green':
    case 'blue': {
      const c = { red: 0, green: 1, blue: 2 }[kind];
      // Stretch the channel's own range so faint differences inside it show up.
      let lo = 255;
      let hi = 0;
      for (let i = 0; i < w * h; i++) {
        lo = Math.min(lo, d[i * 4 + c]);
        hi = Math.max(hi, d[i * 4 + c]);
      }
      const span = Math.max(1, hi - lo);
      return gray(w, h, (i) => ((d[i * 4 + c] - lo) / span) * 255);
    }
    case 'on-black':
    case 'on-white': {
      const bg = kind === 'on-black' ? 0 : 255;
      const data = new Uint8ClampedArray(w * h * 4);
      for (let i = 0; i < w * h; i++) {
        const a = d[i * 4 + 3] / 255;
        for (let c = 0; c < 3; c++) data[i * 4 + c] = d[i * 4 + c] * a + bg * (1 - a);
        data[i * 4 + 3] = 255;
      }
      return { width: w, height: h, data };
    }
    case 'alpha-dropped': {
      const data = new Uint8ClampedArray(d);
      for (let i = 0; i < w * h; i++) data[i * 4 + 3] = 255;
      return { width: w, height: h, data };
    }
    case 'alpha':
      return gray(w, h, (i) => d[i * 4 + 3]);
    case 'lsb':
      return gray(w, h, (i) => ((d[i * 4] & 1) * 4 + (d[i * 4 + 1] & 1) * 2 + (d[i * 4 + 2] & 1)) * 36);
  }
}

// ——— Faint content ———

export interface FaintRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  /** WCAG contrast ratio between the faint content and its background (1 = identical). */
  contrast: number;
  /** Mean absolute brightness difference from the local background, 0..1. */
  delta: number;
}

const TILE = 12;

/**
 * Finds tiles that contain structured content (edges, strokes) whose contrast
 * is too low for a person to notice but far above the image's noise floor.
 */
export function faintRegions(img: Rgba): { regions: FaintRegion[]; noise: number } {
  const { width: w, height: h } = img;
  const L = visibleLuma(img);
  const mean = boxMean(L, w, h, radiusFor(w, h));
  const hp = new Float32Array(L.length);
  for (let i = 0; i < L.length; i++) hp[i] = Math.abs(L[i] - mean[i]);

  // Noise floor: median absolute high-pass value, as a robust estimate.
  const sample: number[] = [];
  const step = Math.max(1, Math.floor(hp.length / 50_000));
  for (let i = 0; i < hp.length; i += step) sample.push(hp[i]);
  sample.sort((a, b) => a - b);
  const noise = sample[Math.floor(sample.length / 2)] ?? 0;
  const low = Math.max(0.0035, noise * 4);

  const tw = Math.ceil(w / TILE);
  const th = Math.ceil(h / TILE);
  // Tiles near clearly visible content are skipped: the local background estimate
  // bends around dark text, which makes the paper next to it look faintly marked.
  const radius = radiusFor(w, h);
  const strongTile = new Uint8Array(tw * th);
  for (let i = 0; i < hp.length; i++)
    if (hp[i] > 0.09) strongTile[Math.floor(Math.floor(i / w) / TILE) * tw + Math.floor((i % w) / TILE)] = 1;
  const reach = Math.ceil(radius / TILE) + 1;
  const nearStrong = new Uint8Array(tw * th);
  for (let ty = 0; ty < th; ty++)
    for (let tx = 0; tx < tw; tx++) {
      if (!strongTile[ty * tw + tx]) continue;
      for (let dy = -reach; dy <= reach; dy++)
        for (let dx = -reach; dx <= reach; dx++) {
          const nx = tx + dx;
          const ny = ty + dy;
          if (nx >= 0 && ny >= 0 && nx < tw && ny < th) nearStrong[ny * tw + nx] = 1;
        }
    }
  const hot = new Uint8Array(tw * th);
  for (let ty = 0; ty < th; ty++)
    for (let tx = 0; tx < tw; tx++) {
      let faint = 0;
      let strong = 0;
      let count = 0;
      for (let y = ty * TILE; y < Math.min(h, (ty + 1) * TILE); y++)
        for (let x = tx * TILE; x < Math.min(w, (tx + 1) * TILE); x++) {
          const v = hp[y * w + x];
          count++;
          if (v > 0.09) strong++;
          else if (v > low) faint++;
        }
      // Faint strokes, and nothing a person would already see in the same tile.
      if (faint / count > 0.05 && strong / count < 0.01 && !nearStrong[ty * tw + tx]) hot[ty * tw + tx] = 1;
    }

  // Group hot tiles (8-connected) and measure each group.
  const seen = new Uint8Array(tw * th);
  const regions: FaintRegion[] = [];
  for (let start = 0; start < hot.length; start++) {
    if (!hot[start] || seen[start]) continue;
    const stack = [start];
    seen[start] = 1;
    let x0 = tw;
    let y0 = th;
    let x1 = 0;
    let y1 = 0;
    let tiles = 0;
    while (stack.length) {
      const t = stack.pop()!;
      const tx = t % tw;
      const ty = (t - tx) / tw;
      tiles++;
      x0 = Math.min(x0, tx);
      y0 = Math.min(y0, ty);
      x1 = Math.max(x1, tx);
      y1 = Math.max(y1, ty);
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = tx + dx;
          const ny = ty + dy;
          if (nx < 0 || ny < 0 || nx >= tw || ny >= th) continue;
          const n = ny * tw + nx;
          if (hot[n] && !seen[n]) {
            seen[n] = 1;
            stack.push(n);
          }
        }
    }
    // Isolated single tiles are usually texture, not writing.
    if (tiles < 3) continue;
    const box = {
      x: x0 * TILE,
      y: y0 * TILE,
      width: Math.min(w, (x1 + 1) * TILE) - x0 * TILE,
      height: Math.min(h, (y1 + 1) * TILE) - y0 * TILE,
    };
    let bg = 0;
    let ink = 0;
    let inkCount = 0;
    let n = 0;
    for (let y = box.y; y < box.y + box.height; y++)
      for (let x = box.x; x < box.x + box.width; x++) {
        const i = y * w + x;
        bg += mean[i];
        n++;
        if (hp[i] > low) {
          ink += L[i];
          inkCount++;
        }
      }
    bg /= n;
    const inkLevel = inkCount ? ink / inkCount : bg;
    regions.push({ ...box, contrast: contrastRatio(bg, inkLevel), delta: Math.abs(bg - inkLevel) });
  }
  regions.sort((a, b) => b.width * b.height - a.width * a.height);
  return { regions, noise };
}

/** WCAG contrast ratio from two sRGB-ish luma values (0..1). */
export function contrastRatio(a: number, b: number): number {
  const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const la = lin(a);
  const lb = lin(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// ——— Transparency ———

export interface AlphaReport {
  /** Share of pixels that are fully or almost fully transparent. */
  transparentShare: number;
  /** Transparent pixels whose colour is not uniform — content a viewer cannot see. */
  hiddenShare: number;
  /** Mean visible difference between compositing on black and on white, 0..1. */
  backgroundDependence: number;
}

export function alphaReport(img: Rgba): AlphaReport {
  const d = img.data;
  const n = img.width * img.height;
  let transparent = 0;
  let semi = 0;
  let sumL = 0;
  let sumL2 = 0;
  let dependence = 0;
  for (let i = 0; i < n; i++) {
    const a = d[i * 4 + 3];
    if (a < 255) dependence += 1 - a / 255;
    if (a < 8) {
      transparent++;
      const l = LUMA(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]);
      sumL += l;
      sumL2 += l * l;
    } else if (a < 250) semi++;
  }
  const variance = transparent ? sumL2 / transparent - (sumL / transparent) ** 2 : 0;
  // Only count hidden content when the transparent colours actually vary.
  let hidden = 0;
  if (transparent && variance > 0.0004) {
    const meanL = sumL / transparent;
    for (let i = 0; i < n; i++)
      if (d[i * 4 + 3] < 8 && Math.abs(LUMA(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]) - meanL) > 0.08) hidden++;
  }
  void semi;
  return { transparentShare: transparent / n, hiddenShare: hidden / n, backgroundDependence: dependence / n };
}

// ——— Least-significant-bit messages ———

export interface LsbMessage {
  layout: string;
  text: string;
}

const printable = (b: number) => (b >= 32 && b < 127) || b === 9 || b === 10 || b === 13;

/**
 * Simple steganography tools write a message into the lowest bit of each
 * colour value, starting at the first pixel. Read those bits in the common
 * orders and keep any run of readable text.
 */
export function probeLsb(img: Rgba, minLength = 12): LsbMessage[] {
  const d = img.data;
  const n = img.width * img.height;
  const layouts: { name: string; channels: number[] }[] = [
    { name: 'RGB bits, row by row', channels: [0, 1, 2] },
    { name: 'RGBA bits, row by row', channels: [0, 1, 2, 3] },
    { name: 'red channel bits', channels: [0] },
    { name: 'blue channel bits', channels: [2] },
  ];
  const found: LsbMessage[] = [];
  for (const layout of layouts) {
    const maxBytes = Math.min(4096, Math.floor((n * layout.channels.length) / 8));
    const bytes: number[] = [];
    let bit = 0;
    let byte = 0;
    outer: for (let i = 0; i < n; i++)
      for (const c of layout.channels) {
        byte = (byte << 1) | (d[i * 4 + c] & 1);
        if (++bit === 8) {
          bytes.push(byte);
          bit = 0;
          byte = 0;
          if (bytes.length >= maxBytes) break outer;
        }
      }
    // Some tools prefix a 32-bit length; skip up to 4 leading bytes.
    for (const skip of [0, 4]) {
      let end = skip;
      while (end < bytes.length && printable(bytes[end])) end++;
      if (end - skip >= minLength) {
        const text = String.fromCharCode(...bytes.slice(skip, end)).trim();
        if (/[a-z]{3,}/i.test(text) && (text.match(/[a-z ]/gi)?.length ?? 0) / text.length > 0.7) {
          found.push({ layout: layout.name, text });
          break;
        }
      }
    }
  }
  return found;
}

/** Hide a message in the RGB low bits (used by tests and the demo). */
export function embedLsb(img: Rgba, message: string): Rgba {
  const data = new Uint8ClampedArray(img.data);
  const bits: number[] = [];
  for (const ch of message + '\u0000') for (let b = 7; b >= 0; b--) bits.push((ch.charCodeAt(0) >> b) & 1);
  let k = 0;
  for (let i = 0; i < img.width * img.height && k < bits.length; i++)
    for (let c = 0; c < 3 && k < bits.length; c++) data[i * 4 + c] = (data[i * 4 + c] & 0xfe) | bits[k++];
  return { ...img, data };
}
