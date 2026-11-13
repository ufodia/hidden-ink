import type { Rgba } from './pixels.ts';

/**
 * Area-average downscale on straight (non-premultiplied) RGBA. Canvas scaling
 * would premultiply and erase colour stored under full transparency.
 */
export function downscale(img: Rgba, maxSide: number): Rgba {
  const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
  if (scale === 1) return img;
  const width = Math.max(1, Math.round(img.width * scale));
  const height = Math.max(1, Math.round(img.height * scale));
  const out = new Uint8ClampedArray(width * height * 4);
  const sx = img.width / width;
  const sy = img.height / height;
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      const sum = [0, 0, 0, 0];
      let n = 0;
      for (let yy = y0; yy < y1; yy++)
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * img.width + xx) * 4;
          for (let c = 0; c < 4; c++) sum[c] += img.data[i + c];
          n++;
        }
      const o = (y * width + x) * 4;
      for (let c = 0; c < 4; c++) out[o + c] = sum[c] / n;
    }
  }
  return { width, height, data: out };
}
