import { defineConfig } from 'vite';

export default defineConfig({
  server: { host: '127.0.0.1' },
  build: {
    target: 'es2022',
    // Keeps the production bundle free of fetch-based preload helpers so the
    // Content-Security-Policy in vercel.json can stay strict.
    modulePreload: { polyfill: false },
  },
});
