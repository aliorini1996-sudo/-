import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeRef, captureRefFromUrl, readRef, clearRef, refFromSearch, isRefWithinWindow,
  REF_KEY, REF_CLICK_KEY, REF_RETENTION_DAYS, __resetReferralMemoryForTests,
} from './referral';

/**
 * ملتقط الإحالة — عمولة سفيرٍ تتوقّف على هذا الملف، فيُختبر بتخزينٍ مزيّف على
 * globalThis (لا DOM في node) وبـfetch مزيّف يُحصي النقرات.
 */

class FakeStorage implements Storage {
  private m = new Map<string, string>();
  get length() { return this.m.size; }
  clear() { this.m.clear(); }
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  removeItem(k: string) { this.m.delete(k); }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
}

/** تخزينٌ يرمي في كل عملية — كمتصفّحٍ يحجب بيانات المواقع */
const throwing = new Proxy({}, { get() { throw new Error('storage blocked'); } }) as Storage;

type Call = { url: string; init: RequestInit };
let calls: Call[] = [];
const saved: Record<string, PropertyDescriptor | undefined> = {};

function setGlobal(name: string, value: unknown) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

beforeEach(() => {
  for (const k of ['localStorage', 'sessionStorage', 'fetch']) saved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
  setGlobal('localStorage', new FakeStorage());
  setGlobal('sessionStorage', new FakeStorage());
  calls = [];
  setGlobal('fetch', (url: string, init: RequestInit) => { calls.push({ url, init }); return Promise.resolve(new Response(null, { status: 204 })); });
  __resetReferralMemoryForTests();
});

afterEach(() => {
  for (const k of ['localStorage', 'sessionStorage', 'fetch']) {
    const d = saved[k];
    if (d) Object.defineProperty(globalThis, k, d);
    else delete (globalThis as Record<string, unknown>)[k];
  }
});

const DAY = 86_400_000;

test('جدول التطبيع يطابق parseRef في الخادم', () => {
  const table: Array<[unknown, string | null]> = [
    ['ABCD2345', 'ABCD2345'],
    ['abcd2345', 'ABCD2345'],
    [' abcd-2345 ', 'ABCD2345'],
    ['AB.CD_23 45', 'ABCD2345'],
    ['ＡＢＣＤ２３４５', 'ABCD2345'],          // أحرف عريضة ⇒ NFKC
    ['ABCD234', null],                         // سبعة أحرف
    ['ABCD23456', null],                       // تسعة
    ['ABCD0345', null],                        // 0 خارج الأبجدية
    ['ABCDO345', null],                        // O خارج الأبجدية — لا تصحيح تخمينيّ
    ['ABCD1345', null],                        // 1
    ['ABCDI345', null],                        // I
    ['ABCDL345', null],                        // L
    ['ABCD234٥', null],                        // رقم عربي ليس من الأبجدية
    ['', null],
    [null, null],
    [undefined, null],
    [12345678, null],
    [{}, null],
  ];
  for (const [input, want] of table) {
    assert.equal(normalizeRef(input), want, `normalizeRef(${JSON.stringify(input)})`);
  }
});

test('refFromSearch قراءة نقيّة — لا تخزين ولا شبكة', () => {
  assert.equal(refFromSearch('?ref=abcd-2345&utm_source=x'), 'ABCD2345');
  assert.equal(refFromSearch('?ref=bad'), null);
  assert.equal(refFromSearch(''), null);
  assert.equal(localStorage.getItem(REF_KEY), null);
  assert.equal(calls.length, 0);
});

test('رمز صالح يُحفظ بصيغة العقد ويُقرأ', () => {
  const before = Date.now();
  assert.equal(captureRefFromUrl('?ref=abcd-2345'), 'ABCD2345');
  const stored = JSON.parse(localStorage.getItem(REF_KEY)!);
  assert.equal(stored.code, 'ABCD2345');
  assert.equal(stored.via, 'link');
  assert.ok(typeof stored.at === 'number' && stored.at >= before && stored.at <= Date.now());
  const read = readRef();
  assert.equal(read?.code, 'ABCD2345');
  assert.equal(read?.via, 'link');
  assert.equal(read?.at, stored.at, 'readRef يُعيد لحظة الالتقاط لتُرسل refAt');
});

