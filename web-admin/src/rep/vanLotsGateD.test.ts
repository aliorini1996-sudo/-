// «تتبّع اللوط» — البوابة D (تطبيق المندوب دون اتصال): انحدارات البنود 7 و9 و10 و11 و13 من مراجعة البوابة.
// منطقٌ صرف من rep/vanLots.ts وrep/docLots.ts، وحرّاسٌ نصّية على مواضعه في RepApp.tsx (المكوّن لا يُرسم هنا).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as V from './vanLots';
import * as D from './docLots';
import type { OutboxDoc } from './offlineDb';
import { LOT_EPS, type LotRef, type VanLotSnapshotDto } from '../lib/lots';

const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), ...p), 'utf8').replace(/\r\n/g, '\n');
const TODAY = '2026-11-10';
const ME = 'rep-1';

const lot = (lotId: string, usable: number, expiryDate: string) =>
  ({ lotId, lotNumber: lotId, expiryDate, status: 'ACTIVE' as const, blockKind: null, usable });
const snapAB = (): VanLotSnapshotDto => ({
  serverTime: '2026-11-10T08:00:01.000Z', day: TODAY, tracked: ['P'], allowUnknown: true,
  products: [{
    productId: 'P', available: 44, availableNamed: 44, unknownUsable: 0, quarantined: 0, held: 0, expiredUnsold: 0, expiredReturned: 0, damaged: 0,
    lots: [lot('A', 30, '2026-12-01'), lot('B', 14, '2027-01-01')],
  }],
});
const sumByLot = (hints: readonly (readonly LotRef[] | null | undefined)[]) => {
  const m = new Map<string, number>();
  for (const h of hints) for (const r of h ?? []) m.set(r.lotId ?? '∅', (m.get(r.lotId ?? '∅') ?? 0) + r.qty);
  return m;
};

// ─── 7: تلميحٌ معلّق لا تسعه اللقطة لا يجعل أسطر السلّة تتجاوز صالح التشغيلة ───

test('7: أسطر الصنف على ميزانيةٍ واحدة بعد المعلّق — معلّقٌ لا تسعه اللقطة لا يعيد نشر ما أخذته السلّة (كرتون + حبّات)', () => {
  const s = snapAB();
  // فاتورةٌ مصفوفة بتلميح B:20 وB صالحه 14 — لا تسعه اللقطة، فيُطرح الصنف كله بالقاعدة: A 10، B 14
  const d1: OutboxDoc = {
    clientRef: 'd1', repId: ME, kind: 'invoice', status: 'queued', clientCreatedAt: '2026-11-10T07:00:00.000Z',
    payload: { type: 'CASH', items: [{ productId: 'P', qty: 20, lots: [{ lotId: 'B', qty: 20 }] }] },
  };
  const pending = V.pendingOut([d1], [], Date.parse('2026-11-10T08:00:00.000Z'), ME);
  const base = V.localLotView(s, 'P', TODAY, pending);
  assert.deepEqual(base.lots.map((x) => [x.lot.lotId, x.left]), [['A', 10], ['B', 14]]);
  const lines = [
    { productId: 'P', qty: 1, unitFactor: 12, tracked: true },  // كرتون = 12
    { productId: 'P', qty: 10, unitFactor: 1, tracked: true },  // 10 حبّات
  ];
  const plan = V.offlineLotPlan(s, lines, TODAY, pending);
  assert.equal(plan.ok, true);
  const hints = (plan as { ok: true; hints: (LotRef[] | undefined)[] }).hints;
  // الكرتون كاملاً من تشغيلةٍ واحدة (B)، والحبّات مما بقي (A) — لا B:22 على صالحٍ 14 يرفضه الخادم فتفترق الورقة عن السجل
  assert.deepEqual(hints, [[{ lotId: 'B', qty: 12 }], [{ lotId: 'A', qty: 10 }]]);
  const left = new Map(base.lots.map((x) => [x.lot.lotId, x.left]));
  for (const [k, q] of sumByLot(hints)) assert.ok(q <= (left.get(k) ?? 0) + LOT_EPS, `${k}: ${q} فوق الباقي ${left.get(k)}`);
  // cartHints مباشرةً: النتيجة نفسها، والمعلّق المعطى لا يتغيّر
  const total = pending.get('P')!.total;
  const h2 = V.cartHints(s, [
    { productId: 'P', baseQty: 12, unitFactor: 12, tracked: true }, { productId: 'P', baseQty: 10, unitFactor: 1, tracked: true },
  ], TODAY, pending);
  assert.deepEqual(h2, [[{ lotId: 'B', qty: 12 }], [{ lotId: 'A', qty: 10 }]]);
  assert.equal(pending.get('P')!.total, total);
});

