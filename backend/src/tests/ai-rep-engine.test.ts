// المندوب الذكي — محرّك توقّع مشتريات المحل المقترح (دالة صرفة) + التصنيف + دمج نتائج Google + الإعدادات.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  activeMonths, completeWindow, estimateOutlet, harrellDavis, regIncBeta, roundMoney, roundQty, snapPoint, ymInTz,
  EngineInput, PeerCustomer, PeerProductMonth,
} from '../ai-rep/estimate';
import { googleTypesFor, outletTypeFromGoogle, suggestOutletType } from '../ai-rep/taxonomy';
import { parsePlaces, searchNearby, PLACES_FIELD_MASK } from '../ai-rep/places';
import { CLOSED_MEMORY_DAYS, customerBox, hiddenByMemory, mergeNearby, sameDay } from '../ai-rep/nearby';
import { aiRepSettingsSchema, repInScope, settingsView } from '../ai-rep/settings';

const NOW = new Date('2026-09-20T09:00:00Z');
const WINDOW = { from: '2026-03', to: '2026-08' };
const BASE = { lat: 24.7136, lng: 46.6753 }; // الرياض

// محلٌّ مشابه على بعد dxKm شرقاً
function peer(id: string, dxKm: number, opts: Partial<PeerCustomer> = {}): PeerCustomer {
  return {
    id, lat: BASE.lat, lng: BASE.lng + dxKm / 101, outletType: 'GROCERY',
    firstYm: '2025-01', lastInvoiceAt: new Date('2026-09-10T00:00:00Z'), ...opts,
  };
}
function months(customerId: string, productId: string, qtyPerMonth: number[], valuePerUnit = 10): PeerProductMonth[] {
  const yms = ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08'];
  return qtyPerMonth.map((q, i) => ({ customerId, productId, ym: yms[i], qty: q, value: q * valuePerUnit })).filter(r => r.qty !== 0);
}
function input(over: Partial<EngineInput> = {}): EngineInput {
  return {
    target: { lat: BASE.lat, lng: BASE.lng, outletType: 'GROCERY' },
    now: NOW, window: WINDOW, peers: [], monthly: [], firstOrders: [],
    products: [{ id: 'water', name: 'مياه ٥٠٠ مل', unit: 'كرتون' }, { id: 'juice', name: 'عصير', unit: 'كرتون' }],
    minPeers: 5, showMoney: true, ...over,
  };
}

// ───────────── الرياضيات ─────────────

test('بيتا غير التامة: قيم معروفة', () => {
  assert.ok(Math.abs(regIncBeta(0.5, 2, 2) - 0.5) < 1e-9);
  assert.ok(Math.abs(regIncBeta(0.3, 1, 1) - 0.3) < 1e-9);
  assert.equal(regIncBeta(0, 2, 3), 0);
  assert.equal(regIncBeta(1, 2, 3), 1);
});

test('Harrell–Davis: وسيط متماثل، ولا يساوي قيمة فرد في مجموعة غير متماثلة', () => {
  assert.ok(Math.abs(harrellDavis([1, 2, 3, 4, 5], 0.5) - 3) < 1e-9);
  const m = harrellDavis([1, 2, 3, 4, 100], 0.5);
  assert.ok(m > 3 && m < 10, `الوسيط المنعّم ${m}`);
  assert.ok(![1, 2, 3, 4, 100].includes(m));
  assert.ok(harrellDavis([5, 1, 3], 0.25) < harrellDavis([5, 1, 3], 0.75));
});

test('التقريب للعرض: لا دقّة زائفة', () => {
  assert.equal(roundQty(0.44), 0.4);
  assert.equal(roundQty(7.6), 8);
  assert.equal(roundQty(-2), 0);
  assert.equal(roundMoney(437), 440);
  assert.equal(roundMoney(2322), 2300);
});

test('النافذة والأشهر', () => {
  assert.deepEqual(completeWindow('2026-09', 6), { from: '2026-03', to: '2026-08' });
  assert.deepEqual(completeWindow('2026-02', 3), { from: '2025-11', to: '2026-01' });
  assert.equal(activeMonths('2025-01', WINDOW), 6);
  assert.equal(activeMonths('2026-06', WINDOW), 3);
  assert.equal(activeMonths('2026-09', WINDOW), 0);
  assert.equal(activeMonths(null, WINDOW), 0);
  // ٣١ أغسطس ٢٢:٠٠ بتوقيت غرينتش = ١ سبتمبر في الرياض
  assert.equal(ymInTz(new Date('2026-08-31T22:00:00Z'), 'Asia/Riyadh'), '2026-09');
});