test('رمز غير صالح يُهمَل ولا يمسّ الرمز المحفوظ', () => {
  captureRefFromUrl('?ref=ABCD2345');
  assert.equal(captureRefFromUrl('?ref=bad'), null);
  assert.equal(captureRefFromUrl('?utm_source=x'), null);
  assert.equal(captureRefFromUrl(''), null);
  assert.equal(readRef()?.code, 'ABCD2345');
  assert.equal(calls.length, 1, 'الرمز الخاطئ لا يُرسل نقرة');
});

test('آخر نقرة تكسب', () => {
  captureRefFromUrl('?ref=ABCD2345');
  captureRefFromUrl('?ref=WXYZ6789');
  assert.equal(readRef()?.code, 'WXYZ6789');
  captureRefFromUrl('?ref=ABCD2345');
  assert.equal(readRef()?.code, 'ABCD2345');
});

test('النقرة تُرسل مرّة واحدة لكل رمز في الجلسة', () => {
  captureRefFromUrl('?ref=ABCD2345');
  captureRefFromUrl('?ref=ABCD2345');
  captureRefFromUrl('?ref=abcd2345');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/api\/affiliate\/click$/);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.keepalive, true);
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { code: 'ABCD2345' });
  assert.deepEqual(JSON.parse(sessionStorage.getItem(REF_CLICK_KEY)!), ['ABCD2345']);

  captureRefFromUrl('?ref=WXYZ6789');
  assert.equal(calls.length, 2, 'رمزٌ آخر في الجلسة نفسها نقرةٌ مستقلّة');
});

test('جلسة جديدة (sessionStorage فارغ وذاكرة جديدة) تعدّ النقرة من جديد', () => {
  captureRefFromUrl('?ref=ABCD2345');
  setGlobal('sessionStorage', new FakeStorage());
  __resetReferralMemoryForTests();
  captureRefFromUrl('?ref=ABCD2345');
  assert.equal(calls.length, 2);
});

test('الاحتفاظ الافتراضي 365 يوماً — لا يُحذف رمزٌ ما زالت نافذة المالك القصوى تسمح به', () => {
  assert.equal(REF_RETENTION_DAYS, 365);
  localStorage.setItem(REF_KEY, JSON.stringify({ code: 'ABCD2345', at: Date.now() - 200 * DAY, via: 'link' }));
  assert.equal(readRef()?.code, 'ABCD2345', 'عمره 200 يوم — كان يُحذف بسقف 90 القديم');
  localStorage.setItem(REF_KEY, JSON.stringify({ code: 'ABCD2345', at: Date.now() - 364 * DAY, via: 'link' }));
  assert.equal(readRef()?.code, 'ABCD2345');
  localStorage.setItem(REF_KEY, JSON.stringify({ code: 'ABCD2345', at: Date.now() - 366 * DAY, via: 'link' }));
  assert.equal(readRef(), null);
  assert.equal(localStorage.getItem(REF_KEY), null);
});

test('isRefWithinWindow: مقارنة لحظة الالتقاط بنافذة الخادم', () => {
  const now = Date.parse('2026-09-13T12:00:00Z');
  assert.equal(isRefWithinWindow(now - 29 * DAY, 30, now), true);
  assert.equal(isRefWithinWindow(now - 30 * DAY, 30, now), true, 'الحدّ نفسه داخل النافذة');
  assert.equal(isRefWithinWindow(now - 30 * DAY - 1, 30, now), false);
  assert.equal(isRefWithinWindow(now, 1, now), true);
  assert.equal(isRefWithinWindow(NaN, 30, now), false);
  assert.equal(isRefWithinWindow(now - 400 * DAY, NaN, now), true, 'نافذة غير معروفة ⇒ الخادم يحكم');
  assert.equal(isRefWithinWindow(now - 400 * DAY, 0, now), true);
});

test('نافذة الإسناد: داخلها يُقرأ، وبعدها يُحذف', () => {
  localStorage.setItem(REF_KEY, JSON.stringify({ code: 'ABCD2345', at: Date.now() - 89 * DAY, via: 'link' }));
  assert.equal(readRef(90)?.code, 'ABCD2345');

  localStorage.setItem(REF_KEY, JSON.stringify({ code: 'ABCD2345', at: Date.now() - 91 * DAY, via: 'link' }));
  assert.equal(readRef(90), null);
  assert.equal(localStorage.getItem(REF_KEY), null, 'المنتهي يُحذف');

  localStorage.setItem(REF_KEY, JSON.stringify({ code: 'ABCD2345', at: Date.now() - 10 * DAY, via: 'link' }));
  assert.equal(readRef(7), null, 'النافذة المُمرَّرة تُحترم');
});

