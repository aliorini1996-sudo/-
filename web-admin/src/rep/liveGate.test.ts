import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * «اشتراط تفعيل الموقع» — القفل الكامل (أمر المالك، ٦ أكتوبر ٢٠٢٦): المندوب المقيَّد لا يفعل شيئاً أبداً إلا وموقعه مفعّل ومحدَّد
 * بدقّة وهو متصل وظاهرٌ على الخريطة. الحكم الصرف لكل شرط، والفحص المسبق قبل كل إجراء (نقطةٌ طازجة)، والخطأ المصطنع الذي لا
 * يصير صفّاً دون اتصال، وتوافق القيم والاستثناءات مع الخادم، والترجمة.
 */

// مخزون وهميّ يحاكي localStorage قبل استيراد الوحدات
const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: () => null,
  length: 0,
} as Storage;

const L = await import('./liveGate');
const { pendingRetryOutcome, postResultOf } = await import('./visitPending');
const { PHRASES } = await import('../i18n/strings');
const { FS_CAPS, CAP_LIVELOC } = await import('../api/caps');

const read = (...p: string[]) => fs.readFileSync(path.resolve(process.cwd(), ...p), 'utf8').replace(/\r\n/g, '\n');
const NOW = Date.UTC(2026, 9, 6, 9, 0, 0);
const FIX = (o: Partial<import('./liveGate').LiveFix> = {}) => ({ lat: 24.7136, lng: 46.6753, accuracy: 15, at: NOW - 2_000, ...o });
const LIVE = (o: Partial<import('./liveGate').LiveSnapshot> = {}): import('./liveGate').LiveSnapshot => ({
  geoSupported: true, permission: 'granted', geoError: 0, fix: FIX(), online: true, serverOk: true,
  ping: { at: NOW - 3_000, ok: true, fixAt: NOW - 4_000 }, ...o,
});

beforeEach(() => { store.clear(); L.resetLive({ geoSupported: true, online: true }); });

// ───────── حكم الحاجز: كل شرطٍ وحده ─────────

test('القيم = الخادم: ٩٠ث و١٠٠م، ونقطة كل ٣٠ث، والفحص المسبق ≤ ١٠ث وإعادة النقطة ≤ ١٥ث', () => {
  assert.equal(L.LIVE_WINDOW_MS, 90_000);
  assert.equal(L.LIVE_MAX_ACCURACY_M, 100);
  assert.equal(L.LIVE_KEEPALIVE_MS, 30_000);
  assert.equal(L.PREFLIGHT_FIX_MAX_AGE_MS, 10_000);
  assert.equal(L.PING_REUSE_MS, 15_000);
  const server = read('..', 'backend', 'src', 'services', 'liveLocation.ts');
  assert.match(server, /export const LIVE_WINDOW_MS = 90_000;/);
  assert.match(server, /export const LIVE_MAX_ACCURACY_M = 100;/);
  assert.match(server, /export const LIVE_CAP = 'liveloc';/);
});

test('كل الشروط قائمة ⇒ يعمل', () => {
  assert.deepEqual(L.liveDecision(LIVE(), NOW), { ok: true });
});

test('١) الإذن والموقع: بلا دعم، أو آخر نتيجة «رفض/مطفأ» (ولو بعد قراءةٍ حديثة)، أو إذنٌ مرفوض بلا قراءةٍ صالحة ⇒ «الموقع مطفأ»', () => {
  for (const s of [
    LIVE({ geoSupported: false }), LIVE({ geoError: 1 }), LIVE({ geoError: 1, fix: null }),
    LIVE({ permission: 'denied', fix: null }), LIVE({ permission: 'denied', fix: FIX({ at: NOW - 600_000 }) }),
    LIVE({ permission: 'denied', fix: FIX({ accuracy: 1500 }) }),
  ]) {
    assert.deepEqual(L.liveDecision(s, NOW), { ok: false, block: 'off' });
  }
});

