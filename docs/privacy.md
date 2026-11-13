# Privacy

Images checked for prompt injection are often sensitive — user uploads, internal documents, unreleased designs. Hidden Ink processes the files you open in your browser and provides no image-upload endpoint.

| Behaviour | Implementation |
| --- | --- |
| No upload | Decoding, pixel analysis and OCR run in the tab and its workers. There is no server endpoint. |
| Same-origin OCR | Tesseract's worker, WebAssembly cores and English model are bundled into `/ocr/` at build time and loaded from the site itself. |
| Restricted connections | The production `Content-Security-Policy` sets `connect-src 'self'` (the OCR worker fetches its model from the site) and `script-src 'self' 'wasm-unsafe-eval'` (Tesseract compiles WebAssembly). No other origin can be contacted by scripts. |
| No third-party asset requests | Tesseract is a bundled third-party dependency. OCR assets come from the site's origin; the app includes no analytics, external fonts or widgets. |
| No application persistence | The app does not write images or OCR results to cookies, `localStorage`, `sessionStorage` or IndexedDB; Tesseract's model cache is disabled (`cacheMethod: 'none'`). Browsers can still cache static assets. |

## What remains your responsibility

- **Exports** contain the image (clean copy, lens PNG) or its hidden text and file name (JSON report).
- **Your device** — extensions with page access, installed security software or screen recording are outside the app's control.
- **Hosting** — keep the headers from [`vercel.json`](../vercel.json) when self-hosting (see [deployment](deployment.md)). The Vite development server does not send those production headers. Loading the hosted site and its OCR assets makes ordinary hosting requests, which can produce access logs.

Closing the tab does not delete downloaded files. A report can contain the original file name, metadata and extracted text. A transformed image can retain identifying visible content. For sensitive files, inspect the source, use a trusted browser and run your own checked local copy. Local processing does not protect against a compromised device, browser extension, installed security software or modified hosted copy. A clean copy is a transformation, not anonymization or a guarantee against prompt injection.

Report a way to make the page contact another origin, or to execute content from an image file, privately as described in [SECURITY.md](../SECURITY.md).
