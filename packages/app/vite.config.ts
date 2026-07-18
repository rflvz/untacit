import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const sidecarPort = Number(process.env.UNTACIT_PORT ?? 4823);

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: `http://localhost:${sidecarPort}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    // Tauri's frontendDist points here (src-tauri/tauri.conf.json).
    emptyOutDir: true,
  },
});
