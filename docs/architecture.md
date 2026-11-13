# Architecture

Hidden Ink is a static Vite application in strict TypeScript. OCR uses pinned Tesseract.js, its WebAssembly core and a bundled English language-data package, served from the same origin.

```
index.html              intro, drop zone, explanation of the five checks
src/main.ts             file handling, metadata, decoding, OCR orchestration, viewer, findings, exports
src/worker.ts           pixel analysis off the main thread: transparency, low bits, faint regions, lenses, clean copy
src/protocol.ts         typed page ↔ worker messages
src/demo.ts             builds the synthetic poisoned banner as a real PNG
src/dom.ts              text-only element factory and download helper
src/core/
  png.ts                PNG chunks, CRC-32, inflate/deflate, straight-RGBA decoder, encoder, tEXt insertion
  metadata.ts           PNG, JPEG (EXIF, XMP, comments), WebP and GIF text extraction
  pixels.ts             luma, box mean, lenses, faint-region detector, contrast ratio, alpha report, LSB probe
  resample.ts           straight-RGBA area downscale
  instructions.ts       instruction rules and scoring
  findings.ts           OCR comparison, paragraph joining, findings, verdicts, sanitize
  report.ts             JSON report
scripts/vendor-ocr.mjs  copies Tesseract's worker, WASM cores, English model and licenses to public/ocr/
```

## Data flow

1. The page reads the file's bytes, extracts metadata and decodes pixels (PNG via `png.ts`, others via `createImageBitmap`).
2. The RGBA buffer is **transferred** to the worker, which runs the transparency report and LSB probe at full resolution, downscales to ≤ 1600 px, and finds faint regions.
3. The page requests lens images from the worker as needed and caches them.
4. Tesseract (its own worker, loaded from `/ocr/`) reads the *on-white*, *amplify* and, when needed, *alpha-dropped* views.
5. `buildFindings` merges everything; the verdict, viewer boxes and cards are rendered. OCR results trigger a re-render.
6. **Clean copy** asks the worker to sanitize the full-resolution image with the flagged boxes scaled up; the page encodes it as PNG.

Every request carries a `job` number so results for a previous image are ignored.

## Worker protocol

| Page → worker | Purpose |
| --- | --- |
| `{ type: 'analyze', job, rgba, width, height, rawPixels, lowBitsChecked }` | full-resolution checks, downscale, faint regions |
| `{ type: 'lens', job, lens }` | render one lens at working resolution |
| `{ type: 'sanitize', job, boxes }` | build the clean copy at full resolution |

| Worker → page | Purpose |
| --- | --- |
| `{ type: 'analysis', job, analysis }` | sizes, faint regions, noise floor, alpha report, LSB messages |
| `{ type: 'image', job, lens, rgba, width, height }` | a lens image or the clean copy |
| `{ type: 'error', job, message }` | a readable error |

## Report format

```json
{
  "tool": { "name": "Hidden Ink", "version": "1.0.0", "url": "https://github.com/ufodia/hidden-ink" },
  "generatedAt": "2026-11-13T12:00:00.000Z",
  "file": { "name": "example.png", "format": "png", "bytes": 1000, "width": 1600, "height": 1000 },
  "analysisSize": { "width": 1600, "height": 1000 },
  "verdict": "clean",
  "ocr": "done",
  "coverage": { "rawPixels": true, "lowBitsChecked": true, "warnings": [] },
  "findings": [],
  "metadata": []
}
```

This is an illustrative, abridged shape, not a complete report or a fixture verdict. Actual reports include pixel statistics and findings with sources, text where available, severity, matched instruction rules and optional boxes. `box` uses analysis pixels; `boxInOriginal` maps each axis to original-image pixels. Metadata findings have no pixel location. `coverage.rawPixels` indicates raw PNG decoding, while `coverage.lowBitsChecked` indicates exact low-bit inspection. Warnings explain reduced coverage; `limitations` states the heuristic review boundary. OCR status and inspection warnings matter when interpreting a result. See `src/core/report.ts` for the serialized contract.

## Testing

- **Unit tests** (`tests/core.test.ts`): CRC-32, PNG round-trips including colour under transparency, hand-built filtered rows, PNG/EXIF/XMP/JPEG metadata, instruction rules with positive and negative cases, faint-region detection against visible text, flat pages and gradients, the amplify lens, the alpha report, LSB encode/decode, sanitize, OCR-line comparison, paragraph joining, noise trimming and verdicts.
- **Browser tests** (`e2e/app.spec.ts`, real OCR): the demo finds all four hiding places, every lens and **Show on image**, the report and a clean copy that rescans without instructions, an ordinary image staying clean, hostile metadata rendered as text, an undecodable file and the phone layout.