test('7: سطرٌ لا يكفيه المتاح (null) لا يستهلك من الميزانية — ما بعده يأخذ كما لو لم يكن', () => {
  const s = snapAB(); // A 30، B 14، غير المسمّى 0
  const h = V.cartHints(s, [
    { productId: 'P', baseQty: 50, unitFactor: 1, tracked: true },
    { productId: 'P', baseQty: 44, unitFactor: 1, tracked: true },
  ], TODAY, new Map());
  assert.equal(h[0], null);
  assert.deepEqual(h[1], [{ lotId: 'A', qty: 30 }, { lotId: 'B', qty: 14 }]);
});

// ─── 9: طلب لقطةٍ بعد مزامنةٍ أو إصدار لا يُدمج في جلبٍ بدأ قبله ───

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
};

test('9: latestFlight — الطلب العادي يشارك الجلب الجاري، و«بعد حدث» (fresh) يُلحَق به جلبٌ واحد يبدأ بعد انتهائه', async () => {
  assert.equal(typeof V.latestFlight, 'function', 'latestFlight غير موجودة');
  const flight = V.latestFlight<number>();
  const calls: ReturnType<typeof deferred<number>>[] = [];
  const start = () => { const d = deferred<number>(); calls.push(d); return d.promise; };
  assert.equal(flight.busy, false);
  const a = flight.run(start);
  assert.equal(flight.busy, true);
  assert.equal(flight.run(start), a, 'العادي يشارك الجاري');
  const b = flight.run(start, true);
  const c = flight.run(start, true);
  assert.notEqual(b, a);
  assert.equal(c, b, 'جلبٌ لاحقٌ واحد لكل من طلبه أثناء الجاري');
  assert.equal(calls.length, 1, 'لا يبدأ اللاحق قبل انتهاء الجاري');
  calls[0].resolve(1);
  assert.equal(await a, 1);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls.length, 2, 'بدأ الجلب اللاحق بعد انتهاء الأول');
  calls[1].resolve(2);
  assert.equal(await b, 2);
  assert.equal(flight.busy, false);
  // فشل الجاري لا يمنع اللاحق، وبلا جارٍ يبدأ فوراً
  const e = flight.run(() => Promise.reject(new Error('x')));
  const f = flight.run(() => Promise.resolve(3), true);
  await assert.rejects(e);
  assert.equal(await f, 3);
});

test('9: نموذج السباق — فاتورة رُفعت أثناء جلب اللقطة تُطرح مرةً واحدة بعد الجلب اللاحق', async () => {
  let now = 1000;
  const sold = { base: 10, posted: false };
  const gets: number[] = [];
  const pendingGet: (() => void)[] = [];
  let stored: V.StoredVanLots | null = null;
  const snapNow = (): VanLotSnapshotDto => ({
    ...snapAB(),
    products: [{ ...snapAB().products[0], lots: [lot('L1', sold.base - (sold.posted ? 4 : 0), '2026-12-01')] }],
  });
  const fetchNow = () => {
    const fetchedAt = now;
    gets.push(fetchedAt);
    return new Promise<V.StoredVanLots | null>((res) => {
      pendingGet.push(() => { stored = V.vanLotsEntry(snapNow(), ME, fetchedAt); res(stored); });
    });
  };
  const flight = V.latestFlight<V.StoredVanLots | null>();
  void flight.run(fetchNow); // فتح التطبيق: الجلب يبدأ عند 1000
  // المزامنة ترفع فاتورة 4 فيلتزم بها الخادم، ويُختم sentAt عند 1200، ثم يُطلب التحديث بعدها
  sold.posted = true; now = 1200;
  const doc: OutboxDoc = {
    clientRef: 'q', repId: ME, kind: 'invoice', status: 'sent', sentAt: new Date(1200).toISOString(), clientCreatedAt: new Date(900).toISOString(),
    payload: { type: 'CASH', items: [{ productId: 'P', qty: 4 }] },
  };
  const after = flight.run(fetchNow, true);
  now = 1300; pendingGet.shift()!(); // ردّ الجلب الأول بعد الالتزام: اللقطة تعرف الفاتورة
  await new Promise((r) => setTimeout(r, 0));
  now = 1400; pendingGet.shift()!();
  await after;
  assert.equal(gets.length, 2, 'جلبٌ ثانٍ بعد المزامنة');
  assert.ok(stored!.fetchedAt > Date.parse(doc.sentAt!), 'اللقطة المخزّنة بدأت بعد الرفع');
  const avail = V.localAvailable(stored!.snap, 'P', TODAY, V.pendingOut([doc], [], stored!.fetchedAt, ME));
  assert.equal(avail, 6, 'المتاح كما في الخادم — لا طرحٌ مزدوج');
});

