/**
 * مُحمِّل صورة «نموذج الشركة المطبوع مسبقاً» (lib/print/formImage.ts): النوع من البايتات، وdata URL، وجلبٌ واحد مشترك، والذاكرة
 * الدائمة بمفتاح «formimg:<v>» (المندوب)، والفشل لا يُحفظ ولا يرمي، والمراجع المعطوبة لا تُجلب، والمساحة من المسار.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FORM_IMAGE_MAX_BYTES, bytesToBase64, createFormImageLoader, defaultFormImageLoader, formBackgroundRef, formBackgroundRefsOf,
  formImageCacheKey, formImageDataUrl, formImagePath, formImageRefOk, formImageSpaceOf, isFormImageDataUrl, prefetchFormImages,
  sniffFormImageMime, type FormImageStore,
} from './formImage';
import type { FormImageRef } from './printSettingsCore';

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20]);
const HTML = new TextEncoder().encode('<!doctype html><title>404</title>');

const REF: FormImageRef = { id: '3f2b8c1e-1234-4abc-9def-0123456789ab', v: 'a1b2c3d4e5f60718', wPx: 1240, hPx: 1754 };
const REF2: FormImageRef = { id: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d', v: '0011223344556677', wPx: 1240, hPx: 1754 };

/** ذاكرةٌ دائمة في الذاكرة تحصي القراءة والكتابة */
function memStore(seed: Record<string, string> = {}): FormImageStore & { data: Map<string, string>; gets: number; sets: number } {
  const data = new Map(Object.entries(seed));
  const s = {
    data, gets: 0, sets: 0,
    async get(k: string) { s.gets++; return data.get(k) ?? null; },
    async set(k: string, v: string) { s.sets++; data.set(k, v); },
  };
  return s;
}

test('النوع من البايتات الأولى وحدها: JPEG وPNG وWebP — وغيرها (صفحة خطأ HTML) لا', () => {
  assert.equal(sniffFormImageMime(JPEG), 'image/jpeg');
  assert.equal(sniffFormImageMime(PNG), 'image/png');
  assert.equal(sniffFormImageMime(WEBP), 'image/webp');
  assert.equal(sniffFormImageMime(HTML), null);
  assert.equal(sniffFormImageMime(new Uint8Array([0xff, 0xd8])), null);
  assert.equal(sniffFormImageMime(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x41, 0x56, 0x49, 0x20])), null, 'RIFF بلا WEBP');
});

test('base64 بلا btoa مطابقٌ لـBuffer بكل طولٍ (والحشو)', () => {
  for (let n = 0; n <= 7; n++) {
    const b = new Uint8Array(n).map((_, i) => (i * 97 + 13) & 255);
    assert.equal(bytesToBase64(b), Buffer.from(b).toString('base64'), `الطول ${n}`);
  }
  const big = new Uint8Array(4099).map((_, i) => (i * 31) & 255);
  assert.equal(bytesToBase64(big), Buffer.from(big).toString('base64'));
});

test('data URL بنوعها المفحوص من Blob أو بايتات — ويرمي لما ليس صورةً أو فارغاً أو أكبر من السقف', async () => {
  assert.equal(await formImageDataUrl(JPEG), `data:image/jpeg;base64,${Buffer.from(JPEG).toString('base64')}`);
  // نوع Blob من الخادم لا يُصدَّق: البايتات هي الحكم
  assert.match(await formImageDataUrl(new Blob([PNG], { type: 'text/html' })), /^data:image\/png;base64,/);
  assert.match(await formImageDataUrl(WEBP.buffer.slice(0)), /^data:image\/webp;base64,/);
  await assert.rejects(formImageDataUrl(HTML));
  await assert.rejects(formImageDataUrl(new Uint8Array(0)));
  const huge = new Uint8Array(FORM_IMAGE_MAX_BYTES + 1);
  huge.set(JPEG);
  await assert.rejects(formImageDataUrl(huge));
  assert.ok(isFormImageDataUrl(await formImageDataUrl(JPEG)));
  assert.ok(!isFormImageDataUrl('data:text/html;base64,PGh0bWw+'));
  assert.ok(!isFormImageDataUrl('javascript:alert(1)'));
  assert.ok(!isFormImageDataUrl(42));
});

