import './style.css';
import { createWorker, type Worker as OcrWorker } from 'tesseract.js';
import { buildFindings, verdictOf, type Finding, type OcrLine, type Verdict } from './core/findings.ts';
import { readMetadata, sniff, type Format, type MetadataText } from './core/metadata.ts';
import { decodePng, PngUnsupportedError } from './core/png.ts';
import type { Lens } from './core/pixels.ts';
import { reportJson } from './core/report.ts';
import { demoPng } from './demo.ts';
import { byId, download, h } from './dom.ts';
import type { PixelAnalysis, WorkerRequest, WorkerResponse } from './protocol.ts';

const MAX_BYTES = 60 * 1024 * 1024;
const MAX_PIXELS = 40_000_000;

type View = Lens | 'original';

const LENSES: { id: View; label: string; help: string; alphaOnly?: boolean }[] = [
  {
    id: 'original',
    label: 'Original',
    help: 'The image as people see it. Transparent areas show a checkerboard.',
  },
  {
    id: 'amplify',
    label: 'Amplify',
    help: 'Local contrast amplified: a 1 % brightness difference becomes obvious. Faint ink shows up here.',
  },
  {
    id: 'invert',
    label: 'Invert',
    help: 'The amplified view inverted. Some faint text reads more easily in negative.',
  },
  {
    id: 'equalize',
    label: 'Equalize',
    help: 'Global histogram equalization spreads every brightness level across the full range.',
  },
  { id: 'red', label: 'Red', help: 'The red channel alone, stretched to its own range.' },
  { id: 'green', label: 'Green', help: 'The green channel alone, stretched to its own range.' },
  { id: 'blue', label: 'Blue', help: 'The blue channel alone, stretched to its own range.' },
  {
    id: 'alpha-dropped',
    label: 'Alpha dropped',
    help: 'What a pipeline sees when it discards transparency and keeps the raw colour — common in AI preprocessing.',
  },
  {
    id: 'on-black',
    label: 'On black',
    help: 'Composited on black. Content that only appears on dark backgrounds shows here.',
  },
  { id: 'on-white', label: 'On white', help: 'Composited on white, as most viewers display it.' },
  { id: 'alpha', label: 'Alpha map', help: 'Transparency as brightness: black is fully transparent.' },
  {
    id: 'lsb',
    label: 'Low bits',
    help: 'The lowest bit of each colour channel. Natural photos look like noise; structured patterns suggest hidden data.',
  },
];

const VERDICT: Record<Verdict, { title: string; text: string }> = {
  injection: {
    title: 'Hidden instructions found',
    text: 'Detected text matches instruction rules. This is a review signal, not proof that a model will obey it. Check the context before passing the image to an agent.',
  },
  'hidden-text': {
    title: 'Hidden text found',
    text: 'Text was found in enhanced views or low bits. Compare it with the original: OCR differences can produce false positives.',
  },
  'hidden-content': {
    title: 'Hidden content found',
    text: 'Faint or transparent content is present. Inspect it with the lenses before trusting the image.',
  },
  clean: {
    title: 'Nothing hidden found',
    text: 'No hidden content was detected by the completed checks. Missed content and visible instructions are still possible; check the OCR status and coverage notes.',
  },
};

const SOURCE_LABEL: Record<Finding['source'], string> = {
  'faint-text': 'Faint ink',
  transparency: 'Transparency',
  metadata: 'Metadata',
  lsb: 'Low bits',
  'faint-region': 'Faint content',
};

let worker: Worker | null = null;
let job = 0;
let fileName = '';
let fileBytes = 0;
let format: Format = 'other';
let metadata: MetadataText[] = [];
let analysis: PixelAnalysis | null = null;
let findings: Finding[] = [];
let view: View = 'original';
let ocrStatus: 'idle' | 'running' | 'done' | 'failed' = 'idle';
let ocrMessage = '';
let ocr: { visible?: OcrLine[]; revealed?: OcrLine[]; alphaDropped?: OcrLine[] } = {};
let selected: string | null = null;
let inspectionWarnings: string[] = [];
const lensCache = new Map<string, HTMLCanvasElement>();
class ScanCancelled extends Error {}
const pending = new Map<
  string,
  {
    promise: Promise<HTMLCanvasElement>;
    resolve: (canvas: HTMLCanvasElement) => void;
    reject: (error: Error) => void;
  }
