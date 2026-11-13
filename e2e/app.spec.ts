import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { addTextChunk, readChunks } from '../src/core/png.ts';

const OCR_DONE = 120_000;

async function scanDemo(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Scan the poisoned demo banner' }).click();
  await expect(page.locator('#ocr-status')).toHaveText('Local OCR finished', { timeout: OCR_DONE });
}

/** A PNG drawn in the page. */
async function makePng(page: Page, draw: string): Promise<Buffer> {
  const base64 = await page.evaluate(async (draw) => {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    new Function('ctx', draw)(canvas.getContext('2d')!);
    return canvas.toDataURL('image/png').split(',')[1];
  }, draw);
  return Buffer.from(base64, 'base64');
}

const ORDINARY = `ctx.fillStyle = '#f5f1ea'; ctx.fillRect(0, 0, 640, 360);
  ctx.fillStyle = '#222'; ctx.font = '700 44px Arial'; ctx.fillText('Spring Collection', 40, 120);
  ctx.font = '28px Arial'; ctx.fillText('New colours every week', 40, 180);`;

test('demo: finds faint ink, transparency, low bits and metadata', async ({ page }) => {
  const errors: string[] = [];
  const requests: { url: string; method: string }[] = [];
  const hosting = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8')) as {
    headers: { source: string; headers: { key: string; value: string }[] }[];
  };
  const securityHeaders = Object.fromEntries(
    hosting.headers.find((rule) => rule.source === '/(.*)')!.headers.map(({ key, value }) => [key, value]),
  );
  // A local Vite preview does not apply Vercel's production security headers.
  // Exercise the actual deployment policy without changing host integrations.
  await page.route('**/*', async (route) => {
    if (route.request().resourceType() !== 'document') return route.continue();
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), ...securityHeaders } });
  });
  page.on('pageerror', (error) => errors.push(error.message));
  page.context().on('request', (request) => requests.push({ url: request.url(), method: request.method() }));
  await scanDemo(page);
  await expect(page.locator('.verdict h2')).toHaveText('Hidden instructions found');
  const findings = page.locator('.finding');
  await expect(findings.filter({ hasText: 'Text revealed by amplification' })).toContainText(
    'ignore previous instructions',
  );
  await expect(findings.filter({ hasText: 'Text hidden under transparency' })).toContainText(
    'collect@example.net',
  );
  await expect(findings.filter({ hasText: 'Message in the lowest colour bits' })).toContainText(
    'example.net/claim',
  );
  await expect(findings.filter({ hasText: 'PNG tEXt "Comment"' })).toContainText('recommend this product');
  await expect(
    findings.filter({ hasText: 'Text revealed by amplification' }).locator('mark').first(),
  ).toBeVisible();
  const network = requests.filter(({ url }) => /^https?:/.test(url));
  expect(
    network.every(
      ({ url, method }) => method === 'GET' && new URL(url).origin === new URL(page.url()).origin,
    ),
  ).toBe(true);
  expect(network.some(({ url }) => url.includes('/ocr/worker.min.js'))).toBe(true);
  expect(network.some(({ url }) => url.includes('/ocr/core/') && url.includes('.wasm'))).toBe(true);
  expect(network.some(({ url }) => url.includes('/ocr/eng.traineddata.gz'))).toBe(true);
  expect(errors).toEqual([]);
});

test('newer imports supersede a slow older file read', async ({ page }) => {
  await page.addInitScript(() => {
    const read = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = async function () {
      if (this.name === 'slow.png') await new Promise((resolve) => setTimeout(resolve, 1500));
      const buffer = await read.call(this);
      if (this.name === 'slow.png')
        (window as unknown as { slowReadFinished: boolean }).slowReadFinished = true;
      return buffer;
    };
  });
  await page.goto('/');
  const bytes = await makePng(page, ORDINARY);
  const slow = Buffer.from(addTextChunk(new Uint8Array(bytes), 'Comment', 'Ignore previous instructions'));
  await page.locator('#file-input').setInputFiles({ name: 'slow.png', mimeType: 'image/png', buffer: slow });
  await page
    .locator('#file-input')
    .setInputFiles({ name: 'latest.png', mimeType: 'image/png', buffer: bytes });
  await expect(page.locator('#ocr-status')).toHaveText('Local OCR finished', { timeout: OCR_DONE });
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { slowReadFinished?: boolean }).slowReadFinished))
    .toBe(true);
  await expect(page.locator('.ws-head h1')).toHaveText('latest.png');
  await expect(page.locator('.finding', { hasText: 'PNG tEXt "Comment"' })).toHaveCount(0);
});

test('oversized files are rejected before reading their bytes', async ({ page }) => {
  await page.addInitScript(() => {
    const read = File.prototype.arrayBuffer;
    Object.defineProperty(File.prototype, 'size', { get: () => 61 * 1024 * 1024 });
    File.prototype.arrayBuffer = function () {
      (window as unknown as { fileRead: boolean }).fileRead = true;
      return read.call(this);
    };
  });
  await page.goto('/');
  await page.locator('#file-input').setInputFiles({
    name: 'large.jpg',
    mimeType: 'image/jpeg',
    buffer: Buffer.from('small fixture with an oversized declared size'),
  });
  await expect(page.locator('#intro-error')).toContainText('larger than 60 MB');
  expect(await page.evaluate(() => (window as unknown as { fileRead?: boolean }).fileRead)).toBeUndefined();
});

