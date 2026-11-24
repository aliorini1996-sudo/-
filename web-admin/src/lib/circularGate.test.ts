import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  ACK_QUEUE_MAX, ACK_QUEUE_MAX_AGE_MS, CIRCULAR_ACK_QUEUE_KEY, CIRCULAR_ACK_TIMEOUT_MS, CIRCULAR_ARM_MS, CIRCULAR_FETCH_TIMEOUT_MS,
  CIRCULAR_MIN_GAP_MS, ackOutcome, circularGateSkipped, counterOf,
  enqueueAck, fetchDue, flushAckQueue, orderPending, ownAcks, parseAckQueue, pendingRowsOf, pruneAcks, readAckQueue, removeAcks,
  showCounter, statusOf, visiblePending, writeAckQueue, type AckEntry, type KeyStore, type PendingCircular,
} from './circularGate';

/**
 * «التعميمات» — بوّابة «تمت القراءة» (طرف المستهلك، طلب المالك ٢٣ نوفمبر ٢٠٢٦).
 * منطقها النقيّ (الترتيب والتنقية وحكم الإقرار وصفّ الإقرارات دون اتصال) وحرّاسٌ ثابتة على تركيبها في القواقع الثلاث.
 */

const SRC = path.join(process.cwd(), 'src');
const read = (p: string) => fs.readFileSync(path.join(SRC, p), 'utf8');

/** تخزينٌ في الذاكرة بواجهة localStorage */
function memStore(init: Record<string, string> = {}): KeyStore & { data: Record<string, string> } {
  const data: Record<string, string> = { ...init };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = v; },
    removeItem: (k) => { delete data[k]; },
  };
}
/** تخزينٌ محجوب (وضعٌ خاص): كل وصولٍ يرمي */
const throwingStore: KeyStore = {
  getItem: () => { throw new Error('blocked'); },
  setItem: () => { throw new Error('blocked'); },
  removeItem: () => { throw new Error('blocked'); },
};

const row = (id: string, createdAt: string, extra: Partial<PendingCircular> = {}): PendingCircular =>
  ({ id, title: `t-${id}`, body: `b-${id}`, createdAt, createdByName: null, ...extra });

// ─────────── المعلّق: التنقية والترتيب ───────────

test('pendingRowsOf: ما ليس مصفوفةً لا شيء — والصفوف الناقصة والمكرّرة تسقط', () => {
  assert.deepEqual(pendingRowsOf(null), []);
  assert.deepEqual(pendingRowsOf({ data: [] }), []);
  assert.deepEqual(pendingRowsOf('x'), []);
  const rows = pendingRowsOf([
    { id: 'a', title: 'قرار', body: 'نص', createdAt: '2026-11-20T08:00:00Z', createdByName: '  مدير المبيعات ' },
    { id: 'a', title: 'مكرّر', body: 'x', createdAt: '2026-11-01T08:00:00Z' },
    { id: '', title: 'بلا معرّف', body: 'x', createdAt: '2026-11-01T08:00:00Z' },
    { id: 'b', title: '  ', body: ' ', createdAt: '2026-11-01T08:00:00Z' },
    null, 5,
    { id: 'c', title: 'بلا نص', body: '', createdAt: '2026-11-10T08:00:00Z', createdByName: '' },
  ]);
  assert.deepEqual(rows.map((r) => r.id), ['c', 'a'], 'الأقدم أوّلاً، والمكرّر يُعرض مرّة');
  assert.equal(rows[1].createdByName, 'مدير المبيعات');
  assert.equal(rows[0].createdByName, null, 'اسمٌ فارغ = null فيُعرض «الإدارة»');
});

test('orderPending: الأقدم أوّلاً، والتعادل بالمعرّف، والتاريخ التالف آخِراً — بلا تعديل الأصل', () => {
  const src = [row('z', '2026-11-22T10:00:00Z'), row('bad', 'not-a-date'), row('b', '2026-11-21T10:00:00Z'), row('a', '2026-11-21T10:00:00Z')];
  const out = orderPending(src);
  assert.deepEqual(out.map((r) => r.id), ['a', 'b', 'z', 'bad']);
  assert.deepEqual(src.map((r) => r.id), ['z', 'bad', 'b', 'a'], 'الأصل كما هو');
});

