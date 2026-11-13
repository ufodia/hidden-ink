import { scoreInstruction, type InstructionScore } from './instructions.ts';
import type { MetadataText } from './metadata.ts';
import {
  boxMean,
  visibleLuma,
  type AlphaReport,
  type FaintRegion,
  type LsbMessage,
  type Rgba,
} from './pixels.ts';

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OcrLine {
  text: string;
  confidence: number;
  box: Box;
}

export type Source = 'faint-text' | 'transparency' | 'metadata' | 'lsb' | 'faint-region';
export type Severity = 'high' | 'medium' | 'low';

export interface Finding {
  id: string;
  source: Source;
  title: string;
  where: string;
  text?: string;
  box?: Box;
  /** WCAG contrast ratio of faint content against its background. */
  contrast?: number;
  instruction: InstructionScore;
  severity: Severity;
}

export type Verdict = 'injection' | 'hidden-text' | 'hidden-content' | 'clean';

export interface Inputs {
  faint: FaintRegion[];
  alpha: AlphaReport;
  lsb: LsbMessage[];
  metadata: MetadataText[];
  /** OCR of the image as people see it. */
  visibleOcr?: OcrLine[];
  /** OCR of the contrast-amplified image. */
  revealedOcr?: OcrLine[];
  /** OCR of the image with its alpha channel dropped (what many AI pipelines see). */
  alphaDroppedOcr?: OcrLine[];
}

const words = (text: string) => text.toLowerCase().match(/[a-z0-9]{2,}/g) ?? [];

/** True when most words of `line` also appear in the visible text. */
export function isVisible(line: string, visibleWords: Set<string>): boolean {
  const w = words(line);
  if (!w.length) return true;
  return w.filter((x) => visibleWords.has(x)).length / w.length >= 0.6;
}

export function overlaps(a: Box, b: Box, pad = 4): boolean {
  return (
    a.x - pad < b.x + b.width &&
    b.x - pad < a.x + a.width &&
    a.y - pad < b.y + b.height &&
    b.y - pad < a.y + a.height
  );
}

