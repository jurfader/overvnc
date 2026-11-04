import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// W trybie dev panel działa na :5173, a API/WebSockety przekierowujemy do serwera na :8080.
export default defineConfig({
  plugins: [react()],
  // bez wklejania zasobów jako data: — serwer ma ścisłą politykę CSP (font-src 'self')
  build: { assetsInlineLimit: 0 },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:8080',
      '/ws': { target: 'ws://127.0.0.1:8080', ws: true },
    },
  },
});
