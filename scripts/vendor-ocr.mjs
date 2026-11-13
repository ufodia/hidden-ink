import { mkdir, copyFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
const target = path.join(root, 'public', 'ocr');
await mkdir(path.join(target, 'core'), { recursive: true });
await mkdir(path.join(target, 'licenses'), { recursive: true });
await copyFile(require.resolve('tesseract.js/dist/worker.min.js'), path.join(target, 'worker.min.js'));
await copyFile(require.resolve('tesseract.js/LICENSE.md'), path.join(target, 'licenses', 'tesseract-js.txt'));
// Resolve from Tesseract itself: an unrelated top-level core version can be
// incompatible with its worker (for example, missing relaxed-SIMD entry points).
const tesseractRequire = createRequire(require.resolve('tesseract.js/package.json'));
const coreRoot = path.dirname(tesseractRequire.resolve('tesseract.js-core/package.json'));
await copyFile(path.join(coreRoot, 'LICENSE'), path.join(target, 'licenses', 'tesseract-core.txt'));
for (const file of await readdir(coreRoot))
  if (/\.wasm(?:\.js)?$/.test(file))
    await copyFile(path.join(coreRoot, file), path.join(target, 'core', file));
const languageRoot = path.dirname(require.resolve('@tesseract.js-data/eng/package.json'));
await copyFile(
  path.join(languageRoot, '4.0.0_best_int', 'eng.traineddata.gz'),
  path.join(target, 'eng.traineddata.gz'),
);
await copyFile(
  path.join(languageRoot, 'package.json'),
  path.join(target, 'licenses', 'english-model-package.json'),
);
await copyFile(
  path.join(root, 'THIRD_PARTY_NOTICES.md'),
  path.join(target, 'licenses', 'THIRD_PARTY_NOTICES.md'),
);
console.log('Local OCR worker, WASM cores, and English model are ready.');
