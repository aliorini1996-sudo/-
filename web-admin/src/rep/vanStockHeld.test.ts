// مراجعة المخزون نوفمبر ٢٠٢٦ — تطبيق المندوب:
//   • البند ٥ (D5): فاتورةٌ دون اتصال فوق مخزون السيارة لمندوبٍ بلا «البيع بدون مخزون» تُحجز «بانتظار الإدارة» (409 VAN_STOCK_REPLAY_HELD)
//     كحجز اللوط — لا رفض ولا إعدام، ولا سؤال قبل المهلة (rep/vanStockHeld.ts وofflineSync.ts ولوحة الصندوق).
//   • البند ١٣: «مخزون سيارتي» دون اتصال — كاشٌ لكل مندوب، و«المتبقّي» بعد فواتير الصندوق (rep/vanStockOffline.ts).
//   • D8: تحميل المندوب بمرجعٍ واحد لكل محاولة حفظ (attemptClientRef)، وD2: متاح المستودع بجوار الصنف الناقص.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { VAN_STOCK_REPLAY_HELD_CODE, underVanStockHeld, vanStockHeldRecheckDue } from './vanStockHeld';
import { REVIEW_RECHECK_MS } from './outboxReview';
import { vanCurrentCacheOf, vanRowsWithPending } from './vanStockOffline';
import type { OutboxDoc } from './offlineDb';
import { PHRASES } from '../i18n/strings';

const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), ...p), 'utf8');
const T = Date.parse('2026-11-05T08:00:00.000Z');

test('D5: المحجوز بعجز السيارة مصفوفٌ «بانتظار الإدارة» لا يُسأل قبل المهلة، ويخرج من الوسم إن رُفع أو رُفض', () => {
  assert.equal(VAN_STOCK_REPLAY_HELD_CODE, 'VAN_STOCK_REPLAY_HELD');
  const server = read('..', 'backend', 'src', 'services', 'repSaleStock.ts');
  assert.ok(server.includes(`export const VAN_STOCK_REPLAY_HELD = '${VAN_STOCK_REPLAY_HELD_CODE}';`), 'الرمز كما يرسله الخادم');
  const at = new Date(T).toISOString();
  assert.equal(vanStockHeldRecheckDue({ reviewCode: VAN_STOCK_REPLAY_HELD_CODE, reviewCheckedAt: at }, T + REVIEW_RECHECK_MS - 1), false);
  assert.equal(vanStockHeldRecheckDue({ reviewCode: VAN_STOCK_REPLAY_HELD_CODE, reviewCheckedAt: at }, T + REVIEW_RECHECK_MS), true);
  assert.equal(vanStockHeldRecheckDue({ reviewCode: VAN_STOCK_REPLAY_HELD_CODE }, T), true, 'بلا لحظة سؤال: يُسأل');
  assert.equal(vanStockHeldRecheckDue({ reviewCode: 'LOT_REPLAY_HELD', reviewCheckedAt: at }, T), true, 'غيره لا يحكمه هذا');
  assert.equal(vanStockHeldRecheckDue({}, T), true);
  assert.equal(underVanStockHeld({ reviewCode: VAN_STOCK_REPLAY_HELD_CODE, status: 'queued' }), true);
  assert.equal(underVanStockHeld({ reviewCode: VAN_STOCK_REPLAY_HELD_CODE, status: 'rejected' }), false);
  assert.equal(underVanStockHeld({ reviewCode: VAN_STOCK_REPLAY_HELD_CODE, status: 'sent' }), false);
  assert.equal(underVanStockHeld({ reviewCode: 'LOT_REPLAY_HELD', status: 'queued' }), false);
});