test('تثبيت الموقع على الشبكة: نقطتان متقاربتان في الخلية نفسها', () => {
  const a = snapPoint(24.71361, 46.67531), b = snapPoint(24.71399, 46.67549);
  assert.deepEqual(a, b);
});

// ───────────── المحرّك ─────────────

test('أقل من ٥ محلات مشابهة ⇒ «بيانات غير كافية» مع السبب وطريقة الإصلاح', () => {
  const peers = ['a', 'b', 'c', 'd'].map((id, i) => peer(id, 0.2 * (i + 1)));
  const r = estimateOutlet(input({ peers }), 'بقالة');
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.eligiblePeers, 4);
    assert.match(r.why, /صنّف أنواع عملائك/);
  }
});

test('يختار أقرب حلقة فيها ٥ مشابهين، والأشهر الصفرية محتسبة', () => {
  const peers = ['a', 'b', 'c', 'd', 'e'].map((id, i) => peer(id, 0.1 * (i + 1)));
  peers.push(peer('far', 20));
  const monthly = [
    ...months('a', 'water', [6, 0, 6, 0, 6, 0]), // ١٨ على ٦ أشهر = ٣ شهرياً (لا ٦)
    ...months('b', 'water', [3, 3, 3, 3, 3, 3]),
    ...months('c', 'water', [3, 3, 3, 3, 3, 3]),
    ...months('d', 'water', [3, 3, 3, 3, 3, 3]),
    ...months('e', 'water', [3, 3, 3, 3, 3, 3]),
    ...months('far', 'water', [90, 90, 90, 90, 90, 90]),
  ];
  const r = estimateOutlet(input({ peers, monthly }), 'بقالة');
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.ringKm, 1);
  assert.equal(r.peers, 5, 'البعيد خارج الحلقة');
  const w = r.products.find(p => p.productId === 'water')!;
  assert.equal(w.buyers, 5);
  assert.equal(w.penetration, 1);
  assert.deepEqual(w.monthlyQty, { low: 3, median: 3, high: 3 });
  assert.match(r.why, /ضمن 1 كم/);
});

test('المرتجعات تُطرح من المجموع والاقتطاع للصفر على المجموع', () => {
  const peers = ['a', 'b', 'c', 'd', 'e'].map((id, i) => peer(id, 0.1 * (i + 1)));
  const monthly: PeerProductMonth[] = [
    ...months('a', 'water', [12, 0, 0, 0, 0, 0]),
    { customerId: 'a', productId: 'water', ym: '2026-05', qty: -6, value: -60 }, // مرتجع
    ...['b', 'c', 'd', 'e'].flatMap(id => months(id, 'water', [1, 1, 1, 1, 1, 1])),
    { customerId: 'b', productId: 'juice', ym: '2026-04', qty: -5, value: -50 }, // مرتجع بلا مبيعات ⇒ صفر لا سالب
  ];
  const r = estimateOutlet(input({ peers, monthly }), 'بقالة');
  assert.ok(r.ok);
  if (!r.ok) return;
  const w = r.products.find(p => p.productId === 'water')!;
  assert.deepEqual(w.monthlyQty, { low: 1, median: 1, high: 1 }, '(١٢−٦)/٦ = ١');
  assert.equal(r.products.find(p => p.productId === 'juice'), undefined, 'لا مشترين للعصير ⇒ لا سطر');
});

test('أقل من ٥ مشترين: الانتشار يظهر والكمية تُحجب (خصوصية)', () => {
  const peers = ['a', 'b', 'c', 'd', 'e', 'f'].map((id, i) => peer(id, 0.1 * (i + 1)));
  const monthly = [...months('a', 'juice', [2, 2, 2, 2, 2, 2]), ...months('b', 'juice', [4, 4, 4, 4, 4, 4])];
  const r = estimateOutlet(input({ peers, monthly }), 'بقالة');
  assert.ok(r.ok);
  if (!r.ok) return;
  const j = r.products.find(p => p.productId === 'juice')!;
  assert.equal(j.buyers, null, 'لا عدد مشترين للصنف المحجوب (حدّ الخصوصية)');
  assert.equal(j.penetration, null);
  assert.equal(j.monthlyQty, null);
  assert.equal(j.hidden, 'FEW_BUYERS');
  assert.equal(j.trialQty, null);
});

