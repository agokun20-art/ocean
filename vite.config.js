import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: { host: true, allowedHosts: true },
  preview: { host: true, allowedHosts: true },
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
});
