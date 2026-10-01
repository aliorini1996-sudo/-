// حلقة التعلّم — «الطلب المتوقع من ملف المحل في Google» (gsig-1): اللقطة عند التحويل موسومةً بمحرّكها وما عُرض فعلاً،
// ولقطات المحلات المشابهة (ai-est-1) ولقطاته لا تختلطان، والمعامل لكل نوع = وسيط أصوات العملاء منكمشاً، وبوابة الاستبعاد
// الواحد، والرجوع التلقائي، وحلّ المعامل للعرض. فوق Prisma مزيّف — بلا قاعدة.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

// ───────────── Prisma مزيّف ─────────────
const db = {
  snapFind: [] as { where: Record<string, unknown> }[],
  snapRows: [] as unknown[],
  created: [] as Record<string, unknown>[],
  failCreate: false,
};
stub('config/database', {
  default: {
    tenant: { findUnique: async () => ({ aiRepEnabled: true, accountingEnabled: true }) },
    aiOutlet: { upsert: async () => ({ id: 'out-1' }) },
    aiOutletEvent: { create: async () => ({}) },
    aiRepSettings: { findUnique: async () => null },
    aiEstimateSnapshot: {
      findMany: async (a: { where: Record<string, unknown> }) => { db.snapFind.push(a); return db.snapRows; },
      create: async (a: { data: Record<string, unknown> }) => { if (db.failCreate) throw new Error('db down'); db.created.push(a.data); return a.data; },
    },
  },
});
// بيانات المحرّك: بلا عملاء مشابهين ⇒ لا لقطة ai-est-1 (لا رقم من أقل من الحدّ)
stub('ai-rep/estimateData', {
  loadEstimateData: async () => ({ timezone: 'Asia/Riyadh', window: { from: '2026-03', to: '2026-08' }, peers: [], monthly: [], firstOrders: [], products: [] }),
  invalidateEstimateData: () => undefined, tenantTimezone: async () => 'Asia/Riyadh',
});
// eslint-disable-next-line @typescript-eslint/no-var-requires
const realStore = require('../ai-rep/learn/store') as typeof import('../ai-rep/learn/store');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const T = require('../ai-rep/learn/types') as typeof import('../ai-rep/learn/types');
stub('ai-rep/learn/store', { ...realStore, getLearned: async () => ({ ...T.EMPTY_LEARNED }) });

// eslint-disable-next-line @typescript-eslint/no-var-requires
const GS = require('../ai-rep/learn/gsig') as typeof import('../ai-rep/learn/gsig');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const CAL = require('../ai-rep/learn/calibration') as typeof import('../ai-rep/learn/calibration');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const S = require('../ai-rep/session') as typeof import('../ai-rep/session');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { linkConvertedCustomer } = require('../ai-rep/convert') as typeof import('../ai-rep/convert');
type CalPair = import('../ai-rep/learn/calibration').CalPair;

const shown = (o: Partial<import('../ai-rep/learn/gsig').ShownExpected> = {}) => ({
  at: Date.parse('2026-09-20T09:00:00Z'), outletType: 'GROCERY', confidence: 'MEDIUM', calVersion: null, factor: 1,
  products: [{ productId: 'eggs', qty: 12, raw: 11.6 }, { productId: 'milk', qty: 4, raw: 4.2 }], ...o,
});
/** n عميلاً، لكلٍّ منهم صنفان، الفعلي = ratio × الخام */
function ratioPairs(n: number, t: string, ratio: number, prefix = t): CalPair[] {
  const out: CalPair[] = [];
  for (let i = 0; i < n; i++) for (const pred of [6 + i, 20 + i]) out.push({ customerId: `${prefix}${i}`, outletType: t, pred, actual: ratio * pred, w: 1, source: 'SNAPSHOT' });
  return out;
}

// ───────────── اللقطة عند التحويل ─────────────

test('لقطة gsig-1: الوسم والنافذة (أشهر المرساة الستة حتى لحظة العرض) والمعروض والخام', () => {
  const d = GS.gsigSnapshotData('T1', { outletId: 'o', customerId: 'c' }, shown({ calVersion: 3, factor: 1.2 }));
  assert.deepEqual(
    { engineVersion: d.engineVersion, windowFrom: d.windowFrom, windowTo: d.windowTo, calibrationVersion: d.calibrationVersion, ringKm: d.ringKm, peers: d.peers },
    { engineVersion: 'gsig-1', windowFrom: '2026-03', windowTo: '2026-09', calibrationVersion: 3, ringKm: null, peers: 0 },
  );
  assert.deepEqual(d.payload, {
    v: 1, engine: 'gsig-1', calibrationVersion: 3, factor: 1.2,
    products: [{ productId: 'eggs', qty: 12, qtyRaw: 11.6 }, { productId: 'milk', qty: 4, qtyRaw: 4.2 }],
  });
});