test('صنفٌ يهيمن عليه مشترٍ واحد (>٥٠٪) لا تُعرض كمّيته', () => {
  const peers = ['a', 'b', 'c', 'd', 'e'].map((id, i) => peer(id, 0.1 * (i + 1)));
  const monthly = [
    ...months('a', 'water', [100, 100, 100, 100, 100, 100]),
    ...['b', 'c', 'd', 'e'].flatMap(id => months(id, 'water', [1, 1, 1, 1, 1, 1])),
  ];
  const r = estimateOutlet(input({ peers, monthly }), 'بقالة');
  assert.ok(r.ok);
  if (!r.ok) return;
  const w = r.products.find(p => p.productId === 'water')!;
  assert.equal(w.hidden, 'DOMINANT');
  assert.equal(w.monthlyQty, null);
});

test('أهلية المشابه: النوع نفسه، ٣ أشهر فعلية، ونشاط خلال ٦٠ يوماً، واستبعاد المحل نفسه', () => {
  const peers = [
    ...['a', 'b', 'c', 'd'].map((id, i) => peer(id, 0.1 * (i + 1))),
    peer('new', 0.1, { firstYm: '2026-07' }),                                   // شهران فقط
    peer('idle', 0.1, { lastInvoiceAt: new Date('2026-06-01T00:00:00Z') }),     // خامل
    peer('pharm', 0.1, { outletType: 'PHARMACY' }),                             // نوع آخر
    peer('self', 0.1),                                                           // المحل نفسه
  ];
  const r = estimateOutlet(input({ peers, target: { ...input().target, excludeCustomerId: 'self' } }), 'بقالة');
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.eligiblePeers, 4);
});

test('أول طلب وطلب تجريبي: من الفواتير الأولى للمشابهين', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
  const peers = ids.map((id, i) => peer(id, 0.1 * (i + 1)));
  const monthly = ids.flatMap(id => months(id, 'water', [8, 8, 8, 8, 8, 8]));
  const firstOrders = ids.map(customerId => ({ customerId, productId: 'water', qty: 4 }));
  const r = estimateOutlet(input({ peers, monthly, firstOrders }), 'بقالة');
  assert.ok(r.ok);
  if (!r.ok) return;
  const w = r.products.find(p => p.productId === 'water')!;
  assert.equal(w.firstOrderQty, 4);
  assert.equal(w.trialQty, 4);
  assert.deepEqual(w.monthlyValue, { low: 80, median: 80, high: 80 });
  assert.deepEqual(r.monthlyTotalValue, { low: 80, median: 80, high: 80 });
});

test('إخفاء المال: لا قيمة مالية إطلاقاً', () => {
  const ids = ['a', 'b', 'c', 'd', 'e'];
  const peers = ids.map((id, i) => peer(id, 0.1 * (i + 1)));
  const monthly = ids.flatMap(id => months(id, 'water', [2, 2, 2, 2, 2, 2]));
  const r = estimateOutlet(input({ peers, monthly, showMoney: false }), 'بقالة');
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.monthlyTotalValue, null);
  assert.ok(r.products.every(p => p.monthlyValue === null));
});

test('المنتج ذو الأولوية يظهر أولاً ولو لم يشتره أحد', () => {
  const ids = ['a', 'b', 'c', 'd', 'e'];
  const peers = ids.map((id, i) => peer(id, 0.1 * (i + 1)));
  const monthly = ids.flatMap(id => months(id, 'water', [2, 2, 2, 2, 2, 2]));
  const products = [{ id: 'water', name: 'مياه', unit: 'كرتون' }, { id: 'newp', name: 'منتج جديد', unit: 'كرتون', priority: true }];
  const r = estimateOutlet(input({ peers, monthly, products }), 'بقالة');
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.products[0].productId, 'newp');
  assert.equal(r.products[0].buyers, 0);
});

