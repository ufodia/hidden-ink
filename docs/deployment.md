# Deployment

Hidden Ink is a static site with bundled OCR assets.

The public production application is [hidden-ink-beta.vercel.app](https://hidden-ink-beta.vercel.app/). Its canonical origin is `https://hidden-ink-beta.vercel.app/`; use this production address when sharing the application or checking its sitemap and indexing status. Preview deployment URLs are for verification and remain non-indexable.

## Build

```bash
npm ci
npm run check   # strict typecheck, unit tests and production build into dist/
```

`prebuild` (and `predev`) runs `scripts/vendor-ocr.mjs`, which copies into `public/ocr/`:

- `worker.min.js` from Tesseract.js,
- the WebAssembly cores resolved from Tesseract.js itself (so worker and core versions always match),
- `eng.traineddata.gz` from `@tesseract.js-data/eng`,
- license files into `public/ocr/licenses/`.

`public/ocr/` is generated and ignored by git. The build contains multiple WebAssembly variants and the model; the browser selects its needed variant. Transfer size and first-scan latency depend on the selected assets and caching. The pinned packages and vendoring script regenerate these files after a clean checkout.

`postbuild` runs `scripts/prepare-hosting.mjs` (canonical URL, absolute social image, robots and sitemap on Vercel production builds; `noindex` elsewhere).

## Security headers

| Header | Value |
| --- | --- |
| `Content-Security-Policy` | `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `no-referrer` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), payment=(), usb=()` |
| `Cross-Origin-Opener-Policy` | `same-origin` |

## Vercel

[`vercel.json`](../vercel.json) sets the framework, `npm ci`, `npm run build`, the `dist` output directory and the headers above. Node.js 24 comes from `engines`.

## Other hosts

Publish `dist/` and configure the headers. Make sure `.wasm` files are served as `application/wasm` and `.gz` files are served as-is (without `Content-Encoding` rewriting), because Tesseract decompresses the model itself.

## Verify a deployment

1. Scan the demo and confirm the status reaches **Local OCR finished**.
2. In developer tools, all requests should be same-origin, including `/ocr/…`.
3. Run the browser suite against your verified production URL (replace the reserved example domain):

```bash
PLAYWRIGHT_BASE_URL=https://your-deployment.example npx playwright test
```

In PowerShell:

```powershell
$env:PLAYWRIGHT_BASE_URL = 'https://your-deployment.example'
npm run test:browser
Remove-Item Env:PLAYWRIGHT_BASE_URL
```

Check the canonical URL, `robots.txt`, `sitemap.xml`, social image and production assets. Preview builds should remain non-indexable. For a public production update, check the affected URL and sitemap in its authorized Google Search Console property. Submission does not guarantee indexing.

## Restore on a replacement computer

GitHub `main` contains the source, lockfile, artwork, build scripts and non-secret configuration. With Node.js 24 and Git installed:

```bash
git clone https://github.com/ufodia/hidden-ink.git
cd hidden-ink
git rev-parse HEAD
npm ci
npm run check
npx playwright install chromium
npm run test:browser
```

Compare the checked-out SHA with the completed revision recorded on GitHub `main`. Dependencies, browser binaries, build output and test reports are regenerated. Keep hosting credentials outside the repository.

## Publishing changes

Run the project checks, review the task diff and integrate the checked revision into GitHub `main`. Deploy that revision through the connected Vercel project, then verify the production result. A local commit, preview deployment or unmerged branch is not the production source of record. Repository integration and deployment are separate actions under the maintainer's authorization.

The build regenerates `public/ocr/` from the pinned packages before copying it into `dist/`. Do not restore those generated directories from an unrelated machine. Verify that OCR finishes on the synthetic demo and that `/ocr/` assets load from the same origin. Scan the exported demo clean copy again as a regression check; that result is not a safety certification for arbitrary files.