test('visiblePending: ما أقرّ به الجهاز (أُرسل أو صُفّ) لا يُعيد نافذته', () => {
  const rows = [row('a', '2026-11-01T00:00:00Z'), row('b', '2026-11-02T00:00:00Z')];
  assert.deepEqual(visiblePending(rows, new Set(['a'])).map((r) => r.id), ['b']);
  assert.deepEqual(visiblePending(rows, new Set()).map((r) => r.id), ['a', 'b']);
});

test('العدّاد «١ من ٣»: الموضع والمجموع، ولا يظهر لتعميمٍ واحد', () => {
  assert.deepEqual(counterOf(0, 3), { index: 1, total: 3 });
  assert.deepEqual(counterOf(1, 2), { index: 2, total: 3 });
  assert.deepEqual(counterOf(2, 1), { index: 3, total: 3 });
  assert.equal(showCounter(counterOf(0, 1)), false);
  assert.equal(showCounter(counterOf(0, 2)), true);
  assert.equal(showCounter(counterOf(1, 1)), true, 'آخر الجولة «٢ من ٢»');
  assert.deepEqual(counterOf(-1, -2), { index: 0, total: 0 });
});

// ─────────── حكم الإقرار ───────────

test('ackOutcome: ٢xx نجاح، والرفض النهائي يُسقط، والانقطاع و401 و5xx يُعاد', () => {
  assert.equal(ackOutcome(200), 'done');
  assert.equal(ackOutcome(204), 'done');
  for (const s of [400, 403, 404, 409, 422]) assert.equal(ackOutcome(s), 'drop', String(s));
  for (const s of [null, undefined, 0, 401, 408, 429, 500, 502, 503]) assert.equal(ackOutcome(s as number | null | undefined), 'retry', String(s));
});

test('statusOf: رمز الحالة من خطأ axios، والانقطاع null', () => {
  assert.equal(statusOf({ response: { status: 404 } }), 404);
  assert.equal(statusOf(new Error('Network Error')), null);
  assert.equal(statusOf(null), null);
  assert.equal(statusOf({ response: { status: '500' } }), null);
});

// ─────────── صفّ الإقرارات دون اتصال ───────────

test('enqueueAck: بلا تكرار لصاحبه، والمعرّف نفسه لمندوبَين صفّان مستقلّان', () => {
  let q: AckEntry[] = [];
  q = enqueueAck(q, 'c1', 'repA', 1000);
  q = enqueueAck(q, 'c1', 'repA', 2000);
  assert.equal(q.length, 1, 'ضغطتان على التعميم نفسه = إقرارٌ واحد');
  assert.equal(q[0].at, 1000, 'يبقى الأقدم: لحظة القراءة الأولى');
  q = enqueueAck(q, 'c1', 'repB', 3000);
  assert.equal(q.length, 2);
  assert.deepEqual(ownAcks(q, 'repB').map((e) => e.id), ['c1']);
  assert.deepEqual(enqueueAck(q, '', 'repA', 1), q, 'بلا معرّف لا يُضاف');
  assert.deepEqual(enqueueAck(q, 'x', '', 1), q, 'بلا صاحب لا يُضاف');
});

test('pruneAcks: المتقادم يسقط، والسقف يُسقط الأقدم', () => {
  const now = 10 * ACK_QUEUE_MAX_AGE_MS;
  const q: AckEntry[] = [
    { id: 'old', uid: 'u', at: now - ACK_QUEUE_MAX_AGE_MS - 1 },
    { id: 'edge', uid: 'u', at: now - ACK_QUEUE_MAX_AGE_MS },
    { id: 'new', uid: 'u', at: now },
  ];
  assert.deepEqual(pruneAcks(q, now).map((e) => e.id), ['edge', 'new']);
  let big: AckEntry[] = [];
  for (let i = 0; i < ACK_QUEUE_MAX + 5; i++) big = enqueueAck(big, `c${i}`, 'u', now);
  assert.equal(big.length, ACK_QUEUE_MAX);
  assert.equal(big[0].id, 'c5', 'الأقدم خرج أوّلاً');
});