test('المرجع الصالح وحده (uuid وبصمة سداسية) — ومفتاح الذاكرة بالبصمة ومسار الواجهة بالمعرّف', () => {
  assert.ok(formImageRefOk(REF));
  assert.ok(!formImageRefOk(null));
  assert.ok(!formImageRefOk({ ...REF, id: '../../etc' }));
  assert.ok(!formImageRefOk({ ...REF, v: 'XYZ' }));
  assert.equal(formImageCacheKey(REF.v), 'formimg:a1b2c3d4e5f60718');
  assert.equal(formImagePath(REF.id), '/company/print-forms/3f2b8c1e-1234-4abc-9def-0123456789ab');
});

test('الجلب: طلبٌ واحد مشترك للطالبين، والنتيجة في الذاكرة الدائمة بمفتاح formimg:<v> — والحالة لا شيء ثم قيد الجلب ثم جاهزة', async () => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const store = memStore();
  const loader = createFormImageLoader({ fetch: async (id) => { calls++; assert.equal(id, REF.id); await gate; return JPEG; }, store });
  assert.equal(loader.peek(REF).status, 'none');
  const a = loader.load(REF);
  const b = loader.load({ ...REF });
  assert.equal(loader.peek(REF).status, 'loading');
  release();
  const [x, y] = await Promise.all([a, b]);
  assert.equal(calls, 1, 'جلبٌ واحد');
  assert.equal(x, y);
  assert.match(x ?? '', /^data:image\/jpeg;base64,/);
  assert.deepEqual(loader.peek(REF), { status: 'ready', src: x });
  assert.equal(store.data.get('formimg:a1b2c3d4e5f60718'), x);
  // الجاهزة لا تُجلب ثانيةً
  assert.equal(await loader.load(REF), x);
  assert.equal(calls, 1);
});

test('الذاكرة الدائمة أولاً (المندوب أوف‑لاين): الموجود فيها لا يُجلب — والمعطوب فيها يُتجاهل ويُجلب', async () => {
  const url = await formImageDataUrl(PNG);
  let calls = 0;
  const hit = createFormImageLoader({ fetch: async () => { calls++; throw new Error('offline'); }, store: memStore({ 'formimg:a1b2c3d4e5f60718': url }) });
  assert.equal(await hit.load(REF), url);
  assert.equal(calls, 0);
  const bad = createFormImageLoader({ fetch: async () => { calls++; return JPEG; }, store: memStore({ 'formimg:a1b2c3d4e5f60718': '<html>' }) });
  assert.match((await bad.load(REF)) ?? '', /^data:image\/jpeg/);
  assert.equal(calls, 1);
});

test('الفشل لا يرمي ولا يُحفظ: null وحالة failed، والمحاولة التالية تجلب من جديد — وعطب الذاكرة الدائمة لا يمنع الجلب', async () => {
  let mode: 'fail' | 'html' | 'ok' = 'fail';
  let calls = 0;
  const store: FormImageStore = {
    async get() { throw new Error('idb'); },
    async set() { throw new Error('quota'); },
  };
  const loader = createFormImageLoader({
    fetch: async () => { calls++; if (mode === 'fail') throw new Error('network'); return mode === 'html' ? HTML : JPEG; },
    store,
  });
  assert.equal(await loader.load(REF), null);
  assert.equal(loader.peek(REF).status, 'failed');
  mode = 'html';
  assert.equal(await loader.load(REF), null, 'صفحة خطأٍ ليست صورة');
  mode = 'ok';
  const ok = await loader.load(REF);
  assert.match(ok ?? '', /^data:image\/jpeg/);
  assert.equal(loader.peek(REF).status, 'ready');
  assert.equal(calls, 3);
});

