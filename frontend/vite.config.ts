import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    // Keep the rarely-changing framework code in its own chunk, so app deploys don't
    // force the browser to re-download React/router, and raise the warning threshold
    // now that the heavy FullCalendar views are split into their own on-demand chunks.
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: {
        manualChunks: (id) =>
          /node_modules\/(react|react-dom|scheduler|react-router|react-router-dom)\//.test(id) ? 'react-vendor' : undefined,
      },
    },
  },
  server: {
    port: 5173,
    // Same-origin in development, matching production, so SameSite=Strict cookies work.
    proxy: { '/api': { target: 'http://localhost:4000', changeOrigin: false } },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['tests/setup.ts'],
    css: false,
  },
});