test('parseAckQueue: التالف صفٌّ فارغ، والناقص يسقط، والمكرّر مرّة', () => {
  assert.deepEqual(parseAckQueue(null), []);
  assert.deepEqual(parseAckQueue('{oops'), []);
  assert.deepEqual(parseAckQueue('{"a":1}'), []);
  const q = parseAckQueue(JSON.stringify([
    { id: 'a', uid: 'u', at: 5 }, { id: 'a', uid: 'u', at: 9 }, { id: 'b' }, { uid: 'u' }, null, { id: 'c', uid: 'u', at: 'x' },
  ]));
  assert.deepEqual(q, [{ id: 'a', uid: 'u', at: 5 }, { id: 'c', uid: 'u', at: 0 }]);
});

test('removeAcks: يُسقط المحسوم من صفّ صاحبه وحده — صفوف زميله على الجهاز كما هي', () => {
  const q: AckEntry[] = [{ id: 'a', uid: 'u1', at: 1 }, { id: 'a', uid: 'u2', at: 1 }, { id: 'b', uid: 'u1', at: 1 }];
  assert.deepEqual(removeAcks(q, 'u1', new Set(['a'])), [{ id: 'a', uid: 'u2', at: 1 }, { id: 'b', uid: 'u1', at: 1 }]);
});

test('القراءة والكتابة: التخزين المحجوب لا يرمي، والفارغ يمحو المفتاح', () => {
  assert.deepEqual(readAckQueue(throwingStore), []);
  assert.doesNotThrow(() => writeAckQueue([{ id: 'a', uid: 'u', at: 1 }], throwingStore));
  assert.deepEqual(readAckQueue(null), []);
  const s = memStore();
  writeAckQueue([{ id: 'a', uid: 'u', at: 1 }], s);
  assert.deepEqual(readAckQueue(s), [{ id: 'a', uid: 'u', at: 1 }]);
  writeAckQueue([], s);
  assert.equal(CIRCULAR_ACK_QUEUE_KEY in s.data, false);
});

test('flushAckQueue: يرفع صفّ صاحبه وحده بالتسلسل — الناجح والمرفوض نهائياً يخرجان، ويقف عند أوّل انقطاع', async () => {
  const now = 1_000_000;
  const s = memStore({
    [CIRCULAR_ACK_QUEUE_KEY]: JSON.stringify([
      { id: 'ok', uid: 'me', at: now - 3 }, { id: 'gone', uid: 'me', at: now - 2 }, { id: 'net', uid: 'me', at: now - 1 },
      { id: 'later', uid: 'me', at: now }, { id: 'ok', uid: 'other', at: now },
    ]),
  });
  const calls: string[] = [];
  const ack = async (id: string, readAt: number) => {
    calls.push(`${id}@${now - readAt}`);
    if (id === 'gone') throw { response: { status: 404 } };
    if (id === 'net') throw new Error('Network Error');
  };
  const settled = await flushAckQueue('me', ack, s, now);
  // كل إقرارٍ يُرفع بلحظة ضغطه (readAt = at) — فيُسجَّل بها ويُقبل ولو أُغلق التعميم قبل عودة الاتصال
  assert.deepEqual(calls, ['ok@3', 'gone@2', 'net@1'], 'بلحظة الضغط، ولا رفع لإقرار زميلٍ دخل قبله، ولا طلبات بعد الانقطاع');
  assert.deepEqual([...settled].sort(), ['gone', 'ok']);
  assert.deepEqual(readAckQueue(s).map((e) => `${e.uid}:${e.id}`), ['me:net', 'me:later', 'other:ok']);
});

