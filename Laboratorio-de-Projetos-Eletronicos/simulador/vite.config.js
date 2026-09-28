import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: `${here}/src`,
  base: './',
  build: {
    outDir: `${here}/app`,
    emptyOutDir: true,
    assetsDir: 'assets',
    sourcemap: false
  }
});
