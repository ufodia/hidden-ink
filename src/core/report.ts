import type { Finding, Verdict } from './findings.ts';
import type { MetadataText } from './metadata.ts';
import type { PixelAnalysis } from '../protocol.ts';

export const TOOL = { name: 'Hidden Ink', version: '1.0.0', url: 'https://github.com/ufodia/hidden-ink' };

export interface ReportInput {
  fileName: string;
  format: string;
  bytes: number;
  analysis: PixelAnalysis;
  metadata: MetadataText[];
  findings: Finding[];
  verdict: Verdict;
  ocrStatus: string;
  warnings?: string[];
}

/** A portable JSON report of every check, with boxes in analysis pixels and original pixels. */
export function reportJson(input: ReportInput, now = new Date()): string {
  const { analysis: a } = input;
  const sx = a.width / a.workWidth;
  const sy = a.height / a.workHeight;
  return (
    JSON.stringify(
      {
        tool: TOOL,
        generatedAt: now.toISOString(),
        file: {
          name: input.fileName,
          format: input.format,
          bytes: input.bytes,
          width: a.width,
          height: a.height,
        },
        analysisSize: { width: a.workWidth, height: a.workHeight },
        verdict: input.verdict,
        ocr: input.ocrStatus,
        coverage: {
          rawPixels: a.rawPixels,
          lowBitsChecked: a.lowBitsChecked,
          warnings: input.warnings ?? [],
        },
        limitations:
          'Heuristic review only. OCR, metadata and hidden-content checks can miss content or produce false positives. A result does not establish safety for an AI model.',
        findings: input.findings.map((f) => ({
          source: f.source,
          title: f.title,
          where: f.where,
          severity: f.severity,
          text: f.text ?? null,
          contrast: f.contrast ? Number(f.contrast.toFixed(3)) : null,
          instruction: {
            score: f.instruction.score,
            level: f.instruction.level,
            rules: f.instruction.hits.map((h) => h.rule),
          },
          box: f.box ?? null,
          boxInOriginal: f.box
            ? {
                x: Math.round(f.box.x * sx),
                y: Math.round(f.box.y * sy),
                width: Math.round(f.box.width * sx),
                height: Math.round(f.box.height * sy),
              }
            : null,
        })),
        pixels: {
          noise: Number(a.noise.toFixed(5)),
          transparentShare: Number(a.alpha.transparentShare.toFixed(5)),
          hiddenUnderTransparencyShare: Number(a.alpha.hiddenShare.toFixed(5)),
          faintRegions: a.faint.length,
          lowBitMessages: a.lsb.length,
        },
        metadata: input.metadata,
      },
      null,
      2,
    ) + '\n'
  );
}