test('D5 حارس نصّي: المزامنة تُبقي المحجوز مصفوفاً بوسمه ورسالة الخادم وتتابع، قبل فرع الرفض — والمهلة في الفرز', () => {
  const s = read('src', 'rep', 'offlineSync.ts');
  assert.ok(s.includes("import { VAN_STOCK_REPLAY_HELD_CODE, vanStockHeldRecheckDue } from './vanStockHeld';"));
  assert.ok(s.includes('.filter((d) => vanStockHeldRecheckDue(d, startedAt))'));
  const i = s.indexOf('if (code === VAN_STOCK_REPLAY_HELD_CODE) {');
  assert.ok(i > s.indexOf('if (code === LOT_REPLAY_HELD_CODE) {'), 'بعد حجز اللوط');
  assert.ok(i < s.indexOf("status: 'rejected'"), 'قبل فرع رفض الأعمال (4xx)');
  const block = s.slice(i, s.indexOf('\n        }', i));
  assert.match(block, /await outboxUpdate\(\{ \.\.\.doc, reviewCode: VAN_STOCK_REPLAY_HELD_CODE, reviewCheckedAt: new Date\(\)\.toISOString\(\), error: msg \|\| undefined \}\);\s*continue;$/);
  assert.doesNotMatch(block, /stopped = true|break;|status: '/, 'لا توقّف ولا رفض ولا إعدام');
  // لوحة الصندوق: الوسم والتفسير نفساهما لحجز اللوط
  const app = read('src', 'rep', 'RepApp.tsx');
  const panel = app.slice(app.indexOf('function OutboxPanel('), app.indexOf('\n}\n', app.indexOf('function OutboxPanel(')));
  assert.ok(panel.includes('{docs.some(d => underLotReplayHeld(d) || underVanStockHeld(d)) && ('));
  assert.ok(panel.includes('{(underLotReplayHeld(d) || underVanStockHeld(d)) && ('));
});

const doc = (o: Partial<OutboxDoc> & { items?: { productId: string; qty: number; unitFactor?: number }[]; type?: string }): OutboxDoc => ({
  clientRef: Math.random().toString(36).slice(2), kind: 'invoice', status: 'queued', clientCreatedAt: new Date(T).toISOString(), repId: 'r1',
  payload: { type: o.type ?? 'CASH', items: o.items ?? [{ productId: 'pW', qty: 2 }] }, ...o,
} as OutboxDoc);
const rows = [
  { productId: 'pW', remaining: 10 },
  { productId: 'pC', remaining: 48 },
  { productId: 'pL', remaining: 5 },
];

test('البند ١٣: «المتبقّي» بعد فواتير البيع في الصندوق — المنتظرة والمرفوضة والمحجوزة والمرفوعة بعد الجلب، بالأساس، لصاحب الجلسة', () => {
  const fetchedAt = T;
  const out = vanRowsWithPending(rows, [
    doc({ items: [{ productId: 'pW', qty: 2 }] }),
    doc({ status: 'rejected', items: [{ productId: 'pW', qty: 1 }] }),
    doc({ reviewCode: VAN_STOCK_REPLAY_HELD_CODE, items: [{ productId: 'pC', qty: 1, unitFactor: 24 }] }),
    doc({ status: 'sent', sentAt: new Date(T + 1000).toISOString(), items: [{ productId: 'pW', qty: 1 }] }),
    doc({ status: 'sent', sentAt: new Date(T - 1000).toISOString(), items: [{ productId: 'pW', qty: 5 }] }), // عرفه الردّ
    doc({ type: 'RETURN', items: [{ productId: 'pW', qty: 4 }] }), // المرتجع المعلّق لا يزيد
    doc({ repId: 'r2', items: [{ productId: 'pW', qty: 3 }] }), // زميلٌ على الجهاز نفسه
    doc({ kind: 'receipt', items: [{ productId: 'pW', qty: 9 }] }),
    doc({ items: [{ productId: 'pL', qty: 2 }] }), // متتبَّعٌ تعرضه لقطة اللوط
  ], fetchedAt, 'r1', null, new Set(['pL']));
  assert.deepEqual(out.rows.map((r) => [r.productId, r.remaining, r.pendingBase]), [['pW', 6, 4], ['pC', 24, 24], ['pL', 5, 0]]);
  assert.equal(out.pendingDocs, 4);
  const none = vanRowsWithPending(rows, [], fetchedAt, 'r1');
  assert.deepEqual(none.rows.map((r) => r.remaining), [10, 48, 5]);
  assert.equal(none.pendingDocs, 0);
});

test('البند ١٣: الكاش لصاحبه وبشكله — مندوبٌ آخر أو نسخةٌ تالفة ⇒ null', () => {
  const c = { v: 1, repId: 'r1', fetchedAt: T, rows };
  assert.deepEqual(vanCurrentCacheOf(c, 'r1'), c);
  assert.equal(vanCurrentCacheOf(c, 'r2'), null, 'جهازٌ مشترك');
  assert.equal(vanCurrentCacheOf(c, undefined), null);
  assert.equal(vanCurrentCacheOf({ ...c, v: 2 }, 'r1'), null);
  assert.equal(vanCurrentCacheOf({ ...c, rows: 'x' }, 'r1'), null);
  assert.equal(vanCurrentCacheOf({ ...c, fetchedAt: NaN }, 'r1'), null);
  assert.equal(vanCurrentCacheOf(null, 'r1'), null);
});

test('البند ١٣ وD8 وD2 حرّاس نصّية: الجلب يحفظ ويقرأ الكاش عند الانقطاع وحده، والتحميل بمرجع محاولة، والمتاح بجوار الناقص', () => {
  const app = read('src', 'rep', 'RepApp.tsx');
  const v = app.slice(app.indexOf('function RepVanStock('), app.indexOf('\n}\n', app.indexOf('function RepVanStock(')));
  const load = v.slice(v.indexOf('const loadStock = useCallback('), v.indexOf('useEffect(() => { loadStock(); }, [loadStock]);'));
  assert.ok(load.includes('cacheSet<VanCurrentCache<RepVanRow>>(VAN_CURRENT_CACHE_PREFIX + me, { v: 1, repId: me, fetchedAt: startedAt, rows })'));
  assert.ok(load.indexOf('if (isNetworkError(e)) {') < load.indexOf('cacheGet<unknown>(VAN_CURRENT_CACHE_PREFIX + me)'), 'الكاش للانقطاع وحده');
  assert.ok(v.includes('vanRowsWithPending(stockRaw.rows, docs, stockRaw.fetchedAt, currentRepId(), products,'));
  assert.ok(v.includes('const off = onOutboxChange(apply);'));
  assert.ok(v.includes("stock.length === 0 && net.kind === 'none' ? ("), 'لا «سيارة فارغة» بلا اتصال ولا نسخة');
  const submit = v.slice(v.indexOf('const submit = async () => {'), v.indexOf("if (view === 'request') {"));
  assert.ok(submit.includes('loadAttempt.current = attemptClientRef(loadAttempt.current, body, newClientRef);'));
  assert.ok(submit.includes("await repApi.post('/van-stock/loads', { ...body, clientRef: loadAttempt.current.ref });"));
  assert.ok(submit.indexOf('loadAttempt.current = null;') > submit.indexOf("await repApi.post('/van-stock/loads'"), 'يُمحى بعد النجاح وحده');
  assert.ok(submit.includes("if (d?.code === 'WAREHOUSE_INSUFFICIENT' && Array.isArray(d.lines)) {"));
  for (const k of ['غير متصل — آخر تحديث {time}', 'المتبقي بعد خصم {n} من صندوق الإرسال', 'لا اتصال ولا نسخة محفوظة لمخزون سيارتك اتصل مرة لعرضه']) {
    assert.ok(v.includes(`tr('${k}')`), k);
    for (const lang of ['en', 'fr', 'tr', 'zh'] as const) {
      assert.ok(PHRASES[k]?.[lang], `${k} بلا ${lang}`);
      for (const ph of k.match(/\{[a-z]+\}/g) ?? []) assert.ok(PHRASES[k][lang].includes(ph), `${ph} في ${lang}`);
    }
  }
});