>();
let ocrWorker: Promise<OcrWorker> | null = null;

const intro = byId('intro');
const workspace = byId('workspace');
const introError = byId('intro-error');

// ——— Pixel worker ———

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  const current = worker;
  current.addEventListener('message', (event: MessageEvent<WorkerResponse>) => {
    if (worker === current) onMessage(event.data);
  });
  current.addEventListener('error', () => {
    if (worker !== current) return;
    rejectLenses(new Error('The analysis engine stopped unexpectedly. Open the image again.'));
    current.terminate();
    worker = null;
    fail('The analysis engine stopped unexpectedly. Open the image again.');
  });
  return worker;
}
const send = (request: WorkerRequest, transfer: Transferable[] = []) =>
  getWorker().postMessage(request, transfer);

function onMessage(message: WorkerResponse) {
  if (message.job !== job) return;
  if (message.type === 'analysis') {
    analysis = message.analysis;
    refresh();
    void runOcr(job);
  } else if (message.type === 'image') {
    const canvas = h('canvas', { width: message.width, height: message.height });
    canvas
      .getContext('2d')!
      .putImageData(new ImageData(new Uint8ClampedArray(message.rgba), message.width, message.height), 0, 0);
    if (message.lens === 'clean') {
      const name = cleanName();
      canvas.toBlob((blob) => {
        if (message.job === job && blob) saveBlob(blob, name);
      }, 'image/png');
      return;
    }
    lensCache.set(message.lens, canvas);
    pending.get(message.lens)?.resolve(canvas);
    pending.delete(message.lens);
  } else if (message.type === 'error') {
    rejectLenses(new Error(message.message));
    fail(message.message);
  }
}

function rejectLenses(error: Error) {
  for (const request of pending.values()) request.reject(error);
  pending.clear();
}

function lensCanvas(kind: View, forJob = job): Promise<HTMLCanvasElement> {
  if (forJob !== job) return Promise.reject(new ScanCancelled());
  const cached = lensCache.get(kind);
  if (cached) return Promise.resolve(cached);
  const existing = pending.get(kind);
  if (existing) return existing.promise;
  let resolve!: (canvas: HTMLCanvasElement) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<HTMLCanvasElement>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  pending.set(kind, { promise, resolve, reject });
  send({ type: 'lens', job: forJob, lens: kind });
  return promise;
}

// ——— Opening files ———

function clearScan() {
  job++;
  worker?.terminate();
  worker = null;
  const oldOcr = ocrWorker;
  ocrWorker = null;
  if (oldOcr) void oldOcr.then((engine) => engine.terminate()).catch(() => {});
  rejectLenses(new ScanCancelled());
  lensCache.clear();
  metadata = [];
  inspectionWarnings = [];
  analysis = null;
  findings = [];
  ocr = {};
  ocrStatus = 'idle';
  ocrMessage = '';
  selected = null;
  stage = null;
  view = 'original';
  fileName = '';
  fileBytes = 0;
  format = 'other';
  workspace.replaceChildren();
}

