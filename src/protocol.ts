import type { Box } from './core/findings.ts';
import type { AlphaReport, FaintRegion, Lens, LsbMessage } from './core/pixels.ts';

/** Page → worker. */
export type WorkerRequest =
  | {
      type: 'analyze';
      job: number;
      rgba: ArrayBuffer;
      width: number;
      height: number;
      rawPixels: boolean;
      lowBitsChecked: boolean;
    }
  | { type: 'lens'; job: number; lens: Lens | 'original' }
  | { type: 'sanitize'; job: number; boxes: Box[] };

export interface PixelAnalysis {
  width: number;
  height: number;
  /** Working size used for lenses, faint regions and OCR. */
  workWidth: number;
  workHeight: number;
  rawPixels: boolean;
  lowBitsChecked: boolean;
  faint: FaintRegion[];
  noise: number;
  alpha: AlphaReport;
  lsb: LsbMessage[];
}

/** Worker → page. */
export type WorkerResponse =
  | { type: 'analysis'; job: number; analysis: PixelAnalysis }
  | {
      type: 'image';
      job: number;
      lens: Lens | 'original' | 'clean';
      rgba: ArrayBuffer;
      width: number;
      height: number;
    }
  | { type: 'error'; job: number; message: string };