test('١ب) مناديب مفعّلون للموقع عالقون على «الموقع مطفأ»: القراءة الصالحة تعلو حالة الإذن المخبّأة «denied»', () => {
  // Permissions API قد تبقى «denied» بعد السماح (لا حدث change على بعض الأجهزة) — والقراءة دليلٌ قاطع أن الموقع يعمل
  assert.deepEqual(L.liveDecision(LIVE({ permission: 'denied' }), NOW), { ok: true });
  // والقراءة تمحو خطأ الرمز ١ — فنجاحها بعده يفتح
  L.resetLive({ geoSupported: true, online: true, serverOk: true, permission: 'denied', geoError: 1, ping: { at: NOW - 3_000, ok: true, fixAt: NOW - 4_000 } });
  L.noteFix(FIX());
  assert.deepEqual(L.liveDecision(L.liveSnapshot(), NOW), { ok: true });
  // وتبقى بقية الشروط كما هي: غائبٌ عن الخريطة يُحجب
  assert.deepEqual(L.liveDecision(LIVE({ permission: 'denied', ping: null }), NOW), { ok: false, block: 'notOnMap' });
});

test('٢) الاتصال: المتصفّح غير متصل، أو آخر ذهابٍ وإياب مع الخادم فشل ⇒ «لا يوجد اتصال بالإنترنت»', () => {
  assert.deepEqual(L.liveDecision(LIVE({ online: false }), NOW), { ok: false, block: 'offline' });
  assert.deepEqual(L.liveDecision(LIVE({ serverOk: false }), NOW), { ok: false, block: 'offline' }, 'navigator.onLine يكذب خلف شبكةٍ بلا إنترنت');
});

test('٣) القراءة الحيّة: لا قراءة، أو أقدم من ٩٠ث، أو دقّتها > ١٠٠م أو مجهولة، أو آخر نتيجة تعذّر/مهلة ⇒ «جارٍ تحديد موقعك بدقة…»', () => {
  const locating = { ok: false, block: 'locating' };
  assert.deepEqual(L.liveDecision(LIVE({ fix: null }), NOW), locating, 'لا قراءة بعد = جارٍ الفحص يحجب');
  assert.deepEqual(L.liveDecision(LIVE({ fix: FIX({ at: NOW - 90_001 }) }), NOW), locating, 'قراءةٌ مخبّأة قديمة');
  assert.deepEqual(L.liveDecision(LIVE({ fix: FIX({ at: NOW - 90_000 }) }), NOW), { ok: true }, 'الحدّ نفسه يُقبل');
  assert.deepEqual(L.liveDecision(LIVE({ fix: FIX({ accuracy: 101 }) }), NOW), locating, '«الموقع التقريبي»');
  assert.deepEqual(L.liveDecision(LIVE({ fix: FIX({ accuracy: 100 }) }), NOW), { ok: true });
  assert.deepEqual(L.liveDecision(LIVE({ fix: FIX({ accuracy: null }) }), NOW), locating);
  assert.deepEqual(L.liveDecision(LIVE({ fix: FIX({ lat: 0, lng: 0 }) }), NOW), locating, '(0،0) ليست مكاناً');
  assert.deepEqual(L.liveDecision(LIVE({ geoError: 3 }), NOW), locating, 'المهلة تحجب الآن (كانت لا تحجب أبداً)');
  assert.deepEqual(L.liveDecision(LIVE({ geoError: 2 }), NOW), locating, 'التعذّر يحجب من أول مرة (كان بعد ثلاث)');
});

test('٤) الظهور على الخريطة: لا نقطة مقبولة، أو ردّها الخادم، أو أقدم من ٩٠ث ⇒ «لم يظهر موقعك على الخريطة بعد»', () => {
  const notOnMap = { ok: false, block: 'notOnMap' };
  assert.deepEqual(L.liveDecision(LIVE({ ping: null }), NOW), notOnMap);
  assert.deepEqual(L.liveDecision(LIVE({ ping: { at: NOW - 1_000, ok: false, reason: 'INACCURATE' } }), NOW), notOnMap);
  assert.deepEqual(L.liveDecision(LIVE({ ping: { at: NOW - 90_001, ok: true } }), NOW), notOnMap);
});