test('قيم تالفة تُحذف وتُعيد null', () => {
  const garbage = [
    '{not json',
    '"ABCD2345"',
    'null',
    '[]',
    JSON.stringify({ code: 'bad', at: Date.now(), via: 'link' }),
    JSON.stringify({ code: 'abcd2345', at: Date.now(), via: 'link' }),     // غير مُطبَّع
    JSON.stringify({ code: 'ABCD2345', via: 'link' }),                     // بلا لحظة
    JSON.stringify({ code: 'ABCD2345', at: 'yesterday', via: 'link' }),
    JSON.stringify({ code: 'ABCD2345', at: Date.now() + 30 * DAY }),       // في المستقبل
  ];
  for (const g of garbage) {
    localStorage.setItem(REF_KEY, g);
    assert.equal(readRef(), null, `يجب رفض ${g}`);
    assert.equal(localStorage.getItem(REF_KEY), null, `يجب حذف ${g}`);
  }
});

test('via غير معروف يُقرأ link، وtyped يُحترم', () => {
  const at = Date.now();
  localStorage.setItem(REF_KEY, JSON.stringify({ code: 'ABCD2345', at, via: 'weird' }));
  assert.deepEqual(readRef(), { code: 'ABCD2345', via: 'link', at });
  localStorage.setItem(REF_KEY, JSON.stringify({ code: 'ABCD2345', at, via: 'typed' }));
  assert.deepEqual(readRef(), { code: 'ABCD2345', via: 'typed', at });
});

test('clearRef يحذف الرمز', () => {
  captureRefFromUrl('?ref=ABCD2345');
  clearRef();
  assert.equal(readRef(), null);
});

test('تخزين يرمي لا يُسقط شيئاً — والنقرة تُعدّ مرّة بحارس الذاكرة', () => {
  setGlobal('localStorage', throwing);
  setGlobal('sessionStorage', throwing);
  assert.doesNotThrow(() => captureRefFromUrl('?ref=ABCD2345'));
  assert.doesNotThrow(() => captureRefFromUrl('?ref=ABCD2345'));
  assert.equal(calls.length, 1);
  assert.equal(readRef(), null);
  assert.doesNotThrow(() => clearRef());
});

test('غياب التخزين وfetch كلياً لا يُسقط شيئاً', () => {
  delete (globalThis as Record<string, unknown>).localStorage;
  delete (globalThis as Record<string, unknown>).sessionStorage;
  delete (globalThis as Record<string, unknown>).fetch;
  assert.doesNotThrow(() => captureRefFromUrl('?ref=ABCD2345'));
  assert.equal(readRef(), null);
});

test('fetch يرمي أو يرفض — يُبتلع', async () => {
  setGlobal('fetch', () => { throw new Error('offline'); });
  assert.doesNotThrow(() => captureRefFromUrl('?ref=ABCD2345'));
  setGlobal('fetch', () => Promise.reject(new Error('offline')));
  __resetReferralMemoryForTests();
  setGlobal('sessionStorage', new FakeStorage());
  assert.doesNotThrow(() => captureRefFromUrl('?ref=WXYZ6789'));
  await new Promise((r) => setTimeout(r, 5)); // لا رفض غير مُعالَج
  assert.equal(readRef()?.code, 'WXYZ6789');
});

test('SignupPage: رمز الرابط يُرسل مع refAt، والنافذة يفرضها الخادم وحده', async () => {
  const { readFileSync } = await import('node:fs');
  const s = readFileSync(new URL('../pages/SignupPage.tsx', import.meta.url), 'utf8');
  assert.match(s, /refVia: 'link', refAt: linkRefState\.at/, 'refAt لا يُرسل مع رمز الرابط');
  // نافذة كل سفير من شروطه المقبولة لا تُعرف في المتصفّح — لا إسقاط ولا جلب للنافذة هنا
  assert.doesNotMatch(s, /fetchRefWindowDays|isRefWithinWindow|terms\/public|refWindowDays/, 'الواجهة ما زالت تُسقط الرمز بنافذة عامة');
  const referral = readFileSync(new URL('./referral.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(referral, /terms\/public/, 'الملتقط ما زال يجلب الشروط العامة');
  const client = readFileSync(new URL('../api/client.ts', import.meta.url), 'utf8');
  assert.match(client, /signup: \(data: \{[^}]*refAt\?: number/, 'authApi.signup لا يقبل refAt');
});
