// المندوب الذكي — ذاكرة الجلسة: المسح الذي يخرج المندوب أثناءه لا يضيع ولا يتكرّر، والتحويل إلى عميل (متصلاً أو دون اتصال).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aiScanInFlight, clearAiSession, loadAiSession, markConverted, onConverted, saveAiSession, trackAiScan } from './aiRepSession';

const at = { lat: 24.7, lng: 46.7, accuracy: 12 };
const base = { repId: 'r1', searchId: 's0', origin: null };

function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const p = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { p, resolve, reject };
}

test('مسحٌ خرج المندوب أثناءه: نتيجته تُحفظ في الجلسة، والشاشة التي تُركَّب أثناءه تنتظره بدل مسحٍ ثانٍ', async () => {
  clearAiSession();
  saveAiSession({ ...base, items: [{ placeId: 'old', ref: 'P1' }], guide: null });
  const req = deferred<{ searchId: string; items: unknown[] }>();
  const run = trackAiScan('r1', req.p, d => ({ searchId: d.searchId, items: d.items, scanOrigin: at, scannedAt: 5 }));
  assert.equal(aiScanInFlight('r1'), run, 'الشاشة المركَّبة من جديد تجده');
  assert.equal(aiScanInFlight('r2'), null, 'لا يخصّ مندوباً آخر');
  req.resolve({ searchId: 's1', items: [{ placeId: 'new', ref: 'P1' }] });
  await run;
  const s = loadAiSession('r1')!;
  assert.equal(s.searchId, 's1');
  assert.deepEqual(s.items, [{ placeId: 'new', ref: 'P1' }]);
  assert.deepEqual(s.scanOrigin, at);
  assert.equal(s.scannedAt, 5);
  assert.equal(aiScanInFlight('r1'), null, 'انتهى ⇒ لا انتظار');
});

test('مسحٌ فشل: لا يمسّ الجلسة ولا يبقى معلّقاً', async () => {
  clearAiSession();
  saveAiSession({ ...base, items: [{ placeId: 'old', ref: 'P1' }], guide: null });
  const req = deferred<{ searchId: string }>();
  const run = trackAiScan('r1', req.p, d => ({ searchId: d.searchId }));
  req.reject(new Error('502'));
  await assert.rejects(run);
  assert.equal(loadAiSession('r1')!.searchId, 's0');
  assert.equal(aiScanInFlight('r1'), null);
});

test('تبديل المندوب أثناء المسح: نتيجته لا تُحيي جلسة المندوب السابق', async () => {
  clearAiSession();
  const req = deferred<{ searchId: string }>();
  const run = trackAiScan('r1', req.p, d => ({ searchId: d.searchId }));
  clearAiSession();
  assert.equal(aiScanInFlight('r1'), null);
  req.resolve({ searchId: 's9' });
  await run;
  assert.equal(loadAiSession('r1'), null);
});

test('التحويل إلى عميل: متصلاً ⇒ «عميل حالي» ويخرج من خطة التوجيه ولو كانت الشاشة مفكّكة؛ دون اتصال ⇒ «بانتظار المزامنة»', () => {
  clearAiSession();
  const guide = { source: 'RULES', summary: '', stops: [{ ref: 'P1', why: '' }, { ref: 'P2', why: '' }] };
  saveAiSession({ ...base, items: [{ placeId: 'a', ref: 'P1', relation: 'NEW' }, { placeId: 'b', ref: 'P2', relation: 'NEW' }], guide });
  const heard: [string, string | null][] = [];
  const off = onConverted((p, c) => heard.push([p, c]));
  markConverted('a', 'cust-1');
  markConverted('b', null);
  off();
  const s = loadAiSession('r1')!;
  const [a, b] = s.items as Record<string, unknown>[];
  assert.equal(a.relation, 'CUSTOMER');
  assert.equal(a.customerId, 'cust-1');
  assert.equal(b.relation, 'NEW', 'لم يُرفع بعد ⇒ ليس عميلاً في الخادم');
  assert.equal(b.pendingCustomer, true);
  assert.deepEqual((s.guide as typeof guide).stops, [], 'المحطتان خرجتا من الخطة');
  assert.deepEqual(heard, [['a', 'cust-1'], ['b', null]]);
});