test('الثقة: عالية بـ٨ مشابهين ضمن ٢ كم وأقدمية ٦ أشهر، ومنخفضة من كل مناطق الشركة', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const near = estimateOutlet(input({ peers: ids.map((id, i) => peer(id, 0.1 * (i + 1))), monthly: ids.flatMap(id => months(id, 'water', [2, 2, 2, 2, 2, 2])) }), 'بقالة');
  assert.ok(near.ok && near.confidence === 'HIGH');
  const far = estimateOutlet(input({ peers: ids.slice(0, 5).map((id, i) => peer(id, 40 + i)), monthly: ids.flatMap(id => months(id, 'water', [2, 2, 2, 2, 2, 2])) }), 'بقالة');
  assert.ok(far.ok);
  if (far.ok) { assert.equal(far.ringKm, null); assert.equal(far.confidence, 'LOW'); assert.match(far.why, /كل مناطق شركتك/); }
});

// ───────────── التصنيف ─────────────

test('اقتراح نوع المنفذ من الاسم: الأطول تطابقاً يفوز', () => {
  assert.equal(suggestOutletType('تموينات النور'), 'GROCERY');
  assert.equal(suggestOutletType('سوبر ماركت الريم'), 'SUPERMARKET');
  assert.equal(suggestOutletType('ميني ماركت الحي'), 'MINIMARKET');
  assert.equal(suggestOutletType(null, 'صيدلية الدواء'), 'PHARMACY');
  assert.equal(suggestOutletType('بقالة'), 'GROCERY');
  assert.equal(suggestOutletType('مؤسسة أحمد'), null);
});

test('نوع Google ← رمزنا مقيّداً بالمستهدف', () => {
  assert.equal(outletTypeFromGoogle('grocery_store', [], ['GROCERY']), 'GROCERY');
  assert.equal(outletTypeFromGoogle('gas_station', ['convenience_store', 'gas_station'], ['MINIMARKET']), 'MINIMARKET');
  assert.equal(outletTypeFromGoogle('pharmacy', [], ['GROCERY']), null);
  assert.deepEqual(googleTypesFor(['PHARMACY', 'PHARMACY']), ['pharmacy', 'drugstore']);
});

// ───────────── Google ─────────────

test('تحويل ردّ Google: يُسقط المغلق وما لا موقع له', () => {
  const out = parsePlaces([
    { id: 'p1', displayName: { text: 'بقالة الخير' }, location: { latitude: 24.7, longitude: 46.6 }, primaryType: 'grocery_store', types: ['grocery_store'], shortFormattedAddress: 'العليا' },
    { id: 'p2', displayName: { text: 'مغلق' }, location: { latitude: 24.7, longitude: 46.6 }, businessStatus: 'CLOSED_PERMANENTLY' },
    { id: 'p3', displayName: { text: 'بلا موقع' } },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'بقالة الخير');
  assert.equal(out[0].address, 'العليا');
});

test('البحث القريب: بلا مفتاح ⇒ غير مضبوط، ومفتاح مرفوض ⇒ PLACES_AUTH، والطلب بحقول Pro وترتيب المسافة', async () => {
  assert.equal((await searchNearby({ apiKey: null, lat: 1, lng: 1, radiusM: 1000, includedTypes: ['grocery_store'] })).ok, false);
  const denied = await searchNearby({ apiKey: 'k', lat: 1, lng: 1, radiusM: 1000, includedTypes: ['x'], fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({}) }) });
  assert.ok(!denied.ok && denied.code === 'PLACES_AUTH');
  let sent: { headers: Record<string, string>; body: string } | null = null;
  const ok = await searchNearby({
    apiKey: 'k', lat: 24.7, lng: 46.6, radiusM: 2000, includedTypes: ['grocery_store'],
    fetchImpl: async (_u, init) => { sent = init; return { ok: true, status: 200, json: async () => ({ places: [{ id: 'p', displayName: { text: 'س' }, location: { latitude: 24.7, longitude: 46.6 } }] }) }; },
  });
  assert.ok(ok.ok && ok.places.length === 1);
  assert.equal(sent!.headers['X-Goog-FieldMask'], PLACES_FIELD_MASK);
  const body = JSON.parse(sent!.body);
  assert.equal(body.rankPreference, 'DISTANCE');
  assert.equal(body.maxResultCount, 20);
  assert.equal(body.locationRestriction.circle.radius, 2000);
});