test('الترتيب: ما يصلحه المندوب أولاً — الموقع ثم الاتصال ثم القراءة ثم الخريطة', () => {
  const all = LIVE({ geoError: 1, online: false, fix: null, ping: null });
  assert.equal((L.liveDecision(all, NOW) as { block: string }).block, 'off');
  assert.equal((L.liveDecision({ ...all, geoError: 0 }, NOW) as { block: string }).block, 'offline');
  assert.equal((L.liveDecision({ ...all, geoError: 0, online: true }, NOW) as { block: string }).block, 'locating');
  assert.equal((L.liveDecision({ ...all, geoError: 0, online: true, fix: FIX() }, NOW) as { block: string }).block, 'notOnMap');
});

// ───────── الفحص المسبق قبل كل إجراء ─────────

type Calls = { fresh: number; ping: { fix: import('./liveGate').LiveFix }[] };
function deps(o: { online?: boolean; now?: number; fresh?: import('./liveGate').FreshFixResult; ping?: import('./liveGate').PingResult } = {}) {
  const calls: Calls = { fresh: 0, ping: [] };
  const d: import('./liveGate').PreflightDeps = {
    now: () => o.now ?? NOW,
    online: () => o.online ?? true,
    freshFix: async () => { calls.fresh++; return o.fresh ?? { fix: FIX({ at: NOW - 500 }) }; },
    sendPing: async (fix) => { calls.ping.push({ fix }); return o.ping ?? { ok: true }; },
  };
  return { d, calls };
}

test('الفحص المسبق: بلا اتصال لا قراءة ولا نقطة ولا طلب — OFFLINE', async () => {
  const { d, calls } = deps({ online: false });
  assert.deepEqual(await L.preflightLive(d), { ok: false, reason: 'OFFLINE' });
  assert.equal(calls.fresh + calls.ping.length, 0);
  assert.equal(L.liveSnapshot().online, false, 'الحاجز يظهر بسببه');
});

test('الفحص المسبق: قراءة المراقبة الحديثة (≤ ١٠ث) تُرسل نقطةً ويُقبل الطلب، وحكم الخادم في المخزن', async () => {
  L.updateLive({ fix: FIX({ at: NOW - 9_000 }) });
  const { d, calls } = deps();
  const r = await L.preflightLive(d);
  assert.equal(r.ok, true);
  assert.equal(calls.fresh, 0, 'لا قراءة طازجة إن كانت الحاضرة حديثة');
  assert.equal(calls.ping.length, 1);
  assert.equal(calls.ping[0].fix.at, NOW - 9_000);
  assert.deepEqual(L.liveSnapshot().ping, { at: NOW, ok: true, reason: undefined, fixAt: NOW - 9_000 });
});

test('الفحص المسبق: قراءةٌ أقدم من ١٠ث (أطفأ الموقع للتوّ؟) ⇒ قراءة طازجة الآن — ورفضها يحجب بسببه', async () => {
  L.updateLive({ fix: FIX({ at: NOW - 11_000 }) });
  const ok = deps();
  assert.equal((await L.preflightLive(ok.d)).ok, true);
  assert.equal(ok.calls.fresh, 1);
  assert.equal(ok.calls.ping[0].fix.at, NOW - 500, 'النقطة بالقراءة الطازجة');

  for (const [error, reason, geo] of [[1, 'OFF', 1], [2, 'LOCATING', 2], [3, 'LOCATING', 3]] as const) {
    L.resetLive({ geoSupported: true, online: true, fix: FIX({ at: NOW - 60_000 }) });
    const { d, calls } = deps({ fresh: { error } });
    assert.deepEqual(await L.preflightLive(d), { ok: false, reason });
    assert.equal(calls.ping.length, 0, 'لا نقطة بلا قراءة');
    assert.equal(L.liveSnapshot().geoError, geo);
  }
  // طازجةٌ لكن تقريبية ⇒ لا نقطة ولا طلب
  L.resetLive({ geoSupported: true, online: true });
  const inacc = deps({ fresh: { fix: FIX({ at: NOW, accuracy: 1500 }) } });
  assert.deepEqual(await L.preflightLive(inacc.d), { ok: false, reason: 'LOCATING' });
  assert.equal(inacc.calls.ping.length, 0);
});

