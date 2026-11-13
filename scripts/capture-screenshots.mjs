/**
 * Regenerates the README screenshots and the social preview image from the
 * real production build. Run `npm run build` first, then `npm run screenshots`.
 */
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import config from './screenshots.config.mjs';

const root = path.resolve(import.meta.dirname, '..');
const port = 4319;
const base = `http://127.0.0.1:${port}/`;

const server = spawn(
  process.execPath,
  [
    path.join(root, 'node_modules/vite/bin/vite.js'),
    'preview',
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--strictPort',
  ],
  {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);

let browser;
let startupError;
let serverOutput = '';
let listening = false;
server.stdout.setEncoding('utf8');
server.stdout.on('data', (chunk) => {
  serverOutput = (serverOutput + chunk).slice(-8192);
  listening ||= serverOutput.includes(base);
});
server.stderr.resume();
server.on('error', (error) => {
  startupError = error;
});

try {
  let ready = false;
  for (let i = 0; i < 60; i++) {
    if (startupError) throw startupError;
    if (server.exitCode !== null || server.signalCode !== null)
      throw new Error('The screenshot preview server exited before becoming ready.');
    try {
      if (listening && (await fetch(base)).ok) {
        ready = true;
        break;
      }
    } catch {
      /* not ready yet */
    }
    await delay(250);
  }
  if (!ready) throw new Error('The screenshot preview server did not become ready.');
  browser = await chromium.launch({ channel: 'chromium' });
  for (const shot of config.shots) {
    const context = await browser.newContext({
      viewport: shot.viewport,
      deviceScaleFactor: shot.scale ?? 1,
      colorScheme: 'dark',
      reducedMotion: 'reduce',
    });
    const page = await context.newPage();
    await page.goto(base);
    await shot.prepare(page);
    await page.waitForTimeout(400);
    if (shot.element) await page.locator(shot.element).screenshot({ path: path.join(root, shot.file) });
    else
      await page.screenshot({
        path: path.join(root, shot.file),
        fullPage: shot.fullPage ?? false,
        clip: shot.clip,
      });
    console.log(`Saved ${shot.file}`);
    await context.close();
  }
  for (const card of config.cards ?? []) {
    const page = await browser.newPage({ viewport: { width: card.width, height: card.height } });
    const svg = await readFile(path.join(root, card.source), 'utf8');
    await page.setContent(`<!doctype html><html><body style="margin:0;background:#000">${svg}</body></html>`);
    await page.screenshot({ path: path.join(root, card.file) });
    console.log(`Saved ${card.file}`);
    await page.close();
  }
} finally {
  try {
    await browser?.close();
  } finally {
    server.kill();
  }
}