// ───────────── الدمج بسجلّ الشركة ─────────────

const P = (id: string, dLngM: number, primaryType = 'grocery_store') => ({ placeId: id, name: id, address: null, lat: BASE.lat, lng: BASE.lng + dLngM / 101000, primaryType, types: [primaryType] });

test('الدمج: عميل بمعرّف المكان، وعميل قريب ⇒ «ربما عميل»، والمغلق والمرفوض والنوع غير المستهدف', () => {
  const items = mergeNearby([P('new', 300), P('cust', 100), P('near', 500), P('closed', 50), P('rej', 20), P('pharm', 10, 'pharmacy')], {
    origin: BASE, targetTypes: ['GROCERY'], isolation: false, now: NOW,
    customers: [
      { id: 'c1', lat: null, lng: null, outletType: 'GROCERY', aiPlaceId: 'cust', visible: true },
      { id: 'c2', lat: BASE.lat, lng: BASE.lng + 520 / 101000, outletType: 'GROCERY', aiPlaceId: null, visible: true },
    ],
    outlets: [
      { placeId: 'closed', status: 'CLOSED', lastOutcome: 'CLOSED', lastOutcomeAt: NOW, convertedCustomerId: null },
      { placeId: 'rej', status: 'OPEN', lastOutcome: 'NOT_INTERESTED', lastOutcomeAt: new Date(NOW.getTime() - 5 * 86400000), convertedCustomerId: null },
    ],
  });
  assert.deepEqual(items.map(i => i.placeId), ['new', 'cust', 'near', 'rej']);
  assert.equal(items.find(i => i.placeId === 'cust')!.relation, 'CUSTOMER');
  assert.equal(items.find(i => i.placeId === 'cust')!.customerId, 'c1');
  assert.equal(items.find(i => i.placeId === 'near')!.relation, 'POSSIBLE_CUSTOMER');
  assert.equal(items.find(i => i.placeId === 'rej')!.rejectedRecently, true);
});

test('عزل العملاء: عميل الزميل غير المرئي لا يؤثّر في المخرجات إطلاقاً (لا إسقاط يكشف موقعه ولا وسم)', () => {
  const base = { origin: BASE, targetTypes: ['GROCERY'], now: NOW, outlets: [], customers: [{ id: 'other', lat: BASE.lat, lng: BASE.lng + 100 / 101000, outletType: 'GROCERY', aiPlaceId: 'x', visible: false }] };
  const iso = mergeNearby([P('x', 100), P('y', 100)], { ...base, isolation: true });
  assert.deepEqual(iso.map(i => [i.placeId, i.relation, i.customerId]), [['x', 'NEW', null], ['y', 'NEW', null]]);
  // محلٌّ حوّله زميل (في سجلّ الشركة) لا يُوسم «عميل» مع العزل
  const conv = mergeNearby([P('z', 50)], { ...base, customers: [], isolation: true, outlets: [{ placeId: 'z', status: 'CONVERTED', lastOutcome: 'CONVERTED', lastOutcomeAt: NOW, convertedCustomerId: 'other' }] });
  assert.equal(conv[0].relation, 'NEW');
  const open = mergeNearby([P('x', 100)], { ...base, isolation: false });
  assert.equal(open[0].relation, 'CUSTOMER');
  assert.equal(open[0].customerId, null, 'لا معرّف لعميل غير مرئي');
});

const HOUR = 3600000;
const mem = (placeId: string, lastOutcome: string, ago: number, status = 'OPEN') =>
  ({ placeId, status, lastOutcome, lastOutcomeAt: new Date(NOW.getTime() - ago), convertedCustomerId: null });
const merge = (places: ReturnType<typeof P>[], outlets: ReturnType<typeof mem>[], customers: Parameters<typeof mergeNearby>[1]['customers'] = [], extra: { keepHidden?: boolean } = {}) =>
  mergeNearby(places, { origin: BASE, targetTypes: ['GROCERY'], isolation: false, now: NOW, customers, outlets, ...extra });