test('الفحص المسبق: حالة الإذن المخبّأة «denied» لا ترفض وحدها — القراءة الفعلية هي الحكم', async () => {
  L.updateLive({ permission: 'denied' });
  const ok = deps();
  assert.equal((await L.preflightLive(ok.d)).ok, true, 'الموقع يعمل فعلاً ⇒ يُقبل');
  assert.equal(ok.calls.fresh, 1, 'طُلبت قراءةٌ فعلية');
  L.resetLive({ geoSupported: true, online: true, permission: 'denied' });
  const off = deps({ fresh: { error: 1 } });
  assert.deepEqual(await L.preflightLive(off.d), { ok: false, reason: 'OFF' }, 'مرفوضٌ فعلاً ⇒ OFF');
  assert.equal(off.calls.ping.length, 0);
});

test('الفحص المسبق: خطأ الرمز ١ بعد القراءة (أطفأه للتوّ) ⇒ قراءةٌ طازجة إلزامية ولو كانت السابقة حديثة', async () => {
  L.updateLive({ fix: FIX({ at: NOW - 1_000 }), geoError: 1 });
  const off = deps({ fresh: { error: 1 } });
  assert.deepEqual(await L.preflightLive(off.d), { ok: false, reason: 'OFF' });
  assert.equal(off.calls.fresh, 1);
  assert.equal(off.calls.ping.length, 0, 'لا نقطة بقراءة ما قبل الإطفاء');
});

test('الفحص المسبق: نقطةٌ قبلها الخادم قبل < ١٥ث بقراءةٍ حديثة تكفي — لا نقطة لكل نقرة؛ وبعدها أو مرفوضةً تُرسل جديدة', async () => {
  L.updateLive({ fix: FIX({ at: NOW - 1_000 }), ping: { at: NOW - 14_000, ok: true, fixAt: NOW - 20_000 } });
  const reuse = deps();
  assert.equal((await L.preflightLive(reuse.d)).ok, true);
  assert.equal(reuse.calls.ping.length, 0);
  L.updateLive({ ping: { at: NOW - 16_000, ok: true, fixAt: NOW - 17_000 } });
  const stale = deps();
  await L.preflightLive(stale.d);
  assert.equal(stale.calls.ping.length, 1, 'أقدم من ١٥ث ⇒ نقطة جديدة');
  L.updateLive({ ping: { at: NOW - 2_000, ok: false, reason: 'STALE' } });
  const refused = deps();
  await L.preflightLive(refused.d);
  assert.equal(refused.calls.ping.length, 1, 'آخرها مرفوض ⇒ نقطة جديدة');
});

test('الفحص المسبق: انقطاع النقطة ⇒ OFFLINE وحالة الاتصال تسقط؛ وردّ الخادم «ليس حيّاً» ⇒ NOT_ON_MAP ولا طلب', async () => {
  L.updateLive({ fix: FIX() });
  const net = deps({ ping: 'network' });
  assert.deepEqual(await L.preflightLive(net.d), { ok: false, reason: 'OFFLINE' });
  assert.equal(L.liveSnapshot().serverOk, false);
  L.resetLive({ geoSupported: true, online: true, fix: FIX() });
  const no = deps({ ping: { ok: false, reason: 'INACCURATE' } });
  assert.deepEqual(await L.preflightLive(no.d), { ok: false, reason: 'NOT_ON_MAP' });
  assert.equal(L.liveSnapshot().serverOk, true);
  assert.deepEqual(L.liveSnapshot().ping, { at: NOW, ok: false, reason: 'INACCURATE', fixAt: NOW - 2_000 });
  assert.equal((L.liveDecision(L.liveSnapshot(), NOW) as { block: string }).block, 'notOnMap');
});