async function open(name: string, load: () => Promise<Uint8Array>, size?: number) {
  clearScan();
  const forJob = job;
  introError.hidden = true;
  if (size !== undefined && size > MAX_BYTES) return fail('This file is larger than 60 MB.');
  fileName = name;
  intro.hidden = true;
  workspace.hidden = false;
  workspace.replaceChildren(
    h(
      'div',
      { class: 'loading' },
      h('div', { class: 'spinner', 'aria-hidden': 'true' }),
      h('p', { role: 'status' }, 'Reading pixels and metadata…'),
    ),
  );
  try {
    const data = await load();
    if (forJob !== job) return;
    if (data.length > MAX_BYTES) throw new Error('This file is larger than 60 MB.');
    fileBytes = data.length;
    const currentFormat = sniff(data);
    format = currentFormat;
    const warnings: string[] = [];
    const currentMetadata = await readMetadata(data, (message) => warnings.push(message));
    if (forJob !== job) return;
    const raw = await decode(data, currentFormat, name, warnings);
    if (forJob !== job) return;
    if (raw.width * raw.height > MAX_PIXELS) throw new Error('This image has more than 40 megapixels.');
    metadata = currentMetadata;
    inspectionWarnings = [...new Set(warnings)];
    send(
      {
        type: 'analyze',
        job: forJob,
        rgba: raw.rgba.buffer as ArrayBuffer,
        width: raw.width,
        height: raw.height,
        rawPixels: raw.rawPixels,
        lowBitsChecked: raw.lowBitsChecked,
      },
      [raw.rgba.buffer as ArrayBuffer],
    );
  } catch (error) {
    if (forJob !== job) return;
    fail((error as Error).message);
  }
}

/** PNGs are decoded from the file so colour under transparency and exact low bits survive. */
async function decode(
  data: Uint8Array,
  currentFormat: Format,
  name: string,
  warnings: string[],
): Promise<{
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
  rawPixels: boolean;
  lowBitsChecked: boolean;
}> {
  if (currentFormat === 'png') {
    try {
      const raw = await decodePng(data);
      if (raw.bitDepth === 16)
        warnings.push(
          '16-bit PNG colour is reduced to 8 bits for analysis; exact source low bits are not checked.',
        );
      return { ...raw, rawPixels: true, lowBitsChecked: raw.bitDepth === 8 };
    } catch (error) {
      if (!(error instanceof PngUnsupportedError)) throw error;
      warnings.push(
        'This PNG layout needs browser decoding, which can erase transparent colour. Raw transparency and exact low-bit inspection are unavailable.',
      );
    }
  } else {
    warnings.push(
      'This image uses browser-decoded pixels. Raw transparency and exact low-bit inspection require a supported PNG.',
    );
    if (currentFormat === 'gif')
      warnings.push('Only one browser-decoded frame is inspected; other animation frames are not checked.');
    if (currentFormat === 'other')
      warnings.push('Metadata inspection is not supported for this file format.');
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([data as Uint8Array<ArrayBuffer>]), {
      premultiplyAlpha: 'none',
    });
  } catch {
    throw new Error(`${name} could not be decoded as an image.`);
  }
  if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > MAX_PIXELS) {
    bitmap.close();
    throw new Error('This image has invalid dimensions or more than 40 megapixels.');
  }
  const canvas = h('canvas', { width: bitmap.width, height: bitmap.height });
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return {
    width: image.width,
    height: image.height,
    rgba: image.data,
    rawPixels: false,
    lowBitsChecked: false,
  };
}

function fail(message: string) {
  if (analysis) {
    toast(message);
    return;
  }
  workspace.hidden = true;
  intro.hidden = false;
  introError.textContent = message;
  introError.hidden = false;
}

function toast(message: string) {
  const note = h('div', { class: 'toast', role: 'status' }, message);
  document.body.append(note);
  setTimeout(() => note.remove(), 4500);
}

const fileInput = byId<HTMLInputElement>('file-input');
fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  fileInput.value = '';
  if (file) await openFile(file);
});
const openFile = (file: File) =>
  open(file.name || 'pasted-image.png', async () => new Uint8Array(await file.arrayBuffer()), file.size);
