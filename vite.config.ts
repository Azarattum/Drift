import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import pkg from './package.json';
import { formatAssets } from './scripts/format-assets.ts';
export default defineConfig({
  base: './',
  plugins: [
    tailwindcss(),
    svelte(),
    formatAssets(),
    {
      name: 'drift-version',
      transformIndexHtml: () => [
        { tag: 'meta', attrs: { name: 'drift-version', content: pkg.version } },
      ],
    },
  ],
  build: {
    target: ['safari15.4', 'chrome111', 'firefox128'],
    cssTarget: 'safari15.4',
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('/node_modules/@videojs/')) return 'video-engine';
        },
      },
    },
  },
  // Compile the shipped TS source so dependency fixes need one patch, not duplicated bundles.
  resolve: {
    alias: {
      avbridge: fileURLToPath(new URL('./node_modules/avbridge/src/index.ts', import.meta.url)),
    },
  },
  optimizeDeps: { include: ['avbridge'] },
  server: {
    proxy: process.env.DRIFT_RPC_PROXY
      ? { '/transmission/rpc': { target: process.env.DRIFT_RPC_PROXY, changeOrigin: true } }
      : undefined,
  },
});