/** Drop stray OCR tokens at the end of a line, such as "I >" read from nearby edges. */
export function trimNoise(text: string): string {
  const tokens = text.trim().split(/\s+/);
  const junk = /^(?:[^A-Za-z0-9]+|[A-Za-z]|[A-Za-z]?[^A-Za-z0-9\s.,;:!?'")]+)$/;
  let end = tokens.length;
  // A one-letter token only counts as junk when something after it already was.
  while (
    end > 1 &&
    (/^[^A-Za-z0-9]+$/.test(tokens[end - 1]) || (end < tokens.length && junk.test(tokens[end - 1])))
  )
    end--;
  return tokens.slice(0, end).join(' ');
}

/** Usable OCR lines: confident enough and containing real words. */
export const meaningful = (lines: OcrLine[] = []) =>
  lines
    .map((l) => ({ ...l, text: trimNoise(l.text) }))
    .filter(
      (l) => l.confidence >= 35 && words(l.text).length >= 2 && (l.text.match(/[a-z]/gi)?.length ?? 0) >= 6,
    );

/** Merge consecutive lines that belong to one paragraph so instructions are scored as sentences. */
function paragraphs(lines: OcrLine[]): OcrLine[] {
  const sorted = [...lines].sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
  const out: OcrLine[] = [];
  for (const line of sorted) {
    const last = out[out.length - 1];
    if (
      last &&
      line.box.y - (last.box.y + last.box.height) < line.box.height * 1.2 &&
      Math.abs(line.box.x - last.box.x) < Math.max(line.box.width, last.box.width) * 0.6
    ) {
      const x = Math.min(last.box.x, line.box.x);
      const y = Math.min(last.box.y, line.box.y);
      last.box = {
        x,
        y,
        width: Math.max(last.box.x + last.box.width, line.box.x + line.box.width) - x,
        height: Math.max(last.box.y + last.box.height, line.box.y + line.box.height) - y,
      };
      last.text = `${last.text} ${line.text}`;
      last.confidence = Math.min(last.confidence, line.confidence);
    } else out.push({ ...line, box: { ...line.box } });
  }
  return out;
}

const severityOf = (s: InstructionScore, hidden: boolean): Severity =>
  s.level === 'instruction' ? 'high' : s.level === 'possible' || hidden ? 'medium' : 'low';

export function buildFindings(input: Inputs): Finding[] {
  const findings: Finding[] = [];
  let n = 0;
  const id = () => `h${++n}`;
  const visibleLines = meaningful(input.visibleOcr);
  const visibleAt = (line: OcrLine, known: OcrLine[]) =>
    known.some(
      (visible) => overlaps(line.box, visible.box) && isVisible(line.text, new Set(words(visible.text))),
    );

  // Text revealed by amplification that people do not see.
  const claimed: Box[] = [];
  for (const line of paragraphs(meaningful(input.revealedOcr).filter((l) => !visibleAt(l, visibleLines)))) {
    const region = input.faint.find((r) => overlaps(r, line.box));
    const instruction = scoreInstruction(line.text);
    claimed.push(line.box);
    findings.push({
      id: id(),
      source: 'faint-text',
      title: 'Text revealed by amplification',
      where: region
        ? `Contrast ${region.contrast.toFixed(2)}:1 with its background`
        : 'Revealed by contrast amplification',
      text: line.text,
      box: line.box,
      contrast: region?.contrast,
      instruction,
      severity: severityOf(instruction, true),
    });
  }

  // Text that only appears when the alpha channel is dropped.
  const alphaVisible = [
    ...visibleLines,
    ...findings.filter((f) => f.box && f.text).map((f) => ({ text: f.text!, box: f.box!, confidence: 100 })),
  ];
  for (const line of paragraphs(
    meaningful(input.alphaDroppedOcr).filter((l) => !visibleAt(l, alphaVisible)),
  )) {
    const instruction = scoreInstruction(line.text);
    findings.push({
      id: id(),
      source: 'transparency',
      title: 'Text hidden under transparency',
      where: 'Appears when the alpha channel is dropped, as many AI pipelines do',
      text: line.text,
      box: line.box,
      instruction,
      severity: severityOf(instruction, true),
    });
  }
  if (input.alpha.hiddenShare > 0.002 && !findings.some((f) => f.source === 'transparency'))
    findings.push({
      id: id(),
      source: 'transparency',
      title: 'Content hidden under transparency',
      where: `${(input.alpha.hiddenShare * 100).toFixed(1)} % of pixels are invisible but carry varying colour`,
      instruction: scoreInstruction(''),
      severity: 'medium',
    });

  // Metadata text.
  for (const m of input.metadata) {
    const instruction = scoreInstruction(m.text);
    findings.push({
      id: id(),
      source: 'metadata',
      title: 'Text stored in the file',
      where: m.source,
      text: m.text,
      instruction,
      severity: severityOf(instruction, false),
    });
  }

  // Low-bit messages.
  for (const m of input.lsb) {
    const instruction = scoreInstruction(m.text);
    findings.push({
      id: id(),
      source: 'lsb',
      title: 'Message in the lowest colour bits',
      where: `Decoded from ${m.layout}`,
      text: m.text,
      instruction,
      severity: severityOf(instruction, true),
    });
  }

  // Faint regions that OCR did not turn into text (or OCR was not run).
  for (const region of input.faint) {
    if (claimed.some((b) => overlaps(b, region))) continue;
    findings.push({
      id: id(),
      source: 'faint-region',
      title: 'Faint content',
      where: `Contrast ${region.contrast.toFixed(2)}:1 — check it with the Amplify lens`,
      box: { x: region.x, y: region.y, width: region.width, height: region.height },
      contrast: region.contrast,
      instruction: scoreInstruction(''),
      severity: 'low',
    });
  }

  const order: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
  return findings.sort(
    (a, b) => order[a.severity] - order[b.severity] || b.instruction.score - a.instruction.score,
  );
}

export function verdictOf(findings: Finding[]): Verdict {
  if (findings.some((f) => f.instruction.level === 'instruction')) return 'injection';
  if (findings.some((f) => f.text && f.source !== 'metadata')) return 'hidden-text';
  if (findings.some((f) => f.source !== 'metadata' || f.instruction.level !== 'text'))
    return 'hidden-content';
  return 'clean';
}

/**
 * A cleaned copy: transparency flattened on white, flagged faint regions
 * smoothed into their background, and every lowest colour bit randomized.
 * Encoding it through a canvas also drops all metadata.
 */
export function sanitize(img: Rgba, boxes: Box[], seed = 1): Rgba {
  const { width: w, height: h } = img;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const a = img.data[i * 4 + 3] / 255;
    for (let c = 0; c < 3; c++) data[i * 4 + c] = img.data[i * 4 + c] * a + 255 * (1 - a);
    data[i * 4 + 3] = 255;
  }
  if (boxes.length) {
    const flat: Rgba = { width: w, height: h, data };
    const r = Math.max(6, Math.round(Math.max(w, h) / 60));
    const channel = (c: number) => {
      const plane = new Float32Array(w * h);
      for (let i = 0; i < w * h; i++) plane[i] = data[i * 4 + c];
      return boxMean(plane, w, h, r);
    };
    const means = [channel(0), channel(1), channel(2)];
    const L = visibleLuma(flat);
    const background = boxMean(L, w, h, r);
    for (const b of boxes)
      for (let y = Math.max(0, b.y - 2); y < Math.min(h, b.y + b.height + 2); y++)
        for (let x = Math.max(0, b.x - 2); x < Math.min(w, b.x + b.width + 2); x++) {
          const i = y * w + x;
          // Only flatten low-contrast pixels; leave anything clearly visible alone.
          if (Math.abs(L[i] - background[i]) > 0.09) continue;
          for (let c = 0; c < 3; c++) data[i * 4 + c] = means[c][i];
        }
  }
  let s = seed >>> 0 || 1;
  for (let i = 0; i < data.length; i++) {
    if (i % 4 === 3) continue;
    s = (s * 1664525 + 1013904223) >>> 0;
    data[i] = (data[i] & 0xfe) | (s >>> 31);
  }
  return { width: w, height: h, data };
}