test('الإخفاء بزمن: «مغلق الآن» بقية اليوم فقط، ثم يعود بآخر نتيجته (لا إلى الأبد)', () => {
  assert.ok(sameDay(new Date(NOW.getTime() - 2 * HOUR), NOW));
  assert.ok(!sameDay(new Date(NOW.getTime() - 24 * HOUR), NOW));
  // صباح اليوم ⇒ مخفي؛ أمس ⇒ ظاهر بلا وسم الإغلاق النهائي؛ والصفّ القديم (status CLOSED بنتيجة CLOSED) يُعامَل مؤقتاً
  const items = merge([P('today', 100), P('yday', 200), P('legacy', 300)], [
    mem('today', 'CLOSED', 2 * HOUR), mem('yday', 'CLOSED', 24 * HOUR), mem('legacy', 'CLOSED', 40 * 86400000, 'CLOSED'),
  ]);
  assert.deepEqual(items.map(i => i.placeId), ['yday', 'legacy']);
  assert.equal(items[0].lastOutcome, 'CLOSED');
  assert.equal(items[0].reportedClosed, false);
  assert.equal(items[0].relation, 'NEW');
});

test('«لم أجده»: البلاغ الواحد بقية اليوم ثم موسوماً آخر القائمة، والمؤكَّد CLOSED_MEMORY_DAYS ثم يعود موسوماً', () => {
  const D = 86400000;
  const items = merge([P('one-today', 50), P('one-old', 60), P('conf-recent', 70), P('conf-expired', 80), P('fresh', 400)], [
    mem('one-today', 'NOT_FOUND', HOUR), mem('one-old', 'NOT_FOUND', 3 * D),
    mem('conf-recent', 'NOT_FOUND', 10 * D, 'CLOSED'), mem('conf-expired', 'NOT_FOUND', (CLOSED_MEMORY_DAYS + 1) * D, 'CLOSED'),
  ]);
  assert.deepEqual(items.map(i => i.placeId), ['fresh', 'one-old', 'conf-expired'], 'المُبلَّغ عنه آخر القائمة كالمرفوض');
  assert.ok(items.filter(i => i.placeId !== 'fresh').every(i => i.reportedClosed));
  assert.equal(hiddenByMemory(mem('x', 'NOT_FOUND', 10 * D, 'CLOSED'), NOW), true);
  assert.equal(hiddenByMemory(mem('x', 'NOT_FOUND', 3 * D), NOW), false);
  assert.equal(hiddenByMemory(mem('x', 'INTERESTED', HOUR), NOW), false);
  // الدراسة بضغطة المندوب: المخفي يعود بذاكرته
  const kept = merge([P('conf-recent', 70)], [mem('conf-recent', 'NOT_FOUND', 10 * D, 'CLOSED')], [], { keepHidden: true });
  assert.equal(kept.length, 1);
  assert.equal(kept[0].reportedClosed, true);
});

test('العميل لا يُخفى أبداً: القائم بمعرّف المكان والمحتمل بالقرب يبقيان ولو أُبلغ عن إغلاقهما', () => {
  const items = merge([P('cust', 100), P('maybe', 300)], [mem('cust', 'NOT_FOUND', HOUR, 'CLOSED'), mem('maybe', 'CLOSED', HOUR)], [
    { id: 'c1', lat: null, lng: null, outletType: 'GROCERY', aiPlaceId: 'cust', visible: true },
    { id: 'c2', lat: BASE.lat, lng: BASE.lng + 310 / 101000, outletType: 'GROCERY', aiPlaceId: null, visible: true },
  ]);
  assert.deepEqual(items.map(i => [i.placeId, i.relation]), [['cust', 'CUSTOMER'], ['maybe', 'POSSIBLE_CUSTOMER']]);
  assert.ok(items.every(i => !i.reportedClosed), 'وسم الإغلاق للفرص وحدها');
});

