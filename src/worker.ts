import { sanitize } from './core/findings.ts';
import { alphaReport, faintRegions, lens, probeLsb, type Lens, type Rgba } from './core/pixels.ts';
import { downscale } from './core/resample.ts';
import type { WorkerRequest, WorkerResponse } from './protocol.ts';

/** Analysis resolution: large enough for small hidden print, small enough for OCR speed. */
const WORK_SIDE = 1600;

let full: Rgba | null = null;
let work: Rgba | null = null;

const scope = self as unknown as { postMessage(message: WorkerResponse, transfer?: Transferable[]): void };
const post = (message: WorkerResponse, transfer: Transferable[] = []) => scope.postMessage(message, transfer);

function sendImage(job: number, kind: Lens | 'original' | 'clean', img: Rgba) {
  const copy = img.data.slice();
  post(
    {
      type: 'image',
      job,
      lens: kind,
      rgba: copy.buffer as ArrayBuffer,
      width: img.width,
      height: img.height,
    },
    [copy.buffer as ArrayBuffer],
  );
}

self.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  try {
    if (request.type === 'analyze') {
      full = { width: request.width, height: request.height, data: new Uint8ClampedArray(request.rgba) };
      // Low bits and transparency are read at full resolution, before any resampling.
      const lsb = request.lowBitsChecked ? probeLsb(full) : [];
      const alpha = alphaReport(full);
      work = downscale(full, WORK_SIDE);
      const { regions, noise } = faintRegions(work);
      post({
        type: 'analysis',
        job: request.job,
        analysis: {
          width: full.width,
          height: full.height,
          workWidth: work.width,
          workHeight: work.height,
          rawPixels: request.rawPixels,
          lowBitsChecked: request.lowBitsChecked,
          faint: regions,
          noise,
          alpha,
          lsb,
        },
      });
    } else if (request.type === 'lens') {
      if (!work) throw new Error('Open an image first.');
      sendImage(request.job, request.lens, request.lens === 'original' ? work : lens(work, request.lens));
    } else if (request.type === 'sanitize') {
      if (!full || !work) throw new Error('Open an image first.');
      const fx = full.width / work.width;
      const fy = full.height / work.height;
      const boxes = request.boxes.map((b) => ({
        x: Math.floor(b.x * fx),
        y: Math.floor(b.y * fy),
        width: Math.ceil(b.width * fx),
        height: Math.ceil(b.height * fy),
      }));
      sendImage(request.job, 'clean', sanitize(full, boxes, Date.now()));
    }
  } catch (error) {
    post({
      type: 'error',
      job: request.job,
      message:
        error instanceof RangeError
          ? 'This image is too large for this browser tab.'
          : String((error as Error).message || error),
    });
  }
});
