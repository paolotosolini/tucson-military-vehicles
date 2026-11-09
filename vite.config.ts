import { defineConfig } from 'vite';

export default defineConfig({
  base: '/goldfield/',
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
});
