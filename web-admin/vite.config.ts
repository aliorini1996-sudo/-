import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// معرّف الحزمة (Z5.0): وقت البناء UTC + أول 7 من التزام Render إن وُجد — محارف آمنة ≤ 40 (يتحقق منها الخادم)
const BUILD_ID = [new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z'), (process.env.RENDER_GIT_COMMIT || '').slice(0, 7)]
  .filter(Boolean).join('-');

export default defineConfig({
  plugins: [react()],
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
      '/media': { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
  build: {
    chunkSizeWarningLimit: 900,
  },
});
