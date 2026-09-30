import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// معرّف الحزمة (Z5.0): وقت البناء UTC + أول 7 من التزام Render إن وُجد — محارف آمنة ≤ 40 (يتحقق منها الخادم)
const BUILD_ID = [new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z'), (process.env.RENDER_GIT_COMMIT || '').slice(0, 7)]
  .filter(Boolean).join('-');

/**
 * `/build.json` بمعرّف الحزمة: يقارنه تطبيق المندوب بمعرّفه كل بضع دقائق فيحدّث نفسه حين تُنشر نسخة أحدث (rep/appUpdate.ts) —
 * وإلا ظلّ تطبيق مفتوح في خلفية الجوال أياماً على شيفرة قديمة لا ترى الميزات الجديدة (بلاغ بصمة الحضور، ٢٩ سبتمبر ٢٠٢٦).
 */
const buildInfo = (): Plugin => ({
  name: 'build-info',
  apply: 'build',
  generateBundle() {
    this.emitFile({ type: 'asset', fileName: 'build.json', source: JSON.stringify({ buildId: BUILD_ID }) });
  },
});

export default defineConfig({
  plugins: [react(), buildInfo()],
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
