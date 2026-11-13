# User guide

## Open an image

- **Drop** an image anywhere on the page,
- **paste** one from the clipboard (Ctrl/Cmd + V), or
- **Choose image**.

Common browser-decodable formats include PNG, JPEG, WebP, GIF and AVIF, subject to a 60 MiB file limit and 40 megapixels. These are rejection limits, not capacity promises for every device. **Scan the poisoned demo banner** loads a synthetic example of the four supported hiding places.

Pixel, transparency, low-bit and metadata findings appear before OCR completes. The status line shows local OCR progress; the first scan also loads same-origin model and WebAssembly assets. Wait for OCR to finish and read any coverage warnings before interpreting a result.

## Read the verdict

| Verdict | What to do |
| --- | --- |
| **Hidden instructions found** | inspect the extracted text and matched rules; decide whether to reject or transform the file before use |
| **Hidden text found** | read the text; decide whether it belongs there |
| **Hidden content found** | open the suggested lens and look at the boxed area |
| **Nothing hidden found** | no hidden text was found by these checks; visible text can still instruct a model |

The facts block lists the format and size, metadata fields, transparency, faint regions and whether a low-bit message was decoded.

## Review findings

Each card shows:

- a number (when the finding has a location) matching the box on the image,
- what it is and where it was found — for example *PNG tEXt "Comment"* or *Contrast 1.03:1 with its background*,
- the text, with phrases that look like instructions highlighted,
- the instruction score and the rules that matched,
- **Show on image** — switches to the best lens and highlights the box,
- **Copy text**.

## Use the lenses

Switch lenses with the buttons above the image. Hover a lens for a description. The most useful ones:

- **Amplify** for faint ink,
- **Alpha dropped** for text under transparency,
- **Red / Green / Blue** for text hidden in one colour channel,
- **On black** for content that only appears on dark backgrounds,
- **Low bits** to see whether the lowest bits have structure.

## Export

| Button | Result |
| --- | --- |
| **Clean copy (PNG)** | `<name>-clean.png`: transparency flattened, flagged low-contrast pixels smoothed, lowest RGB bits replaced, original metadata not copied |
| **Report (JSON)** | `hidden-ink-report.json`: verdict, findings with boxes in analysis and original pixels, pixel statistics and extracted metadata text |
| **This view (PNG)** | the current lens with boxes, for a ticket or a report |

## Troubleshooting

| Symptom | Try |
| --- | --- |
| *could not be decoded* | convert to PNG or JPEG |
| OCR could not start | reload; check that the site's `/ocr/` files are served (self-hosted copies must keep them) |
| Faint content found but no text | open **Amplify**; the content may be a pattern, a watermark or text too small for OCR |
| Hidden text is garbled | OCR misread it; the lenses show the actual pixels |
| A large file is slow | analysis runs at up to 1600 px; OCR time grows with text density |

## Interpreting incomplete coverage

Raw transparency and low-bit fidelity can be reduced when an unsupported PNG layout uses browser decoding. Metadata may be partially inspected when fields are malformed, unsupported or exceed parser bounds. OCR can fail independently of pixel checks. Read warnings and status alongside findings; a clean label does not replace a completed inspection.

The clean-copy export can change legitimate artwork and retain visible instructions or undetected content. Review its appearance, scan it again and keep the original file when you need a faithful record. Neither export guarantees that an AI application will handle the file safely.
