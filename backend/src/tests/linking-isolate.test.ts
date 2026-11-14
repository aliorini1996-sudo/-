// «ربط الدفاتر» L2 — عزل المعاينة في عملية فرعية بسقف ذاكرة (previewIsolate.ts): نفاد الذاكرة يُنهي العملية الفرعية وحدها ⇒
// TOO_LARGE والخادم سليم؛ النتيجة تعبر بـBigInt وDate وMap كما هي، والتقدّم يصل؛ الأخطاء برموزها؛ الانهيار ⇒ INTERNAL؛ والمعلّقة
// تُقتل بعد مهلتها ⇒ TIMEOUT. بلا قاعدة: عملية فرعية بمشغّلٍ مزيّف (linking-isolate-child.ts) والبروتوكول الحقيقي.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  PREVIEW_CHILD_HEAP_MB, PREVIEW_HEAP_ENV, childExecArgv, isHeapExhaustion, isolatedRunPreview, previewHeapMb, runPreviewIsolated,
} from '../services/gl/linking/previewIsolate';
import { PreviewRunError, previewErrorCodeOf } from '../services/gl/linking/preview';
import type { PreviewPhase } from '../services/gl/linking/types';
import { previewOptionsFor } from './linking-fake-db';

const CHILD = path.join(__dirname, 'linking-isolate-child.ts');
const OPTS = previewOptionsFor();
const run = (tenantId: string, extra: Parameters<typeof runPreviewIsolated>[3] = {}, onProgress?: (p: PreviewPhase, pct: number) => void) =>
  runPreviewIsolated(tenantId, OPTS, { onProgress }, { entry: CHILD, heapMb: 96, ...extra });

test('النتيجة من العملية الفرعية كما هي (BigInt وDate وMap)، والتقدّم يصل بترتيبه، وفي عملية أخرى بسقف كومتها', async () => {
  const seen: [PreviewPhase, number][] = [];
  const r = await run('ok', {}, (p, pct) => { seen.push([p, pct]); }) as unknown as Record<string, unknown>;
  assert.equal(r.tenantId, 'ok');
  assert.equal(r.linkedFrom, OPTS.linkedFrom);
  assert.equal(r.big, 123_456_789_012_345_678_901n);
  assert.deepEqual(r.when, new Date('2027-01-01T00:00:00Z'));
  assert.deepEqual(r.byRep, new Map([['r1', -5n]]));
  assert.notEqual(r.pid, process.pid);
  assert.ok((r.execArgv as string[]).includes('--max-old-space-size=96'));
  assert.ok(!(r.execArgv as string[]).some((a) => /^--(inspect|test)/.test(a)), 'لا --inspect ولا --test*');
  await new Promise((res) => setImmediate(res));
  assert.deepEqual(seen, [['COSTING', 10], ['POST', 55]]);
});

test('نفاد الذاكرة يُنهي العملية الفرعية وحدها ⇒ TOO_LARGE، والخادم (هذه العملية) سليم يكمل', async () => {
  const before = process.memoryUsage().heapUsed;
  await assert.rejects(run('oom', { heapMb: 64 }), (e: unknown) => {
    assert.ok(e instanceof PreviewRunError);
    assert.equal(previewErrorCodeOf(e), 'TOO_LARGE');
    assert.equal((e as PreviewRunError).details.heapMb, 64);
    return true;
  });
  // ما زلنا نعمل، وكومتنا لم تحمل شيئاً من كومة الابن
  assert.ok(process.memoryUsage().heapUsed - before < 64 * 1024 * 1024);
  const again = await run('ok') as unknown as Record<string, unknown>;
  assert.equal(again.tenantId, 'ok');
});

test('الأخطاء تعبر برموزها: ALREADY_ACTIVATED وSHADOW_GL_ACCESS وP2028 ⇒ TIMEOUT وغيرها INTERNAL؛ والانهيار ⇒ INTERNAL', async () => {
  for (const [tid, code] of [['already', 'ALREADY_ACTIVATED'], ['shadow', 'SHADOW_GL_ACCESS'], ['p2028', 'TIMEOUT'], ['boom', 'INTERNAL'], ['crash', 'INTERNAL']] as const) {
    await assert.rejects(run(tid), (e: unknown) => e instanceof PreviewRunError && previewErrorCodeOf(e) === code, tid);
  }
});

test('معلّقة بعد killAfterMs ⇒ تُقتل وTIMEOUT (لا معاينة متروكة تعمل بعد مهلتها)', async () => {
  const t = Date.now();
  await assert.rejects(run('hang', { killAfterMs: 1_500 }), (e: unknown) => e instanceof PreviewRunError && previewErrorCodeOf(e) === 'TIMEOUT');
  assert.ok(Date.now() - t < 10_000);
});

test('العملية الفرعية الإنتاجية (previewIsolate نفسها مدخلاً) تقلع وتخدم الطلب — بلا DATABASE_URL ترفض قبل أي اتصال ⇒ INTERNAL', async () => {
  const env = { ...process.env };
  delete env.DATABASE_URL;
  await assert.rejects(runPreviewIsolated('t1', OPTS, {}, { env, heapMb: 128 }), (e: unknown) => {
    assert.ok(e instanceof PreviewRunError);
    assert.equal(previewErrorCodeOf(e), 'INTERNAL');
    assert.match(String((e as PreviewRunError).details.child), /DATABASE_URL/);
    return true;
  });
});

test('isolatedRunPreview: بتوقيع runPreview (العميل المُمرَّر لا يُستعمل) — والوحدة لا تخدم طلباً حين تُستورد', async () => {
  assert.equal(typeof isolatedRunPreview, 'function');
  assert.equal(process.listenerCount('message'), 0, 'الاستيراد لا يسجّل مستمعاً');
});

test('childExecArgv: محمّلات الشيفرة وحدها + سقف الكومة؛ previewHeapMb من البيئة بحدود؛ وكشف نفاد الكومة', () => {
  assert.deepEqual(childExecArgv([
    '--inspect-port=127.0.0.1:9229', '--require', 'C:\\x\\tsx\\preflight.cjs', '--test-isolation=process', '--import=file:///x/tsx/loader.mjs',
    '--max-old-space-size=4096', '-r', 'dotenv/config', '--stack-trace-limit=10',
  ], 192), ['--require', 'C:\\x\\tsx\\preflight.cjs', '--import=file:///x/tsx/loader.mjs', '-r', 'dotenv/config', '--max-old-space-size=192']);
  assert.deepEqual(childExecArgv([], 128), ['--max-old-space-size=128']);
  assert.equal(previewHeapMb({}), PREVIEW_CHILD_HEAP_MB);
  assert.equal(previewHeapMb({ [PREVIEW_HEAP_ENV]: '320' }), 320);
  for (const bad of ['10', '99999', 'x', '200.5']) assert.equal(previewHeapMb({ [PREVIEW_HEAP_ENV]: bad }), PREVIEW_CHILD_HEAP_MB, bad);
  assert.equal(isHeapExhaustion('FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory', 134, null), true);
  assert.equal(isHeapExhaustion('', null, 'SIGABRT'), true);
  assert.equal(isHeapExhaustion('Error: boom', 1, null), false);
});
