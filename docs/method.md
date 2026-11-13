# Method

Hidden Ink combines deterministic image and metadata checks with local Tesseract OCR and a rule-based instruction score. The OCR model is pretrained; the app does not train on files you open. Findings expose their source and matched rules, but OCR and detectors can miss or misread content.

## 1. Decoding

- **PNG** files are decoded by `src/core/png.ts`: chunks are parsed, `IDAT` data is inflated with the browser's `DecompressionStream`, and the five row filters (None, Sub, Up, Average, Paeth) are undone. Supported non-interlaced 8-bit greyscale, RGB, palette (with `tRNS`) and alpha layouts use the raw decoder. Supported 16-bit layouts preserve alpha but use the top eight colour bits for lenses and OCR; exact low-bit inspection is skipped. Valid packed 1/2/4-bit or interlaced layouts fall back to browser decoding with a coverage warning. Malformed or oversized PNGs are rejected rather than silently accepted by the fallback. The result is **straight** RGBA: the colour of a fully transparent pixel is preserved.
- **Other formats** are decoded with `createImageBitmap`. The browser may apply colour management, orientation or other decoding transformations; raw low-bit and transparent-RGB fidelity are not guaranteed. These probes are most useful with supported lossless PNG layouts.

### Parser bounds and coverage

- File input is limited to 60 MiB and decoded images to 40 megapixels. These ceilings do not promise that every device can process the maximum.
- PNG decompression is bounded to the exact expected scanline byte count from the validated header. PNG chunks, filters and checksums are validated.
- PNG metadata fields and decompressed text are limited to 1 MiB per field, with 4 MiB of combined PNG text bytes. Returned metadata is bounded to 256 fields and 4 Mi characters.
- Selected EXIF traversal is bounded to 4096 entries; selected fields are limited to 1 MiB. WebP EXIF/XMP and GIF comments also have per-field bounds.
- Unsupported layouts, reduced precision, truncated metadata coverage and failed OCR are surfaced through status or coverage warnings. Raw low-bit checks run only when exact source precision is available.

## 2. Transparency

Over the full-resolution image:

- `transparentShare` — pixels with alpha below 8.
- `hiddenShare` — transparent pixels whose luma differs from the mean transparent colour by more than 0.08, counted only when the transparent colours actually vary (variance above 0.0004). A uniform transparent background is not reported.
- `backgroundDependence` — the mean of `1 − alpha`, an indicator that the image will look different on dark and light backgrounds.

The **Alpha dropped** lens sets every alpha value to 255 and keeps the raw colour, simulating alpha discard rather than compositing onto a background. This is a diagnostic view, not a prediction of a specific model pipeline.

## 3. Low-bit messages

The lowest bit of each channel is read in row order in four layouts — RGB, RGBA, red only and blue only — and packed into bytes. A run of at least 12 printable ASCII characters at the start (or after a 4-byte length prefix) that contains a three-letter word and is at least 70 % letters and spaces is reported. This probes those specific simple layouts; arbitrary steganography tools, encrypted payloads and spread-spectrum encodings are out of scope.

## 4. Faint content

At working resolution (longer side ≤ 1600 px):

1. Luma is computed as people see it (composited on white).
2. A local background is estimated with a box mean of radius `max(6, longer side / 80)`, and the absolute high-pass `|L − background|` is taken.
3. The **noise floor** is the median high-pass value; a pixel is *faint* when its high-pass exceeds `max(0.0035, 4 × noise)` and *strong* above 0.09 (clearly visible).
4. The image is split into 12 × 12 tiles. A tile is a candidate when more than 5 % of its pixels are faint, under 1 % are strong, and no strong tile is within reach of the background radius (the background estimate bends around dark text, which would otherwise make nearby paper look marked).
5. Candidate tiles are grouped 8-connected; groups of fewer than three tiles are dropped as texture.
6. For each region, the WCAG contrast ratio between the background and the faint pixels is reported.

The **Amplify** lens divides each pixel's high-pass by the local spread of high-pass values and maps it around mid-grey, so a 1 % difference becomes a strong contrast. **Invert** is its negative.

## 5. OCR comparison

Tesseract (LSTM, English) reads up to three views at working resolution:

| View | Purpose |
| --- | --- |
| On white | the text people can already see |
| Amplify | visible text **plus** faint ink |
| Alpha dropped | text under transparency (only when transparency is present) |

Lines are kept when OCR confidence is at least 35, they contain two or more words and at least six letters. Trailing junk tokens (such as `I >` read from nearby edges) are trimmed. A revealed line is **hidden** when fewer than 60 % of its words appear anywhere in the visible text. Consecutive hidden lines that are vertically adjacent and left-aligned are joined into one paragraph before scoring, so wrapped sentences are scored as sentences.

## 6. Instruction score

Each text is matched against the rules in `src/core/instructions.ts`. A rule contributes its weight once; the total is capped at 100.

| Level | Score |
| --- | --- |
| Instruction | ≥ 50 |
| Possible instruction | 25–49 |
| Text | < 25 |

Because OCR frequently reads “AI” as “Al”, both spellings count when a text addresses an AI.

## 7. Findings, severity and verdict

| Source | Severity |
| --- | --- |
| Any hidden text scoring as an instruction | high |
| Hidden text scoring as a possible instruction, or any other text hidden from people | medium |
| Metadata text that does not read as an instruction; faint regions without readable text | low |

| Verdict | Rule |
| --- | --- |
| Hidden instructions found | any finding at the *instruction* level |
| Hidden text found | any hidden text outside metadata |
| Hidden content found | faint or transparent content, or metadata that reads like an instruction |
| Nothing hidden found | otherwise (ordinary metadata such as a camera model does not count) |

## 8. Clean copy

`sanitize` flattens alpha onto white, replaces low-contrast pixels inside flagged boxes with the local mean colour (pixels with high-pass above 0.09 are left untouched), and replaces the lowest RGB bits using a deterministic seeded generator. The canvas export re-encodes decoded pixels rather than copying original metadata. These operations can disrupt the supported hiding techniques, but can also alter legitimate artwork. They do not guarantee the removal of instructions or all hidden data.

## Limitations

- **OCR quality.** Very small, rotated, curved, handwritten or stylized text may be missed or misread. For tiny hidden print, analyse the highest-resolution original.
- **Language.** Both the bundled OCR model and instruction rules focus on English. Non-English content may be missed, misread or scored poorly; detected low-scoring text can still appear as a finding.
- **Evasion.** Paraphrased instructions can avoid the rules; images designed to fool a specific model through adversarial noise are not detected.
- **Visible text.** Text that people can see is not reported, even if it contains instructions.
- **Steganography.** Only plain-text low-bit messages are decoded.
- **Formats.** Animated images are analysed on their first frame. HEIC is not supported by most browsers.
- **Metadata.** Only supported fields and encodings are inspected. Selected EXIF tags, XMP text/attributes and comments are not an exhaustive metadata inventory. Malformed, unsupported or bounded-out data can reduce coverage.
- **Verdicts.** “Nothing hidden found” means these checks did not report hidden content. It is not proof of absence, an attack probability or a prediction of model behavior. Failed or incomplete OCR reduces coverage.
- **Clean copy.** Visible instructions, undetected faint text, complex encodings and identifying artwork can remain. Inspect the transformed output and scan it again.