test('المرجع المعطوب لا يُجلب أبداً (failed)، والغائب لا شيء', async () => {
  let calls = 0;
  const loader = createFormImageLoader({ fetch: async () => { calls++; return JPEG; } });
  assert.equal(await loader.load({ ...REF, id: 'nope' }), null);
  assert.equal(await loader.load(null), null);
  assert.equal(calls, 0);
  assert.equal(loader.peek({ ...REF, id: 'nope' }).status, 'failed');
  assert.equal(loader.peek(null).status, 'none');
});

test('مرجع الخلفية: الخلفية مفعّلة وصورةٌ موجودة — ومراجع الإعداد الخام بلا تكرار لقوالب النموذج وحدها', () => {
  assert.equal(formBackgroundRef(null), null);
  assert.equal(formBackgroundRef({ background: false, image: REF }), null);
  assert.equal(formBackgroundRef({ background: true, image: null }), null);
  assert.equal(formBackgroundRef({ background: true, image: REF }), REF);
  const raw = {
    version: 1,
    profiles: [
      { id: 'a', options: { layout: { design: 'preprinted', form: { background: true, image: REF } } } },
      { id: 'b', options: { layout: { design: 'preprinted', form: { background: true, image: { ...REF, id: REF2.id } } } } },
      { id: 'c', options: { layout: { design: 'preprinted', form: { background: false, image: REF2 } } } },
      { id: 'd', options: { layout: { design: 'grid_bilingual', form: { background: true, image: REF2 } } } },
      { id: 'e', options: { layout: { design: 'preprinted', form: { background: true, image: REF2 } } } },
      null, 'x',
    ],
  };
  assert.deepEqual(formBackgroundRefsOf(raw).map((r) => r.v), [REF.v, REF2.v]);
  assert.deepEqual(formBackgroundRefsOf(null), []);
  assert.deepEqual(formBackgroundRefsOf({ profiles: 'x' }), []);
});

test('الجلب المسبق يحمّل المراجع الصالحة ولا يرمي', async () => {
  const seen: string[] = [];
  const loader = createFormImageLoader({ fetch: async (id) => { seen.push(id); if (id === REF2.id) throw new Error('x'); return JPEG; } });
  await prefetchFormImages(loader, [REF, REF2, null, { ...REF, v: 'bad' }]);
  assert.deepEqual(seen.sort(), [REF.id, REF2.id].sort());
  assert.equal(loader.peek(REF).status, 'ready');
  assert.equal(loader.peek(REF2).status, 'failed');
});

test('المساحة من المسار: /rep وما تحته للمندوب، وغيره (اللوحة و/m و/reports) عميل api — ومُحمِّلٌ واحد لكل مساحة', () => {
  assert.equal(formImageSpaceOf('/rep'), 'rep');
  assert.equal(formImageSpaceOf('/rep/invoice'), 'rep');
  assert.equal(formImageSpaceOf('/reports'), 'admin');
  assert.equal(formImageSpaceOf('/m'), 'admin');
  assert.equal(formImageSpaceOf('/'), 'admin');
  const r = defaultFormImageLoader('/rep');
  assert.equal(defaultFormImageLoader('/rep/x'), r);
  assert.notEqual(defaultFormImageLoader('/settings'), r);
  assert.equal(defaultFormImageLoader('/m'), defaultFormImageLoader('/'));
  // بلا جلبٍ فعليّ: لا شبكة في الاختبار
  assert.equal(r.peek(REF).status, 'none');
});

test('حرّاس المصدر: لا عميل axios جديد ولا استيراد ثابت للعميلين أو للذاكرة (يدخل الملف حزمة القوالب)', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./formImage.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /axios\.create\(/);
  assert.doesNotMatch(src, /^import .*(repApi|api\/client|offlineDb)/m);
  assert.match(src, /await import\('\.\.\/\.\.\/rep\/repApi'\)/);
  assert.match(src, /await import\('\.\.\/\.\.\/api\/client'\)/);
  assert.match(src, /background: true/, 'جلب المندوب خلفيّ: فشله لا يُخرجه');
});