test('حكم الخادم من ردّ النقطة — وخادمٌ أقدم بلا حكم: ما خُزّن يُقبل، والمطفأ لا', () => {
  assert.deepEqual(L.pingVerdictOf({ data: { stored: 1, live: { ok: true } } }), { ok: true, reason: undefined });
  assert.deepEqual(L.pingVerdictOf({ data: { stored: 1, live: { ok: false, reason: 'STALE' } } }), { ok: false, reason: 'STALE' });
  assert.deepEqual(L.pingVerdictOf({ data: { stored: 1 } }), { ok: true, reason: undefined });
  assert.deepEqual(L.pingVerdictOf({ data: { stored: 0, disabled: true } }), { ok: false, reason: 'NOT_STORED' });
  assert.deepEqual(L.pingVerdictOf(null), { ok: false, reason: 'NOT_STORED' });
  const b = L.pingBody(FIX({ at: NOW }));
  assert.deepEqual(b, { points: [{ lat: 24.7136, lng: 46.6753, accuracy: 15, capturedAt: new Date(NOW).toISOString() }] });
});

// ───────── من يُحرس، والخطأ المصطنع ─────────

test('المقيَّد من rep_user بـ=== true فقط', () => {
  assert.equal(L.strictRepNow(), false);
  store.set('rep_user', JSON.stringify({ id: 'r1', requireLocationOn: true }));
  assert.equal(L.strictRepNow(), true);
  store.set('rep_user', JSON.stringify({ id: 'r1', requireLocationOn: 'true' }));
  assert.equal(L.strictRepNow(), false);
  store.set('rep_user', '{bad');
  assert.equal(L.strictRepNow(), false);
});