test('التحويل: ما عُرض للمحل يُحفظ لقطةً موسومة gsig-1 بالمعروض والخام — مرة واحدة', async () => {
  S.clearSessions(); db.created = []; db.failCreate = false;
  S.noteShownExpected('T1', 'ChIJshop', shown({ at: Date.now(), calVersion: 3, factor: 1.2 }));
  await linkConvertedCustomer('T1', { id: 'c1', lat: 24.7, lng: 46.7, outletType: 'GROCERY', aiPlaceId: 'ChIJshop' }, 'rep-1');
  assert.equal(db.created.length, 1, 'بلا محلات مشابهة كافية ⇒ لقطة gsig-1 وحدها');
  const snap = db.created[0];
  assert.equal(snap.engineVersion, 'gsig-1');
  assert.deepEqual(
    { tenantId: snap.tenantId, outletId: snap.outletId, customerId: snap.customerId, outletType: snap.outletType, calibrationVersion: snap.calibrationVersion, peers: snap.peers },
    { tenantId: 'T1', outletId: 'out-1', customerId: 'c1', outletType: 'GROCERY', calibrationVersion: 3, peers: 0 },
  );
  assert.deepEqual((snap.payload as { products: unknown }).products, [{ productId: 'eggs', qty: 12, qtyRaw: 11.6 }, { productId: 'milk', qty: 4, qtyRaw: 4.2 }]);
  await linkConvertedCustomer('T1', { id: 'c1', lat: 24.7, lng: 46.7, outletType: 'GROCERY', aiPlaceId: 'ChIJshop' }, 'rep-1');
  assert.equal(db.created.length, 1, 'الذاكرة تُستهلك: لا لقطة ثانية');
});

test('التحويل: بلا عرضٍ في الذاكرة (أو عرضٍ أقدم من يوم، أو لشركة أخرى) لا لقطة، وتعذّر الكتابة لا يُسقط التحويل', async () => {
  S.clearSessions(); db.created = [];
  S.noteShownExpected('T2', 'ChIJshop', shown());
  await linkConvertedCustomer('T1', { id: 'c2', lat: 24.7, lng: 46.7, outletType: 'GROCERY', aiPlaceId: 'ChIJshop' }, 'rep-1');
  assert.equal(db.created.length, 0, 'عرض شركة أخرى لا يُستعمل');
  S.noteShownExpected('T1', 'ChIJold', shown({ at: Date.now() - S.SHOWN_TTL_MS - 1000 }));
  assert.equal(S.takeShownExpected('T1', 'ChIJold'), null);
  db.failCreate = true;
  S.noteShownExpected('T1', 'ChIJfail', shown({ at: Date.now() }));
  await linkConvertedCustomer('T1', { id: 'c3', lat: 24.7, lng: 46.7, outletType: 'GROCERY', aiPlaceId: 'ChIJfail' }, 'rep-1');
  db.failCreate = false;
});

test('الوسم يفصل المحرّكين: لقطات المحلات المشابهة ai-est-1 وحدها في معايرتها، وgsig-1 وحدها في معامله', async () => {
  db.snapFind = []; db.snapRows = [];
  await CAL.loadSnapshotPairs('T1');
  await GS.loadGsigPairs('T1');
  assert.equal(db.snapFind[0].where.engineVersion, 'ai-est-1');
  assert.equal(db.snapFind[0].where.tenantId, 'T1');
  assert.equal(db.snapFind[1].where.engineVersion, 'gsig-1');
  assert.equal(db.snapFind[1].where.tenantId, 'T1');
  assert.deepEqual(db.snapFind[1].where.evaluatedAt, { not: null });
  // حمولة gsig-1 لا تصير زوجاً في معايرة المحلات المشابهة ولو وصلتها (لا trialQty)
  const g = { customerId: 'c1', outletType: 'GROCERY', calibrationVersion: null, actual: { first: { eggs: 10 }, noPurchase: false }, payload: { products: [{ productId: 'eggs', qty: 12, qtyRaw: 11.6 }] } };
  assert.deepEqual(CAL.snapshotPairs([g]), []);
  assert.deepEqual(GS.gsigPairs([g]), [{ customerId: 'c1', outletType: 'GROCERY', pred: 11.6, actual: 10, w: 1, source: 'SNAPSHOT', shown: 12, calVersion: null }]);
  assert.deepEqual(GS.gsigPairs([{ ...g, actual: { first: {}, noPurchase: true } }]), [], 'لم يشترِ ⇒ لا زوج');
});

// ───────────── التقدير والبوابة والرجوع ─────────────