test('9: refreshVanLots على latestFlight، والمزامنة والإصدار المتصل يطلبان جلباً لاحقاً (fresh)', () => {
  const app = read('src', 'rep', 'RepApp.tsx');
  assert.match(app, /const vanLotsFlight = useRef\(latestFlight<StoredVanLots \| null>\(\)\);/);
  const r = app.indexOf('const refreshVanLots = useCallback(');
  const body = app.slice(r, app.indexOf('}, []);', r));
  assert.match(body, /\(minGapMs = 0, fresh = false\)/);
  assert.match(body, /if \(vanLotsFlight\.current\.busy\) return vanLotsFlight\.current\.run\(fetchNow, fresh\);/);
  assert.doesNotMatch(body, /vanLotsFlight\.current = /, 'لا مرجعٌ يدوي للجلب الجاري');
  assert.match(app, /onInvoicesSynced\(\(\) => \{ void refreshVanLots\(0, true\); \}\)/);
  const add = app.slice(app.indexOf('const lotPostedAdd = ('), app.indexOf('const lotPostedLines = ('));
  assert.match(add, /\.then\(\(\) => lots\?\.refresh\(0, true\)\);/);
  assert.match(app, /refresh: \(minGapMs\?: number, fresh\?: boolean\) => Promise<StoredVanLots \| null>/);
});

// ─── 10: المرتجع المتصل يجلب اللقطة ───

test('10: returnRefreshesSnapshot — مرتجعٌ بصنفٍ متتبَّع والميزة مفعّلة وحده', () => {
  assert.equal(typeof V.returnRefreshesSnapshot, 'function', 'returnRefreshesSnapshot غير موجودة');
  const tracked = new Set(['P']);
  assert.equal(V.returnRefreshesSnapshot(true, true, tracked, [{ productId: 'X' }, { productId: 'P' }]), true);
  assert.equal(V.returnRefreshesSnapshot(true, true, tracked, [{ productId: 'X' }]), false, 'بلا متتبَّع لا طلب');
  assert.equal(V.returnRefreshesSnapshot(false, true, tracked, [{ productId: 'P' }]), false, 'الميزة مطفأة: لا شيء');
  assert.equal(V.returnRefreshesSnapshot(true, false, tracked, [{ productId: 'P' }]), false, 'البيع له مساره (lotPostedAdd)');
});