test('المحروس = الخادم: العمل على عميل وحده (فاتورة/مرتجع/سند/زيارة/عميل/رابط دفع) — والبصمة والتقرير والمندوب الذكي وغيرها تمرّ', () => {
  for (const [m, u] of [['post', '/invoices'], ['post', '/visits'], ['patch', '/invoices/1/cancel'], ['put', '/customers/1'], ['post', '/customers'],
    ['patch', '/customers/c1/buyer-data'], ['post', '/receipts'], ['post', '/paylink/issue'], ['POST', '/api/invoices?x=1'],
    ['post', 'https://x.y/api/visits/'], ['delete', '/customers/1']]) {
    assert.equal(L.isLiveGuardedRequest(m, u), true, `${m} ${u}`);
  }
  for (const [m, u] of [['get', '/invoices'], [undefined, '/customers'], ['get', '/customers/1/statement'], ['post', '/auth/login'],
    ['post', '/tracking/ping'], ['post', '/tracking/attendance/checkin'], ['post', '/tracking/attendance/checkout'], ['post', '/auth/change-password'],
    ['post', '/daily-reports'], ['post', '/van-stock/loads'], ['post', '/ai-rep/rep/outcomes'], ['patch', '/notifications/read-all'],
    ['post', '/invoicesx'], ['post', '/paylink/public/t/refresh']]) {
    assert.equal(L.isLiveGuardedRequest(m, u), false, `${m} ${u}`);
  }
  for (const k of ['customer', 'invoice', 'receipt', 'visit']) assert.equal(L.isLiveGuardedKind(k), true, k);
  for (const k of ['dailyReport', 'aiOutcome']) assert.equal(L.isLiveGuardedKind(k), false, k);
  const server = read('..', 'backend', 'src', 'services', 'liveLocation.ts');
  const list = (src: string) => (src.match(/LIVE_GUARDED_PREFIXES: readonly string\[\] = Object\.freeze\(\[([\s\S]*?)\]\)/)![1].match(/'[^']+'/g) || []);
  assert.deepEqual(list(read('src', 'rep', 'liveGate.ts')), list(server), 'قائمتا المحروس متطابقتان');
});

test('صفحة العميل: كل نافذةٍ من نوافذ العميل ومستندٌ فُتح منها — لا قائمة ولا مستندٌ من القوائم ولا شاشةٌ أخرى', () => {
  for (const modal of L.CUSTOMER_MODALS) assert.equal(L.customerScopeOpen({ modal, docOpen: false, docBack: null }), true, modal);
  assert.equal(L.customerScopeOpen({ modal: null, docOpen: true, docBack: 'customerDetail' }), true, 'كشف/مستند من صفحة العميل');
  assert.equal(L.customerScopeOpen({ modal: null, docOpen: true, docBack: null }), false, 'مستندٌ من قائمة الفواتير');
  assert.equal(L.customerScopeOpen({ modal: null, docOpen: false, docBack: null }), false);
  assert.equal(L.customerScopeOpen({ modal: null, docOpen: false, docBack: 'customerDetail' }), false);
  // كل نافذةٍ في تطبيق المندوب نافذة عميل — نافذةٌ جديدة لا تفلت من القيد سهواً
  const app = read('src', 'rep', 'RepApp.tsx');
  const members = [...app.match(/^type Modal = null \| ([^;]+);/m)![1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(members, [...L.CUSTOMER_MODALS].sort(), 'نوع Modal = نوافذ العميل');
});

test('الطلب المردود قبل إرساله يحمل response (فلا يعدّه isNetworkError انقطاعاً فيُصفّ) ويُعرف ردَّ قفل', () => {
  const e = L.liveRefusalError('OFFLINE', { url: '/invoices' });
  assert.ok(e.response, 'isNetworkError = !response');
  assert.equal(e.response.status, 409);
  assert.equal(e.response.data.code, 'LOCATION_REQUIRED');
  assert.equal(e.response.data.message, 'لا يوجد اتصال بالإنترنت — اتصل ثم أعد المحاولة');
  assert.equal(L.isLiveRefusal(e), true);
  assert.equal(L.isLocalLiveRefusal(e), true);
  // ردّ الخادم بسببه = قفل؛ وLOCATION_REQUIRED الزيارة بلا إحداثيات (بلا reason) ليس قفلاً — رفضٌ نهائيّ كما كان
  const server = { response: { status: 409, data: { code: 'LOCATION_REQUIRED', reason: 'STALE', message: 'م' } } };
  assert.equal(L.isLiveRefusal(server), true);
  assert.equal(L.isLocalLiveRefusal(server), false);
  assert.equal(L.isLiveRefusal({ response: { status: 409, data: { code: 'LOCATION_REQUIRED', message: 'بلا موقعك' } } }), false);
  assert.equal(L.isLiveRefusal(new Error('Network Error')), false);
});

test('زيارة المؤقّت المحفوظة: «لست حيّاً الآن» تنتظر ولا تسقط، و«بلا موقع» نهائيّ كما كان', () => {
  const r = postResultOf(L.liveRefusalError('NOT_ON_MAP'));
  assert.equal((r as { live?: boolean }).live, true);
  assert.equal(pendingRetryOutcome(r), 'keep');
  assert.equal(pendingRetryOutcome(postResultOf({ response: { status: 409, data: { code: 'LOCATION_REQUIRED', reason: 'NO_FIX' } } })), 'keep');
  assert.equal(pendingRetryOutcome(postResultOf({ response: { status: 409, data: { code: 'LOCATION_REQUIRED' } } })), 'failed');
});

test('مفتاح المحاولة: المحتوى نفسه ⇒ clientRef نفسه (ردٌّ ضاع لا يصير مستنداً ثانياً)، وتغيّره ⇒ مفتاحٌ جديد', () => {
  let n = 0;
  const fresh = () => `ref-${++n}`;
  const a = L.attemptClientRef(null, { amount: 50, customerId: 'c1' }, fresh);
  assert.equal(a.ref, 'ref-1');
  assert.equal(L.attemptClientRef(a, { amount: 50, customerId: 'c1' }, fresh).ref, 'ref-1');
  assert.equal(L.attemptClientRef(a, { amount: 60, customerId: 'c1' }, fresh).ref, 'ref-2');
});

// ───────── حرّاس ثابتون على التوصيل ─────────

test('حارس ثابت: عميل المندوب يفحص قبل كل طلبٍ على عميل، ويحوّل انقطاع المقيَّد فيه ردَّ قفل، ويُعلن liveloc', () => {
  const api = read('src', 'rep', 'repApi.ts');
  const req = api.slice(api.indexOf('repApi.interceptors.request.use('), api.indexOf('// عند انتهاء الجلسة (401)'));
  assert.match(req, /config\.headers\[DEVICE_NOW_HEADER\] = String\(Date\.now\(\)\);/);
  assert.match(req, /if \(token && strictRepNow\(\) && isLiveGuardedRequest\(config\.method, config\.url\)\) \{\s*const r = await ensureLive\(\);\s*if \(!r\.ok\) throw liveRefusalError\(r\.reason, config\);/);
  const res = api.slice(api.indexOf('repApi.interceptors.response.use('));
  assert.match(res, /if \(isLocalLiveRefusal\(err\)\) return Promise\.reject\(err\);/);
  assert.match(res, /if \(strictRepNow\(\) && isLiveGuardedRequest\(cfg\?\.method, cfg\?\.url\)\) return Promise\.reject\(liveRefusalError\('OFFLINE', cfg\)\);/);
  assert.doesNotMatch(api, /isLiveExemptRequest/);
  // النقطة نفسها طلبٌ مستثنى (لا حلقة) ولا يُخرج المندوب
  assert.match(api, /await repApi\.post\('\/tracking\/ping', pingBody\(fix\), \{ background: true \}\);/);
  assert.ok(FS_CAPS.includes(CAP_LIVELOC));
  assert.equal(CAP_LIVELOC, 'liveloc');
});

test('حارس ثابت: لا صفّ دون اتصال لعمل المقيَّد على عميل — في كل شاشة، وآخر سدٍّ في outboxAdd، والمصفوف من قبل يبقى ظاهراً لا يُعدم', () => {
  const app = read('src', 'rep', 'RepApp.tsx');
  const inv = app.slice(app.indexOf('function CreateInvoice('), app.indexOf('function CreateReceipt('));
  assert.ok(inv.indexOf('if (strictRepNow()) { setMsg(tr(LIVE_REFUSAL_MESSAGE.OFFLINE)); setLoading(false); return; }') < inv.indexOf("kind: 'invoice', payload"));
  const rcp = app.slice(app.indexOf('function CreateReceipt('), app.indexOf('function AddCustomer('));
  assert.match(rcp, /if \(offlineOnly && strictRepNow\(\)\) \{/);
  assert.match(rcp, /if \(isNetworkError\(err\) && !strictRepNow\(\)\) \{\s*await queueOffline\(\);/);
  const cust = app.slice(app.indexOf('function AddCustomer('));
  assert.match(cust, /if \(isNetworkError\(err\) && !strictRepNow\(\)\) \{\s*await outboxAdd\(/);
  for (const f of [inv, rcp, cust]) {
    assert.match(f, /attempt\.current = attemptClientRef\(attempt\.current, body, newClientRef\);\s*const clientRef = attempt\.current\.ref;/);
  }
  // نتيجة المندوب الذكي والتقرير اليومي ليسا عملاً على عميل: يُصفّان للمقيَّد كغيره (التراجع عن القفل الكامل)
  assert.match(read('src', 'rep', 'RepAiScreen.tsx'), /if \(isNetworkError\(e\) \|\| \(status != null && status >= 500\)\) \{/);
  assert.match(read('src', 'rep', 'RepDailyReport.tsx'), /if \(!status\) \{/);
  for (const f of ['RepAiScreen.tsx', 'RepDailyReport.tsx']) assert.doesNotMatch(read('src', 'rep', f), /strictRepNow/, f);
  assert.match(read('src', 'rep', 'offlineDb.ts'), /export async function outboxAdd\(doc: OutboxDoc\): Promise<void> \{[\s\S]*?if \(strictRepNow\(\) && isLiveGuardedKind\(doc\.kind\)\) throw liveRefusalError\('OFFLINE'\);/);
  // الصفّ: ردّ القفل يوقف المزامنة ويُبقي المستند مصفوفاً — قبل فرع رفض الأعمال (4xx) الذي يوسمه مرفوضاً
  const sync = read('src', 'rep', 'offlineSync.ts');
  const stop = sync.indexOf('if (isLiveRefusal(err) || code === LIVE_CLIENT_UPDATE_CODE) {');
  assert.ok(stop > 0 && stop < sync.indexOf('if (status && status >= 400 && status < 500) {'));
  assert.match(sync.slice(stop, stop + 700), /stopped = true;\s*liveBlocked = true;\s*continue;/);
  // ردّ القفل يحبس ما على عميل وحده — ما ليس على عميل بعده يُرفع
  assert.match(sync, /if \(liveBlocked && isLiveGuardedKind\(doc\.kind\)\) continue;/);
});

test('الترجمة: نصوص الحاجز والقفل بلغاتها الأربع', () => {
  const app = read('src', 'rep', 'RepApp.tsx');
  const gateTexts = [...app.slice(app.indexOf('const GATE_TEXT'), app.indexOf('function LocationOffGate(')).matchAll(/(?:title|body): '([^']+)'/g)].map(m => m[1]);
  assert.equal(gateTexts.length, 8);
  const keys = [
    ...gateTexts,
    ...Object.values(L.LIVE_REFUSAL_MESSAGE),
    'لا تدخل صفحة اي عميل حتى يكون موقعك مفعلا ومحددا بدقة وانت متصل وظاهر على الخريطة — وبقية التطبيق متاحة لك',
    'رجوع',
    'المندوب المقيد باشتراط تفعيل الموقع يرسل موقعه دائما ولو كان التتبع متوقفا فعل التتبع لتراه على الخريطة',
  ];
  for (const k of keys) {
    const e = PHRASES[k];
    assert.ok(e, `بلا ترجمة: ${k}`);
    for (const lang of ['en', 'fr', 'tr', 'zh'] as const) assert.ok(e[lang] && e[lang].trim(), `${k} بلا ${lang}`);
  }
});

test('حاجز «الموقع مطفأ»: «أعد المحاولة» تطلب الموقع داخل النقرة قبل أي انتظار، وخطوات التفعيل بحسب الجهاز مترجمة', () => {
  const app = read('src', 'rep', 'RepApp.tsx');
  assert.match(app, /const retry = async \(\) => \{ requestLocationInGesture\(\); setBusy\(true\);/);
  assert.match(app, /LOCATION_STEPS\[deviceKind\(\)\]/);
  const steps = [...app.matchAll(/^  (?:ios|android|other): '([^']+)',$/gm)].map((m) => m[1]);
  assert.equal(steps.length, 3);
  for (const ar of steps) {
    const p = (PHRASES as Record<string, Record<string, string>>)[ar];
    assert.ok(p, ar);
    for (const l of ['en', 'fr', 'tr', 'zh']) assert.ok(p[l], l + ': ' + ar);
  }
  assert.equal(L.deviceKind('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)'), 'ios');
  assert.equal(L.deviceKind('Mozilla/5.0 (Linux; Android 14; SM-A546E) Chrome/129'), 'android');
  assert.equal(L.deviceKind('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), 'other');
});

test('الزيارة المنتظرة: ردّ قفل الموقع يَسِمها «بانتظار تفعيل موقعك»، والانقطاع بعده يعيدها «بانتظار الاتصال»', async () => {
  const VP = await import('./visitPending');
  store.clear();
  localStorage.setItem('rep_user', JSON.stringify({ id: 'r1' }));
  VP.putPendingVisit({ clientRef: 'v1', repId: 'r1', customerName: 'ع', payload: { customerId: 'c1' }, endedAt: new Date(NOW).toISOString(), status: 'waiting' });
  const live = await VP.retryPendingVisits(async () => { throw L.liveRefusalError('OFF'); }, 'r1');
  assert.deepEqual(live, { done: 0, kept: 1, failed: 0 });
  assert.equal(VP.getPendingVisits()[0].waitFor, 'location');
  const net = await VP.retryPendingVisits(async () => { throw new Error('Network Error'); }, 'r1');
  assert.equal(net.kept, 1);
  assert.equal(VP.getPendingVisits()[0].waitFor, undefined, 'السبب يتبع آخر محاولة');
  assert.equal(VP.getPendingVisits()[0].status, 'waiting');
  const ok = await VP.retryPendingVisits(async () => undefined, 'r1');
  assert.equal(ok.done, 1);
  assert.equal(VP.getPendingVisits().length, 0);
});
