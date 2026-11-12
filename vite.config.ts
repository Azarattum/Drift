import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
export default defineConfig({
  base: './',
  plugins: [tailwindcss(), svelte()],
  build: { target: ['safari15.4', 'chrome111', 'firefox128'], cssTarget: 'safari15.4' },
  server: {
    proxy: process.env.DRIFT_RPC_PROXY
      ? { '/transmission/rpc': { target: process.env.DRIFT_RPC_PROXY, changeOrigin: true } }
      : undefined,
  },
});
