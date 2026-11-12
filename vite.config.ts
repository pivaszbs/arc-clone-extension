import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { resolve } from 'path';

export default defineConfig(({ mode }) => {
  const anime = mode === 'anime';
  return {
    plugins: [svelte()],
    publicDir: false,
    base: './',
    build: {
      outDir: anime ? 'dist' : 'dist-arc',
      emptyOutDir: false,
      rollupOptions: {
        input: anime ? { offline: resolve(__dirname, 'offline.html') } : {
          sidepanel: resolve(__dirname, 'sidepanel.html'),
          newtab: resolve(__dirname, 'newtab.html')
        }
      }
    }
  };
});