test('المعامل: وسيط أصوات العملاء منكمشاً نحو ١ للشركة ونحو الشركة للنوع، ولا يُفعَّل قبل max(8, minPeers) عميلاً', () => {
  const fit = GS.fitGsig(ratioPairs(12, 'GROCERY', 0.6), 5);
  assert.equal(fit.active, true);
  assert.equal(fit.customers, 12);
  const muT = (12 * Math.log(0.6)) / 16;
  assert.ok(Math.abs(fit.params.tenant - Math.exp(muT)) < 1e-3, `tenant ${fit.params.tenant}`);
  assert.ok(Math.abs(fit.params.byType.GROCERY - Math.exp((12 * Math.log(0.6) + 4 * muT) / 16)) < 1e-3);
  assert.equal(GS.fitGsig(ratioPairs(7, 'GROCERY', 0.6), 5).active, false, 'دون ٨ عملاء');
  const mixed = GS.fitGsig([...ratioPairs(10, 'GROCERY', 2), ...ratioPairs(3, 'CAFE', 0.5)], 5);
  assert.equal(mixed.params.byType.CAFE, undefined, 'نوعٌ بأقل من minPeers يرث معامل الشركة');
  assert.equal(GS.fitGsig(ratioPairs(20, 'GROCERY', 9), 5).params.byType.GROCERY, 2, 'محصور عند ٢');
  // صوتٌ واحد لكل عميل: عميل بعشرين صنفاً لا يطغى
  const heavy: CalPair[] = Array.from({ length: 20 }, (_, i) => ({ customerId: 'big', outletType: 'GROCERY', pred: 10 + i, actual: 3 * (10 + i), w: 1, source: 'SNAPSHOT' }));
  const v = GS.fitGsig([...ratioPairs(10, 'GROCERY', 1), ...heavy], 5);
  assert.ok(v.params.tenant < 1.1, `tenant ${v.params.tenant}`);
});

test('البوابة باستبعاد عميل واحد: تُرقّي ما يخفض الخطأ وترفض ما لا يحسّنه', () => {
  const good = GS.gsigGate(ratioPairs(12, 'GROCERY', 0.6), 5, null);
  assert.equal(good.ok, true);
  assert.ok(good.E < good.E0);
  const noise: CalPair[] = [];
  for (let i = 0; i < 12; i++) noise.push({ customerId: `n${i}`, outletType: 'GROCERY', pred: 10, actual: i % 2 ? 20 : 5, w: 1, source: 'SNAPSHOT' });
  assert.equal(GS.gsigGate(noise, 5, null).ok, false, 'نصفٌ ضعف ونصفٌ نصف ⇒ لا معامل يحسّن');
  const cur = GS.fitGsig(ratioPairs(12, 'GROCERY', 0.6), 5).params;
  assert.equal(GS.gsigGate(ratioPairs(12, 'GROCERY', 0.6), 5, cur).ok, false, 'لا يُرقّى ما لا يحسّن الحالي');
});

test('الرجوع التلقائي (checkCalRollback نفسه): المعروض بالمعامل أسوأ من الخام عند أغلب العملاء ⇒ رجوع', () => {
  const worse: CalPair[] = Array.from({ length: 10 }, (_, i) => ({ customerId: `w${i}`, outletType: 'GROCERY', pred: 10, shown: 20, actual: 10, w: 1, source: 'SNAPSHOT', calVersion: 4 }));
  assert.equal(CAL.checkCalRollback(worse, 4, 5).rollback, true);
  assert.equal(CAL.checkCalRollback(worse, 9, 5).rollback, false, 'نسخة أخرى لا تُحاسَب');
});

test('حلّ المعامل للعرض: النوع ثم الشركة، OFF أو بلا نسخة ⇒ ١، والمعامل ١ بلا نسخة', () => {
  const learned = { ...T.EMPTY_LEARNED, gsig: { version: 5, params: { v: 1 as const, tenant: 0.8, byType: { CAFE: 1.4 }, customers: 9, pairs: 30 } } };
  assert.deepEqual(GS.resolveGsigFactor(learned, 'CAFE', 'AUTO'), { factor: 1.4, version: 5 });
  assert.deepEqual(GS.resolveGsigFactor(learned, 'GROCERY', 'AUTO'), { factor: 0.8, version: 5 });
  assert.deepEqual(GS.resolveGsigFactor(learned, 'CAFE', 'OFF'), { factor: 1, version: null });
  assert.deepEqual(GS.resolveGsigFactor({ ...T.EMPTY_LEARNED }, 'CAFE', 'AUTO'), { factor: 1, version: null });
  assert.deepEqual(GS.resolveGsigFactor({ ...learned, gsig: { version: 6, params: { ...learned.gsig.params, tenant: 1, byType: {} } } }, 'GROCERY', 'AUTO'), { factor: 1, version: null });
});

test('المعاملات المحفوظة تُفحص قبل الثقة بها', () => {
  assert.deepEqual(realStore.saneGsig({ tenant: 1.3, byType: { CAFE: 0.7, BAD: 9, NAN: 'x' }, customers: 9, pairs: 20 }), { v: 1, tenant: 1.3, byType: { CAFE: 0.7 }, customers: 9, pairs: 20 });
  assert.equal(realStore.saneGsig({ tenant: 3 }), null);
  assert.equal(realStore.saneGsig(null), null);
});
