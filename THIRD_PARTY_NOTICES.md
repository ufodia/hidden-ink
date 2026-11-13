# Third-party notices

Hidden Ink's own source code, documentation and artwork are MIT-licensed © 2026 ufodia. Dependencies keep their own licenses.

## Runtime components

| Component | Version | License | Use |
| --- | --- | --- | --- |
| [Tesseract.js](https://github.com/naptha/tesseract.js) | 7.0.0 | Apache-2.0 | Browser OCR orchestration |
| [tesseract.js-core](https://github.com/naptha/tesseract.js-core) | 7.0.0 | Apache-2.0 | WebAssembly build of the Tesseract OCR engine |
| [@tesseract.js-data/eng](https://www.npmjs.com/package/@tesseract.js-data/eng) | 1.0.0 | MIT (npm package metadata); the upstream [tessdata repository](https://github.com/naptha/tessdata/blob/gh-pages/LICENSE) uses Apache-2.0 | English recognition model |

`scripts/vendor-ocr.mjs` copies the worker, WebAssembly cores and English model into `public/ocr/` so OCR runs from the same origin without first-party OCR requests to an external origin. The license files are copied to `public/ocr/licenses/` and ship with every build.

## Development tools

Vite, TypeScript, Vitest, Playwright and Prettier build and test the project and are not shipped to users. Exact versions are pinned in `package-lock.json`.

## Demo images

The demo images are drawn and encoded in the browser by `src/demo.ts`. The shop "Northline Outfitters" and all text in them are invented.