byId('demo-button').addEventListener('click', () => void open('poisoned-banner-demo.png', demoPng));
window.addEventListener('dragover', (event) => {
  event.preventDefault();
  document.body.classList.add('dragging');
});
window.addEventListener('dragleave', (event) => {
  if (event.relatedTarget === null) document.body.classList.remove('dragging');
});
window.addEventListener('drop', async (event) => {
  event.preventDefault();
  document.body.classList.remove('dragging');
  const file = event.dataTransfer?.files[0];
  if (file) await openFile(file);
});
window.addEventListener('paste', async (event) => {
  const file = [...(event.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'));
  if (file) {
    event.preventDefault();
    await openFile(file);
  }
});

// ——— OCR ———

function getOcr(forJob: number): Promise<OcrWorker> {
  if (forJob !== job) return Promise.reject(new ScanCancelled());
  if (!ocrWorker) {
    const base = new URL('ocr/', document.baseURI).href;
    ocrWorker = createWorker('eng', 1, {
      workerPath: base + 'worker.min.js',
      corePath: base + 'core',
      langPath: base,
      workerBlobURL: false,
      cacheMethod: 'none',
      logger: (m: { status: string; progress: number }) => {
        if (forJob === job && ocrStatus === 'running' && m.status === 'recognizing text')
          setOcrMessage(`${ocrMessage.split(' — ')[0]} — ${Math.round(m.progress * 100)} %`);
      },
    });
  }
  return ocrWorker;
}

function setOcrMessage(text: string) {
  ocrMessage = text;
  const node = document.getElementById('ocr-status');
  if (node) node.textContent = text;
}

interface TesseractLine {
  text: string;
  confidence: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

async function recognize(canvas: HTMLCanvasElement, forJob: number): Promise<OcrLine[]> {
  const engine = await getOcr(forJob);
  if (forJob !== job) throw new ScanCancelled();
  const { data } = await engine.recognize(canvas, {}, { text: true, blocks: true });
  const blocks =
    (data as unknown as { blocks?: { paragraphs: { lines: TesseractLine[] }[] }[] }).blocks ?? [];
  return blocks.flatMap((b) =>
    b.paragraphs.flatMap((p) =>
      p.lines.map((l) => ({
        text: l.text.replace(/\s+/g, ' ').trim(),
        confidence: l.confidence,
        box: { x: l.bbox.x0, y: l.bbox.y0, width: l.bbox.x1 - l.bbox.x0, height: l.bbox.y1 - l.bbox.y0 },
      })),
    ),
  );
}

async function runOcr(forJob: number) {
  if (!analysis || forJob !== job) return;
  ocrStatus = 'running';
  const steps: [keyof typeof ocr, View, string][] = [
    ['visible', 'on-white', 'Reading visible text'],
    ['revealed', 'amplify', 'Reading amplified text'],
  ];
  if (analysis.alpha.transparentShare > 0.001)
    steps.push(['alphaDropped', 'alpha-dropped', 'Reading under transparency']);
  try {
    for (const [key, kind, label] of steps) {
      setOcrMessage(`${label} (${steps.findIndex((s) => s[0] === key) + 1}/${steps.length})`);
      const canvas = await lensCanvas(kind, forJob);
      if (forJob !== job) return;
      const lines = await recognize(canvas, forJob);
      if (forJob !== job) return;
      ocr[key] = lines;
    }
    ocrStatus = 'done';
    setOcrMessage('Local OCR finished');
  } catch {
    if (forJob !== job) return;
    ocrStatus = 'failed';
    setOcrMessage('OCR could not start; pixel, transparency, low-bit and metadata checks still ran.');
  }
  refresh();
}

// ——— Rendering ———

function refresh() {
  if (!analysis) return;
  findings = buildFindings({
    faint: analysis.faint,
    alpha: analysis.alpha,
    lsb: analysis.lsb,
    metadata,
    visibleOcr: ocr.visible,
    revealedOcr: ocr.revealed,
    alphaDroppedOcr: ocr.alphaDropped,
  });
  render();
}

let stage: HTMLCanvasElement | null = null;

function render() {
  if (!analysis) return;
  const focusedLens =
    document.activeElement instanceof HTMLButtonElement ? document.activeElement.dataset.lens : undefined;
  const a = analysis;
  const verdict = verdictOf(findings);
  const lensBar = h('div', { class: 'lensbar', role: 'tablist', 'aria-label': 'Lenses' });
  for (const l of LENSES)
    lensBar.append(
      h(
        'button',
        {
          type: 'button',
          role: 'tab',
          class: 'lens',
          'data-lens': l.id,
          'aria-selected': String(view === l.id),
          tabindex: view === l.id ? '0' : '-1',
          id: `lens-${l.id}`,
          'aria-controls': 'image-panel',
          title: l.help,
          onclick: () => void setView(l.id),
          onkeydown: (event: Event) => {
            const key = (event as KeyboardEvent).key;
            const index = LENSES.findIndex((item) => item.id === l.id);
            const next =
              key === 'Home'
                ? 0
                : key === 'End'
                  ? LENSES.length - 1
                  : key === 'ArrowRight'
                    ? (index + 1) % LENSES.length
                    : key === 'ArrowLeft'
                      ? (index + LENSES.length - 1) % LENSES.length
                      : -1;
            if (next < 0) return;
            event.preventDefault();
            void setView(LENSES[next].id);
            workspace.querySelector<HTMLButtonElement>(`[data-lens="${LENSES[next].id}"]`)?.focus();
          },
        },
        l.label,
      ),
    );
  stage = h('canvas', {
    id: 'stage',
    width: a.workWidth,
    height: a.workHeight,
    role: 'img',
    'aria-label': 'Image with the selected lens',
  });
  const help = h('p', { id: 'lens-help', class: 'lens-help' }, LENSES.find((l) => l.id === view)!.help);

  const boxed = findings.filter((f) => f.box);
  const list = h('ol', { class: 'findings' }, ...findings.map((f) => findingCard(f, boxed.indexOf(f) + 1)));

  const panel = h(
    'aside',
    { class: 'panel' },
    h(
      'section',
      { class: `verdict v-${verdict}` },
      h('p', { class: 'eyebrow' }, 'Verdict'),
      h('h2', {}, VERDICT[verdict].title),
      h('p', {}, VERDICT[verdict].text),
      inspectionWarnings.length
        ? h(
            'div',
            { class: 'coverage-notes', role: 'status' },
            h('strong', {}, 'Inspection coverage'),
            h('ul', {}, ...inspectionWarnings.map((warning) => h('li', {}, warning))),
          )
        : null,
      h(
        'p',
        { class: `ocr ocr-${ocrStatus}`, id: 'ocr-status', role: 'status' },
        ocrStatus === 'running'
          ? ocrMessage
          : ocrStatus === 'done'
            ? 'Local OCR finished'
            : ocrStatus === 'failed'
              ? ocrMessage
              : 'Preparing local OCR…',
      ),
    ),
    h(
      'section',
      { class: 'facts' },
      ...facts(a).map(([k, v]) => h('div', {}, h('dt', {}, k), h('dd', {}, v))),
    ),
    h(
      'section',
      {},
      h(
        'h3',
        {},
        findings.length ? `${findings.length} finding${findings.length === 1 ? '' : 's'}` : 'No findings',
      ),
      findings.length
        ? list
        : h(
            'p',
            { class: 'muted' },
            'Nothing hidden was detected by the pixel, transparency, low-bit or metadata checks.',
          ),
    ),
    h(
      'section',
      { class: 'exports' },
      h('h3', {}, 'Export'),
      h(
        'button',
        {
          class: 'button small primary',
          type: 'button',
          onclick: () =>
            send({
              type: 'sanitize',
              job,
              boxes: findings.filter((f) => f.box && f.source !== 'metadata').map((f) => f.box!),
            }),
        },
        'Clean copy (PNG)',
      ),
      h(
        'p',
        { class: 'fine' },
        'Flattens transparency, smooths flagged faint areas, scrambles the lowest bits and drops all metadata.',
      ),
      h(
        'p',
        { class: 'fine' },
        'Visible instructions and missed content can remain. Review the exported image and scan it again before use.',
      ),
      h(
        'button',
        {
          class: 'button small',
          type: 'button',
          onclick: () =>
            download(
              'hidden-ink-report.json',
              reportJson({
                fileName,
                format,
                bytes: fileBytes,
                analysis: a,
                metadata,
                findings,
                verdict,
                ocrStatus,
                warnings: inspectionWarnings,
              }),
            ),
        },
        'Report (JSON)',
      ),
      h(
        'button',
        {
          class: 'button small',
          type: 'button',
          onclick: () => {
            const forJob = job;
            const name = `hidden-ink-${view}.png`;
            stage?.toBlob((blob) => {
              if (forJob === job && blob) saveBlob(blob, name);
            }, 'image/png');
          },
        },
        'This view (PNG)',
      ),
    ),
  );

  const head = h(
    'div',
    { class: 'ws-head' },
    h('div', {}, h('p', { class: 'eyebrow' }, 'Scanned image'), h('h1', {}, fileName)),
    h(
      'button',
      { class: 'button ghost small', type: 'button', onclick: () => reset() },
      'Scan another image',
    ),
  );
  workspace.replaceChildren(
    head,
    h(
      'div',
      { class: 'ws-grid' },
      h(
        'div',
        { class: 'viewer' },
        lensBar,
        h(
          'div',
          {
            class: 'stage-wrap',
            id: 'image-panel',
            role: 'tabpanel',
            tabindex: '0',
            'aria-labelledby': `lens-${view}`,
          },
          stage,
        ),
        help,
      ),
      panel,
    ),
  );
  if (focusedLens)
    workspace
      .querySelector<HTMLButtonElement>(`[data-lens="${focusedLens}"]`)
      ?.focus({ preventScroll: true });
  void draw();
}

function facts(a: PixelAnalysis): [string, string][] {
  return [
    ['Format', `${format.toUpperCase()} · ${a.width} × ${a.height} px · ${(fileBytes / 1024).toFixed(0)} KB`],
    [
      'Metadata',
      metadata.length ? `${metadata.length} text field${metadata.length === 1 ? '' : 's'}` : 'No text fields',
    ],
    [
      'Transparency',
      a.alpha.transparentShare
        ? `${(a.alpha.transparentShare * 100).toFixed(1)} % transparent${a.alpha.hiddenShare ? `, ${(a.alpha.hiddenShare * 100).toFixed(1)} % carrying hidden colour` : ''}`
        : 'Fully opaque',
    ],
    ['Faint content', a.faint.length ? `${a.faint.length} region${a.faint.length === 1 ? '' : 's'}` : 'None'],
    [
      'Low bits',
      a.lsb.length
        ? 'Readable message found'
        : a.lowBitsChecked
          ? 'No readable message'
          : 'Not checked: exact source bits unavailable',
    ],
  ];
}

async function setView(next: View) {
  view = next;
  for (const b of workspace.querySelectorAll<HTMLButtonElement>('.lens')) {
    b.setAttribute('aria-selected', String(b.dataset.lens === view));
    b.tabIndex = b.dataset.lens === view ? 0 : -1;
  }
  document.getElementById('image-panel')?.setAttribute('aria-labelledby', `lens-${view}`);
  const help = document.getElementById('lens-help');
  if (help) help.textContent = LENSES.find((l) => l.id === view)!.help;
  await draw();
}

async function draw() {
  if (!stage) return;
  const target = stage;
  const forJob = job;
  const kind = view;
  let canvas: HTMLCanvasElement;
  try {
    canvas = await lensCanvas(kind, forJob);
  } catch (error) {
    if (!(error instanceof ScanCancelled) && forJob === job)
      toast('The selected view could not be prepared. Open the image again.');
    return;
  }
  if (target !== stage || forJob !== job || kind !== view) return;
  const ctx = target.getContext('2d')!;
  ctx.clearRect(0, 0, target.width, target.height);
  ctx.drawImage(canvas, 0, 0);
  const px = target.width / Math.max(1, target.getBoundingClientRect().width || target.width);
  let n = 0;
  for (const f of findings) {
    if (!f.box) continue;
    n++;
    const active = f.id === selected;
    const color = f.severity === 'high' ? '#ff5d5d' : f.severity === 'medium' ? '#ffd166' : '#7aa2ff';
    ctx.strokeStyle = color;
    ctx.lineWidth = (active ? 4 : 2) * px;
    ctx.setLineDash(f.source === 'faint-region' ? [6 * px, 4 * px] : []);
    ctx.strokeRect(f.box.x - 4 * px, f.box.y - 4 * px, f.box.width + 8 * px, f.box.height + 8 * px);
    ctx.setLineDash([]);
    const size = 22 * px;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(f.box.x - 4 * px, Math.max(0, f.box.y - 4 * px - size), size, size, 6 * px);
    ctx.fill();
    ctx.fillStyle = '#121212';
    ctx.font = `800 ${13 * px}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(
      String(n),
      f.box.x - 4 * px + size / 2,
      Math.max(0, f.box.y - 4 * px - size) + size / 2 + px,
    );
  }
}

/** Text with the phrases that triggered instruction rules highlighted. */
function highlighted(text: string, matches: string[]) {
  const node = h('p', { class: 'hidden-text' });
  const ranges: [number, number][] = [];
  const lower = text.toLowerCase();
  for (const m of matches) {
    const at = lower.indexOf(m.toLowerCase());
    if (at >= 0) ranges.push([at, at + m.length]);
  }
  ranges.sort((x, y) => x[0] - y[0]);
  let pos = 0;
  for (const [start, end] of ranges) {
    if (start < pos) continue;
    node.append(text.slice(pos, start), h('mark', {}, text.slice(start, end)));
    pos = end;
  }
  node.append(text.slice(pos));
  return node;
}

function findingCard(f: Finding, number: number) {
  const s = f.instruction;
  return h(
    'li',
    { class: `finding sev-${f.severity} ${selected === f.id ? 'active' : ''}` },
    h(
      'header',
      {},
      f.box
        ? h('span', { class: 'badge' }, String(number))
        : h('span', { class: 'badge muted-badge', 'aria-hidden': 'true' }, '•'),
      h('div', {}, h('strong', {}, f.title), h('span', { class: 'where' }, f.where)),
      h('span', { class: 'chip' }, SOURCE_LABEL[f.source]),
    ),
    f.text
      ? highlighted(
          f.text,
          s.hits.map((x) => x.match),
        )
      : null,
    f.text
      ? h(
          'div',
          { class: `meter-row level-${s.level}` },
          h('div', { class: 'meter', 'aria-hidden': 'true' }, h('span', { style: `width:${s.score}%` })),
          h(
            'span',
            {},
            s.level === 'instruction'
              ? `Instruction · ${s.score}`
              : s.level === 'possible'
                ? `Possible instruction · ${s.score}`
                : `Plain text · ${s.score}`,
          ),
        )
      : null,
    s.hits.length ? h('ul', { class: 'rules' }, ...s.hits.map((x) => h('li', {}, x.label))) : null,
    h(
      'div',
      { class: 'actions' },
      f.box
        ? h(
            'button',
            {
              type: 'button',
              class: 'link',
              onclick: () => {
                selected = selected === f.id ? null : f.id;
                const best: View =
                  f.source === 'transparency'
                    ? 'alpha-dropped'
                    : f.source === 'faint-text' || f.source === 'faint-region'
                      ? 'amplify'
                      : view;
                render();
                void setView(best);
                stage?.scrollIntoView({ behavior: 'smooth', block: 'center' });
              },
            },
            'Show on image',
          )
        : null,
      f.text
        ? h(
            'button',
            {
              type: 'button',
              class: 'link',
              onclick: () => void copyText(f.text!),
            },
            'Copy text',
          )
        : null,
    ),
  );
}

function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = h('a', { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function copyText(text: string) {
  try {
    if (!navigator.clipboard) throw new Error('Clipboard unavailable.');
    await navigator.clipboard.writeText(text);
    toast('Copied.');
  } catch {
    toast('Clipboard access was blocked. Select the finding text and copy it manually.');
  }
}

const cleanName = () => `${fileName.replace(/\.[^.]+$/, '') || 'image'}-clean.png`;

function reset() {
  clearScan();
  workspace.hidden = true;
  workspace.replaceChildren();
  intro.hidden = false;
  introError.hidden = true;
  byId('demo-button').focus();
}