test('المطابقة بالقرب واحداً لواحد: عميل واحد وسط صفّ محلات يُلصق بأقربها وحده، وكلٌّ بأقرب محل له', () => {
  // صفّ من أربعة محلات متلاصقة (كل ١٠ م) وعميل واحد عند الثالث
  const strip = [P('s1', 1000), P('s2', 1010), P('s3', 1020), P('s4', 1030)];
  const one = merge(strip, [], [{ id: 'c1', lat: BASE.lat, lng: BASE.lng + 1021 / 101000, outletType: null, aiPlaceId: null, visible: true }]);
  assert.deepEqual(one.filter(i => i.relation === 'POSSIBLE_CUSTOMER').map(i => [i.placeId, i.customerId]), [['s3', 'c1']]);
  assert.equal(one.filter(i => i.relation === 'NEW').length, 3, 'البقية فرص جديدة');
  // عميلان: كلٌّ يأخذ أقرب محل له — لا يسرق الأقربُ للجميع محلَّ غيره
  const two = merge(strip, [], [
    { id: 'a', lat: BASE.lat, lng: BASE.lng + 1002 / 101000, outletType: 'GROCERY', aiPlaceId: null, visible: true },
    { id: 'b', lat: BASE.lat, lng: BASE.lng + 1004 / 101000, outletType: 'GROCERY', aiPlaceId: null, visible: true },
  ]);
  const got = new Map(two.filter(i => i.customerId).map(i => [i.customerId, i.placeId]));
  assert.equal(got.get('a'), 's1');
  assert.equal(got.get('b'), 's2');
  // عميلٌ مطابقٌ صراحةً بمعرّف المكان لا يُلصق بمحلٍّ مجاور أيضاً
  const explicit = merge([P('mine', 1000), P('next', 1015)], [], [{ id: 'c9', lat: BASE.lat, lng: BASE.lng + 1012 / 101000, outletType: 'GROCERY', aiPlaceId: 'mine', visible: true }]);
  assert.deepEqual(explicit.map(i => [i.placeId, i.relation]), [['next', 'NEW'], ['mine', 'CUSTOMER']]);
});

test('صندوق العملاء يغطّي محلات الحافة (حتى ×١٫٢٥ من النطاق) لا دائرة نصف القطر', () => {
  // نطاق ٢٠٠٠ م: محلٌّ على بعد ٢٤٠٠ م وعميل ٣٠ م خلفه — كان خارج صندوق (النطاق + ٢٠٠) فيظهر «فرصة جديدة»
  const edge = { lat: BASE.lat, lng: BASE.lng + 2400 / 101000 };
  const cust = { lat: BASE.lat, lng: BASE.lng + 2430 / 101000 };
  const box = customerBox([{ lat: BASE.lat, lng: BASE.lng + 100 / 101000 }, edge])!;
  assert.ok(cust.lng <= box.maxLng && cust.lng >= box.minLng && cust.lat <= box.maxLat && cust.lat >= box.minLat);
  const oldReach = BASE.lng + (2000 + 200) / 111320 / Math.cos((BASE.lat * Math.PI) / 180);
  assert.ok(cust.lng > oldReach, 'الصندوق القديم كان يُسقطه');
  assert.equal(customerBox([]), null);
  const items = merge([P('edge', 2400)], [], [{ id: 'c1', ...cust, outletType: 'GROCERY', aiPlaceId: null, visible: true }]);
  assert.equal(items[0].relation, 'POSSIBLE_CUSTOMER');
});

// ───────────── الإعدادات ─────────────

test('الإعدادات: افتراضيات، وحدّ الخصوصية ٥ لا ينزل، والنطاق', () => {
  const d = settingsView(null);
  assert.deepEqual(d.targetOutletTypes, ['GROCERY', 'MINIMARKET', 'SUPERMARKET']);
  assert.equal(settingsView({ minPeers: 2 }).minPeers, 5);
  assert.equal(aiRepSettingsSchema.safeParse({ minPeers: 3 }).success, false);
  assert.equal(aiRepSettingsSchema.safeParse({ targetOutletTypes: ['NOPE'] }).success, false);
  assert.equal(aiRepSettingsSchema.safeParse({ targetOutletTypes: [] }).success, false);
  assert.equal(aiRepSettingsSchema.safeParse({ targetOutletTypes: ['GROCERY', 'MINIMARKET', 'SUPERMARKET', 'HYPERMARKET', 'WHOLESALE', 'PHARMACY', 'CAFE', 'CAFETERIA', 'RESTAURANT', 'BAKERY', 'FUEL_SHOP'] }).success, true, 'كل الأنواع الـ11 مسموحة');
  assert.equal(repInScope({ repScope: 'ALL', repIds: [] }, 'r1'), true);
  assert.equal(repInScope({ repScope: 'SELECTED', repIds: ['r2'] }, 'r1'), false);
});