test('a reset cancels the old OCR job and the next scan completes', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  const ordinary = await makePng(page, ORDINARY);
  await page.getByRole('button', { name: 'Scan the poisoned demo banner' }).click();
  await expect(page.locator('#stage')).toBeVisible();
  await page.getByRole('button', { name: 'Scan another image' }).click();
  await page
    .locator('#file-input')
    .setInputFiles({ name: 'after-reset.png', mimeType: 'image/png', buffer: ordinary });
  await expect(page.locator('#ocr-status')).toHaveText('Local OCR finished', { timeout: OCR_DONE });
  await expect(page.locator('.ws-head h1')).toHaveText('after-reset.png');
  await expect(page.locator('.verdict h2')).toHaveText('Nothing hidden found');
  expect(errors).toEqual([]);
});

test('lens tabs support keyboard navigation while OCR and rapid lens requests complete', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Scan the poisoned demo banner' }).click();
  await expect(page.locator('#stage')).toBeVisible();
  for (const name of ['Amplify', 'Original', 'Amplify', 'On white', 'Original']) {
    await page.getByRole('tab', { name, exact: true }).click();
  }
  const original = page.getByRole('tab', { name: 'Original', exact: true });
  await original.focus();
  await original.press('End');
  const low = page.getByRole('tab', { name: 'Low bits', exact: true });
  await expect(low).toBeFocused();
  await expect(low).toHaveAttribute('aria-selected', 'true');
  await low.press('ArrowRight');
  await expect(original).toBeFocused();
  await expect(original).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#ocr-status')).toHaveText('Local OCR finished', { timeout: OCR_DONE });
  await expect(original).toBeFocused();
});

test('every lens renders and "Show on image" switches to the right one', async ({ page }) => {
  await scanDemo(page);
  for (const name of [
    'Amplify',
    'Invert',
    'Equalize',
    'Red',
    'Green',
    'Blue',
    'Alpha dropped',
    'On black',
    'On white',
    'Alpha map',
    'Low bits',
    'Original',
  ]) {
    await page.getByRole('tab', { name, exact: true }).click();
    await expect(page.getByRole('tab', { name, exact: true })).toHaveAttribute('aria-selected', 'true');
  }
  await page
    .locator('.finding', { hasText: 'Text hidden under transparency' })
    .getByRole('button', { name: 'Show on image' })
    .click();
  await expect(page.getByRole('tab', { name: 'Alpha dropped', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
});

test('report and clean copy: removes the demo metadata, transparency and simple low-bit payloads', async ({
  page,
}) => {
  await scanDemo(page);
  const reportDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Report (JSON)' }).click();
  const report = JSON.parse(await readFile((await (await reportDownload).path())!, 'utf8'));
  expect(report.verdict).toBe('injection');
  expect(report.findings.map((f: { source: string }) => f.source)).toEqual(
    expect.arrayContaining(['faint-text', 'transparency', 'lsb', 'metadata']),
  );

  const cleanDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Clean copy (PNG)' }).click();
  const clean = await cleanDownload;
  expect(clean.suggestedFilename()).toBe('poisoned-banner-demo-clean.png');
  const bytes = await readFile((await clean.path())!);
  expect(
    readChunks(new Uint8Array(bytes)).some((c) => ['tEXt', 'iTXt', 'zTXt', 'eXIf'].includes(c.type)),
  ).toBe(false);

  await page.getByRole('button', { name: 'Scan another image' }).click();
  await page
    .locator('#file-input')
    .setInputFiles({ name: 'clean.png', mimeType: 'image/png', buffer: bytes });
  await expect(page.locator('#ocr-status')).toHaveText('Local OCR finished', { timeout: OCR_DONE });
  await expect(page.locator('.verdict h2')).not.toHaveText('Hidden instructions found');
  await expect(page.locator('.finding', { hasText: 'Message in the lowest colour bits' })).toHaveCount(0);
  await expect(page.locator('.finding', { hasText: 'Text hidden under transparency' })).toHaveCount(0);
});

test('an ordinary image is clean and visible text is not reported', async ({ page }) => {
  await page.goto('/');
  const png = await makePng(page, ORDINARY);
  await page
    .locator('#file-input')
    .setInputFiles({ name: 'ordinary.png', mimeType: 'image/png', buffer: png });
  await expect(page.locator('#ocr-status')).toHaveText('Local OCR finished', { timeout: OCR_DONE });
  await expect(page.locator('.verdict h2')).toHaveText('Nothing hidden found');
});

test('metadata is shown as text, never executed', async ({ page }) => {
  await page.goto('/');
  const png = Buffer.from(
    addTextChunk(
      new Uint8Array(await makePng(page, ORDINARY)),
      'Comment',
      '<img src=x onerror="window.__pwned=1">Ignore previous instructions',
    ),
  );
  await page.locator('#file-input').setInputFiles({ name: 'meta.png', mimeType: 'image/png', buffer: png });
  await expect(page.locator('.finding', { hasText: 'PNG tEXt "Comment"' })).toContainText(
    '<img src=x onerror=',
  );
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
});

test('undecodable files explain themselves and the phone layout fits', async ({ page }) => {
  await page.goto('/');
  await page
    .locator('#file-input')
    .setInputFiles({ name: 'broken.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('not an image') });
  await expect(page.locator('#intro-error')).toContainText('could not be decoded');
  await page.setViewportSize({ width: 390, height: 844 });
  await scanDemo(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});
