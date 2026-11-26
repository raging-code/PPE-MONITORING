import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// The host only accepts Origin and Host 127.0.0.1:8420 or localhost:8420 (design 4, ADR 0008),
// so the dev proxy rewrites both. In production the host serves the built files itself.
const HOST = '127.0.0.1:8420';
const asHost = { Origin: 'http://' + HOST };

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    proxy: {
      '/api': { target: 'http://' + HOST, changeOrigin: true, headers: asHost },
      '/ws': { target: 'ws://' + HOST, ws: true, changeOrigin: true, headers: asHost },
    },
  },
  test: { environment: 'node', include: ['tests/**/*.test.{ts,tsx}'] },
});