test('flushAckQueue: ضغطةٌ أُضيفت أثناء الرفع لا تُمحى — والمتقادم لا يُرفع', async () => {
  const now = 5 * ACK_QUEUE_MAX_AGE_MS;
  const s = memStore({
    [CIRCULAR_ACK_QUEUE_KEY]: JSON.stringify([
      { id: 'stale', uid: 'me', at: now - ACK_QUEUE_MAX_AGE_MS - 10 }, { id: 'a', uid: 'me', at: now },
    ]),
  });
  const calls: string[] = [];
  const settled = await flushAckQueue('me', async (id) => {
    calls.push(id);
    // أثناء الرفع ضغط المندوب «تمت القراءة» على تعميمٍ آخر دون اتصال
    writeAckQueue(enqueueAck(readAckQueue(s), 'pressed', 'me', now), s);
  }, s, now);
  assert.deepEqual(calls, ['a']);
  assert.deepEqual([...settled], ['a']);
  assert.deepEqual(readAckQueue(s).map((e) => e.id), ['pressed']);
  assert.deepEqual([...(await flushAckQueue('', async () => {}, s, now))], [], 'بلا صاحب لا رفع');
});

// ─────────── الجلب والتخطّي ───────────

test('fetchDue: أوّل جلبٍ دائماً، ثم بفاصلٍ أدنى — وساعةٌ رجعت للوراء لا تُجمّد الجلب', () => {
  assert.equal(fetchDue(0, 5), true);
  assert.equal(fetchDue(1000, 1000 + CIRCULAR_MIN_GAP_MS - 1), false);
  assert.equal(fetchDue(1000, 1000 + CIRCULAR_MIN_GAP_MS), true);
  assert.equal(fetchDue(100_000, 50), true);
});

test('circularGateSkipped: مالك المنصة وموظفها و«دخول» أيّهما لا يُسألون — وموظف الشركة يُسأل', () => {
  assert.equal(circularGateSkipped({ role: 'ADMIN' }), false);
  assert.equal(circularGateSkipped({ role: 'MANAGER', impersonating: null, staffImpersonation: false, impersonationToken: false }), false);
  assert.equal(circularGateSkipped({}), false, 'المندوب (بلا دور في كائنه) يُسأل');
  assert.equal(circularGateSkipped({ role: 'SUPER_ADMIN' }), true);
  assert.equal(circularGateSkipped({ role: 'PLATFORM_STAFF' }), true);
  assert.equal(circularGateSkipped({ role: 'ADMIN', impersonating: 'شركة س' }), true);
  assert.equal(circularGateSkipped({ role: 'ADMIN', staffImpersonation: true }), true);
  assert.equal(circularGateSkipped({ role: 'ADMIN', impersonationToken: true }), true);
});

// ─────────── حرّاسٌ ثابتة على المكوّن وتركيبه ───────────