test('10: الإصدار المتصل للمرتجع (201 و202) يجلب اللقطة لاحقاً بلا تسجيله معلّقاً', () => {
  const app = read('src', 'rep', 'RepApp.tsx');
  const sub = app.slice(app.indexOf('const submit = async () => {'), app.indexOf('const refreshUnits = async () => {'));
  const fn = app.slice(app.indexOf('const lotReturnRefresh = () => {'), app.indexOf('const lotPostedLines = ('));
  assert.ok(fn.length > 0, 'lotReturnRefresh غير موجودة');
  assert.match(fn, /returnRefreshesSnapshot\(lotOn, isReturn, trackedIds\(lots\?\.stored\?\.snap, products\), lines\)\) void lots\?\.refresh\(0, true\);/);
  const g202 = sub.indexOf('if (res.status !== 201) {');
  const end202 = sub.indexOf('const inv = res.data.data;', g202);
  assert.match(sub.slice(g202, end202), /if \(lotCapsOn\) lotPostedLines\(clientRef\);[^\n]*\n\s*else lotReturnRefresh\(\);/);
  const p201 = sub.indexOf('if (lotCapsOn && lotTrackedNow) lotPostedAdd(clientRef, postedItemsFromServer(inv.items, lotTrackedNow));');
  assert.ok(p201 > end202);
  assert.match(sub.slice(p201), /^if \(lotCapsOn && lotTrackedNow\) lotPostedAdd\([^\n]*\n\s*else lotReturnRefresh\(\);/);
});

// ─── 11: إعادة الفتح بـwithLots=1 والميزة مفعّلة ───

test('11: repInvoiceGetConfig — withLots=1 مع الميزة وحدها، ومطفأةً لا خيارات (الطلب كما كان حرفاً)', () => {
  assert.equal(typeof D.repInvoiceGetConfig, 'function', 'repInvoiceGetConfig غير موجودة');
  assert.deepEqual(D.repInvoiceGetConfig({ lotTrackingEnabled: true }), { params: { withLots: 1 } });
  assert.deepEqual(D.repInvoiceGetConfig({ lotTrackingEnabled: true, lotOnInvoice: true }), { params: { withLots: 1 } });
  assert.equal(D.repInvoiceGetConfig({ lotTrackingEnabled: false, lotOnInvoice: true }), undefined);
  assert.equal(D.repInvoiceGetConfig({}), undefined, 'نسخة شركة قديمة بلا العلم');
  assert.equal(D.repInvoiceGetConfig(null), undefined);
});

test('11: فتح الفاتورة من الكشف ومن القائمة يرسل خيارات الشركة، والسندات كما هي', () => {
  const app = read('src', 'rep', 'RepApp.tsx');
  assert.ok(app.includes('const res = await repApi.get(`/invoices/${invId}`, repInvoiceGetConfig(company));'), 'الكشف');
  assert.ok(app.includes("const res = await repApi.get(`${endpoint}/${id}`, kind === 'invoice' ? repInvoiceGetConfig(company) : undefined);"), 'القائمة');
  assert.match(app, /<SimpleList key=\{`invoices-\$\{refreshKey\}`\} endpoint="\/invoices" kind="invoice" company=\{company\}/);
  assert.ok(app.includes('const res = await repApi.get(`/receipts/${recId}`);'), 'السند بلا خيارات');
});

// ─── 13: إشعار الدائن (المرحلة الثانية) يحمل creditedItemId لا returnOfItemId ───

test('13: matchServerItemLots يطابق بند إشعار الدائن ببند بيعه (creditedItemId) كما يطابق المرتجع (returnOfItemId)', () => {
  const lotsA = [{ lotId: 'A', quantity: 3, lot: { lotNumber: 'A1', expiryDate: null } }];
  const got = V.matchServerItemLots([{ productId: 'P', unitFactor: 1, qty: 3, saleItemId: 'S1' }], [
    { productId: 'P', unitFactor: 1, qty: 3, creditedItemId: 'S1', returnOfItemId: null, lots: lotsA },
  ]);
  assert.deepEqual(got, [[{ lotNumber: 'A1', qty: 3, expiryDate: null }]]);
  // المرحلة الأولى كما كانت
  assert.deepEqual(V.matchServerItemLots([{ productId: 'P', qty: 3, saleItemId: 'S1' }], [{ productId: 'P', qty: 3, returnOfItemId: 'S1', lots: lotsA }]),
    [[{ lotNumber: 'A1', qty: 3, expiryDate: null }]]);
  // بندٌ مرتبطٌ بإشعارٍ لا يأخذه سطرٌ غير مرتبط بالصنف
  assert.deepEqual(V.matchServerItemLots([{ productId: 'P', qty: 3 }], [{ productId: 'P', qty: 3, creditedItemId: 'S1', lots: lotsA }]), [undefined]);
});
