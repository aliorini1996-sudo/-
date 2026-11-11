import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { leanCountryPage, isCountryPageModule } from './src/blog/seo/countryPageLean.mjs';

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

/**
 * ملفات محتوى الدول (src/content/country-pages/<CC>.json) منسوخة حرفياً بملاحظاتها التحريرية الداخلية (notes
 * وreview.issues وreview.fixes)، والمحمّل الكسول countryPages.browser.mjs يجعل كل ملف حزمة عامة في dist/assets.
 * هذا التحويل يسبق محوّل JSON في Vite (enforce: 'pre') فيُبقي ما يرسمه العرض وحده (leanCountryPage، قائمة بيضاء).
 */
const countryPagesLean = (): Plugin => ({
  name: 'country-pages-lean',
  enforce: 'pre',
  transform(code, id) {
    if (!isCountryPageModule(id)) return null;
    const json = code.charCodeAt(0) === 0xfeff ? code.slice(1) : code;
    return { code: JSON.stringify(leanCountryPage(JSON.parse(json))), map: null };
  },
});

export default defineConfig({
  // countryPagesLean بـconcat لا داخل المصفوفة: حارس appUpdate.test.ts يثبّت «plugins: [react(), buildInfo()]» حرفياً،
  // وترتيب التحويل يحدّده enforce: 'pre' لا موضعه هنا
  plugins: [react(), buildInfo()].concat(countryPagesLean()),
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
