/** Screens captured for the README. Every image shows the synthetic poisoned banner. */
const demo = async (page) => {
  await page.getByRole('button', { name: 'Scan the poisoned demo banner' }).click();
  await page.locator('#ocr-status', { hasText: 'Local OCR finished' }).waitFor({ timeout: 120_000 });
};
const lens = async (page, name) => {
  await page.getByRole('tab', { name, exact: true }).click();
  await page.waitForTimeout(400);
};

export default {
  shots: [
    {
      file: 'docs/assets/screenshot-home.png',
      viewport: { width: 1440, height: 980 },
      prepare: async () => {},
    },
    {
      file: 'docs/assets/screenshot-original.png',
      viewport: { width: 1440, height: 1000 },
      prepare: async (page) => {
        await demo(page);
        await lens(page, 'Original');
      },
    },
    {
      file: 'docs/assets/screenshot-amplify.png',
      viewport: { width: 1440, height: 1000 },
      prepare: async (page) => {
        await demo(page);
        await lens(page, 'Amplify');
      },
    },
    {
      file: 'docs/assets/screenshot-alpha.png',
      viewport: { width: 1440, height: 1000 },
      prepare: async (page) => {
        await demo(page);
        await lens(page, 'Alpha dropped');
      },
    },
    {
      file: 'docs/assets/screenshot-findings.png',
      viewport: { width: 1440, height: 2400 },
      prepare: demo,
      element: '.panel',
    },
    {
      file: 'docs/assets/screenshot-mobile.png',
      viewport: { width: 390, height: 844 },
      scale: 2,
      prepare: async (page) => {
        await demo(page);
        await lens(page, 'Amplify');
      },
    },
  ],
  cards: [{ source: 'docs/assets/social-card.svg', file: 'public/og-image.png', width: 1200, height: 630 }],
};