test('المكوّن: نافذة حوار لا تُغلق بالخلفية ولا بـEscape، والتركيز على نصّ التعميم لا على «تمت القراءة»', () => {
  const g = read('components/circulars/CircularGate.tsx');
  assert.match(g, /role="dialog"/);
  assert.match(g, /aria-modal="true"/);
  assert.match(g, /aria-labelledby=\{titleId\}/);
  assert.doesNotMatch(g, /backdropClose/, 'لا إغلاق بالنقر على الخلفية');
  // الغلاف الخارجيّ (الخلفية) بلا onClick: الزرّ وحده يحمل onClick
  assert.equal((g.match(/onClick=/g) ?? []).length, 1, 'onClick واحد — زرّ «تمت القراءة»');
  assert.match(g, /if \(e\.key === 'Escape'\) \{ e\.preventDefault\(\); e\.stopPropagation\(\); return; \}/);
  // التركيز الأوّل على النصّ (tabIndex=0، داخل دورة Tab): Enter الختاميّ لقارئ الليزر أو مسافةٌ كُتبت باللمس لا تضغط الزرّ فتُسجَّل
  // قراءةٌ لم تقع — والزرّ لا يأخذ التركيز برمجياً أبداً (Tab أو اللمس وحدهما)
  assert.match(g, /bodyRef\.current\?\.focus\(\{ preventScroll: true \}\);/);
  assert.doesNotMatch(g, /btnRef\.current\?\.focus\(/);
  assert.match(g, /ref=\{bodyRef\}[^>]*?tabIndex=\{0\}/s);
  assert.ok(CIRCULAR_ARM_MS >= 500, 'والتسليح باقٍ للمسة');
  // الناشر مترجمٌ كقائمة الإدارة: «الدعم الفني» لا يظهر بالعربية لموظفٍ بلغةٍ أخرى
  assert.match(g, /const issuer = cur\.createdByName \? tr\(cur\.createdByName\) : tr\('الإدارة'\);/);
  // الصفّ بلحظة الضغط (قبل الطلب)، ويُرفع بها؛ والجهاز المعلن انقطاعه يُصفّ بلا انتظار
  assert.match(g, /const pressedAt = Date\.now\(\);[^]*?await fns\.current\.ack\(cur\.id\)/);
  assert.match(g, /enqueueAck\(readAckQueue\(\), cur\.id, userId, pressedAt\)/);
  assert.match(g, /flushAckQueue\(userId, \(id, readAt\) => fns\.current\.ack\(id, readAt\)\)/);
  assert.match(g, /if \(offlineQueue && typeof navigator !== 'undefined' && navigator\.onLine === false\) \{\s*(\/\/[^\n]*\n\s*)?outcome = 'retry';/);
  assert.match(g, /whitespace-pre-wrap/);
  assert.match(g, /overflow-y-auto/);
  assert.match(g, /formatDateTime\(cur\.createdAt\)/);
  assert.match(g, /tr\('تمت القراءة'\)/);
  assert.match(g, /tr\('تعميم إداري'\)/);
  assert.match(g, /tr\('\{i\} من \{n\}'\)/);
  assert.match(g, /dir="rtl"/);
  // قارئ الليزر لا يكتب في سلّة فاتورةٍ تحت النافذة
  assert.match(g, /data-laser-ignore=""/);
  // وحقل الليزر في فاتورة المندوب لا ينتزع التركيز من داخلها (وإلا بلغ المسحُ الفاتورة من تحت النافذة)
  const laser = read('rep/LaserScanField.tsx');
  assert.match(laser, /if \(a\?\.closest\?\.\('\[data-laser-ignore\]'\)\) return;\s*el\.focus/);
  // الصفّ لتطبيق المندوب وحده، والإقرار المتعذّر في اللوحة رسالةٌ لا تقدّم صامت
  assert.match(g, /if \(outcome === 'retry' && offlineQueue && userId\)/);
});

test('التركيب: البوّابة في القواقع الثلاث — بعد الدخول وحده، وبعميل كلٍّ منها، وبلا جلسة دخول المالك', () => {
  const main = read('layouts/MainLayout.tsx');
  assert.match(main, /import CircularGate from '\.\.\/components\/circulars\/CircularGate';/);
  assert.match(main, /<CircularGate [^>]*enabled=\{circularsOn\}/);
  assert.match(main, /circularGateSkipped\(\{\s*role: user\.role, impersonating, staffImpersonation: isStaffImpersonationClient\(\), impersonationToken: isImpersonationToken\(token\)/);
  // بمهلة: عميل اللوحة بلا مهلة، وإقرارٌ معلّق كان يُبقي النافذة على «جار الحفظ»
  assert.match(main, /api\.get\('\/circulars\/pending', \{ timeout: CIRCULAR_FETCH_TIMEOUT_MS \}\)/);
  assert.match(main, /api\.post\(`\/circulars\/\$\{encodeURIComponent\(id\)\}\/ack`, undefined, \{ timeout: CIRCULAR_ACK_TIMEOUT_MS \}\)/);
  // آخر القوقعة: بعد نافذتَي كلمة المرور والدعم
  assert.ok(main.indexOf('<CircularGate') > main.indexOf('<SupportModal'), 'البوّابة آخر القوقعة');

  const m = read('m/MobileApp.tsx');
  assert.match(m, /import CircularGate from '\.\.\/components\/circulars\/CircularGate';/);
  const loginReturn = m.indexOf('if (!token || !user) {');
  assert.ok(loginReturn > 0 && m.indexOf('<CircularGate') > loginReturn, '/m: بعد شاشة الدخول وحدها');
  assert.match(m, /<CircularGate key=\{user\.id\} userId=\{user\.id\} contained zClass="z-\[1350\]"/);
  assert.match(m, /impersonationToken: isImpersonationToken\(token\)/);
  assert.match(m, /api\.get\('\/circulars\/pending', \{ timeout: CIRCULAR_FETCH_TIMEOUT_MS \}\)/);
  assert.match(m, /api\.post\(`\/circulars\/\$\{encodeURIComponent\(id\)\}\/ack`, undefined, \{ timeout: CIRCULAR_ACK_TIMEOUT_MS \}\)/);

  const rep = read('rep/RepApp.tsx');
  assert.match(rep, /import CircularGate from '\.\.\/components\/circulars\/CircularGate';/);
  assert.match(rep, /\{token && user && \(\s*<CircularGate key=\{user\.id\} userId=\{user\.id\} offlineQueue contained zClass="z-\[1350\]"/);
  // بمهلة (repApi بلا مهلة: شبكةٌ لا يمرّ فيها شيء كانت تحجب التطبيق خلف النافذة)، والإقرار من الصفّ بلحظة ضغطه
  assert.match(rep, /repApi\.get\('\/circulars\/pending', \{ background: true, timeout: CIRCULAR_FETCH_TIMEOUT_MS \}\)/);
  assert.match(rep, /const ackMyCircular = \(id: string, readAt\?: number\) =>\s*repApi\.post\(`\/circulars\/\$\{encodeURIComponent\(id\)\}\/ack`, readAt \? \{ readAt \} : \{\}, \{ background: true, timeout: CIRCULAR_ACK_TIMEOUT_MS \}\)/);
  // المهلتان أقصر من أن يُظنّ التطبيق معلّقاً، وأطول من شبكةٍ بطيئة
  assert.ok(CIRCULAR_FETCH_TIMEOUT_MS >= 5_000 && CIRCULAR_FETCH_TIMEOUT_MS <= 15_000);
  assert.ok(CIRCULAR_ACK_TIMEOUT_MS >= 5_000 && CIRCULAR_ACK_TIMEOUT_MS <= 15_000);
  // خارج غلاف حاجز الموقع الخامل (inert) — وإلا تجمّدت النافذة تحت الحاجز
  const gateAt = rep.indexOf('<CircularGate');
  const underAt = rep.indexOf('<div ref={underGateRef} className="contents">');
  assert.ok(gateAt > 0 && underAt > gateAt, 'البوّابة قبل غلاف الحاجز لا داخله');
});

test('الطبقات: فوق حاجز الموقع وتحت «أثبت تواجدك» في تطبيق المندوب، وفوق كل نافذة في اللوحة', () => {
  const z = (cls: string) => Number(/z-\[(\d+)\]/.exec(cls)?.[1] ?? NaN);
  const rep = read('rep/RepApp.tsx');
  const presence = read('rep/PresenceCheck.tsx');
  const repZ = z(/<CircularGate[^>]*zClass="(z-\[\d+\])"/.exec(rep)?.[1] ?? '');
  assert.ok(repZ > z(/LocationOffGate[^]*?className="absolute inset-0 (z-\[\d+\])/.exec(rep)?.[1] ?? ''), 'فوق حاجز الموقع');
  assert.ok(repZ < z(/className="fixed inset-0 (z-\[\d+\])/.exec(presence)?.[1] ?? ''), 'تحت «أثبت تواجدك» — طلبٌ بمهلة');
  // اللوحة: الافتراضيّ فوق أعلى نافذةٍ فيها (SupportModal z-[2000]/z-[2001])
  const g = read('components/circulars/CircularGate.tsx');
  const defZ = z(/zClass = '(z-\[\d+\])'/.exec(g)?.[1] ?? '');
  assert.ok(defZ > 2001, `الافتراضيّ ${defZ} فوق نوافذ اللوحة`);
});
