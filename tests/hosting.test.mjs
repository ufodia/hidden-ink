import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareHosting, productionOrigin } from '../scripts/prepare-hosting.mjs';

const temporary = [];
async function fixture(head = '') {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ufodia-hosting-'));
  temporary.push(dir);
  await writeFile(
    path.join(dir, 'index.html'),
    `<!doctype html><html lang="en"><head><title>A &amp; B</title>${head}</head><body>Original app</body></html>`,
  );
  return dir;
}
async function content(dir, name) {
  return readFile(path.join(dir, name), 'utf8');
}
const production = { VERCEL_ENV: 'production', VERCEL_PROJECT_PRODUCTION_URL: 'tools.example' };
afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map(async (dir) => {
      const resolved = path.resolve(dir),
        temporaryRoot = path.resolve(os.tmpdir()) + path.sep;
      if (!resolved.startsWith(temporaryRoot) || !path.basename(resolved).startsWith('ufodia-hosting-'))
        throw new Error('Refusing cleanup outside the test-owned temporary directory.');
      await rm(resolved, { recursive: true, force: true });
    }),
  );
});

describe('production-aware static hosting', () => {
  it('emits canonical, OG URL, and a one-URL sitemap without a fabricated lastmod', async () => {
    const dir = await fixture();
    const result = await prepareHosting(dir, production);
    expect(result.indexable).toBe(true);
    const html = await content(dir, 'index.html');
    expect(html).toContain('rel="canonical" href="https://tools.example/"');
    expect(html).toContain('property="og:url" content="https://tools.example/"');
    expect(html).toContain('<title>A &amp; B</title>');
    const sitemap = await content(dir, 'sitemap.xml');
    expect(sitemap.match(/<loc>/g)).toHaveLength(1);
    expect(sitemap).toContain('<loc>https://tools.example/</loc>');
    expect(sitemap).not.toContain('lastmod');
    expect(await content(dir, 'robots.txt')).toContain('Sitemap: https://tools.example/sitemap.xml');
  });
  it('does not publish production metadata or a sitemap from a preview', async () => {
    const dir = await fixture();
    await prepareHosting(dir, { ...production, VERCEL_ENV: 'preview' });
    const html = await content(dir, 'index.html');
    expect(html).toContain('noindex,nofollow');
    expect(html).not.toContain('canonical');
    expect(html).not.toContain('tools.example');
    expect(await content(dir, 'robots.txt')).toContain('Disallow: /');
    await expect(content(dir, 'sitemap.xml')).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('keeps ordinary local builds non-indexable with no guessed domain', async () => {
    const dir = await fixture();
    await prepareHosting(dir, {});
    expect(await content(dir, 'index.html')).toContain('noindex,nofollow');
    await expect(content(dir, 'sitemap.xml')).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each([
    '',
    'https://tools.example',
    'tools.example/path',
    'tools.example?x=1',
    'user@tools.example',
    'localhost',
    '127.0.0.1',
    'tools.example:443',
    'tools.example"><script>alert(1)</script>',
    'tools.example\n',
  ])('rejects invalid or injectable production host %j before modifying HTML', async (host) => {
    const dir = await fixture();
    const before = await content(dir, 'index.html');
    await expect(
      prepareHosting(dir, { ...production, VERCEL_PROJECT_PRODUCTION_URL: host }),
    ).rejects.toThrow();
    expect(await content(dir, 'index.html')).toBe(before);
  });
  it('is idempotent and removes its own production metadata when rebuilding a preview', async () => {
    const dir = await fixture();
    await prepareHosting(dir, production);
    await prepareHosting(dir, production);
    expect((await content(dir, 'index.html')).match(/rel="canonical"/g)).toHaveLength(1);
    await prepareHosting(dir, { VERCEL_ENV: 'preview' });
    expect(await content(dir, 'index.html')).not.toContain('canonical');
    await expect(content(dir, 'sitemap.xml')).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('preserves explicit source robots meta and does not generate an indexable sitemap', async () => {
    const dir = await fixture('<meta name="robots" content="noindex">');
    await prepareHosting(dir, production);
    expect(await content(dir, 'index.html')).toContain('<meta name="robots" content="noindex">');
    await expect(content(dir, 'sitemap.xml')).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('preserves a custom robots file rather than silently replacing its intent', async () => {
    const dir = await fixture();
    const policy = 'User-agent: *\nDisallow: /private/\n';
    await writeFile(path.join(dir, 'robots.txt'), policy);
    const result = await prepareHosting(dir, production);
    expect(result.customRobots).toBe(true);
    expect(await content(dir, 'robots.txt')).toBe(policy);
    await expect(content(dir, 'sitemap.xml')).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('normalizes an international hostname without allowing HTML attribute injection', () => {
    expect(productionOrigin('bücher.example')).toBe('https://xn--bcher-kva.example');
    expect(() => productionOrigin('a.example" onload="alert(1)')).toThrow();
  });
});

describe('social preview image', () => {
  it('makes a root-relative og:image absolute in production only', async () => {
    const dir = await fixture('<meta property="og:image" content="/og-image.png">');
    await prepareHosting(dir, production);
    expect(await content(dir, 'index.html')).toContain('content="https://tools.example/og-image.png"');
    const preview = await fixture('<meta property="og:image" content="/og-image.png">');
    await prepareHosting(preview, { VERCEL_ENV: 'preview' });
    expect(await content(preview, 'index.html')).toContain('content="/og-image.png"');
  });
});
