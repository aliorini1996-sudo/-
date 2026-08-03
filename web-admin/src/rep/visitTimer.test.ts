import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// مخزون وهميّ يحاكي localStorage قبل استيراد الوحدة
const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: () => null,
  length: 0,
} as Storage;

const { getVisitTimer, setVisitTimer, clearVisitTimer, elapsedSec, fmtElapsed } = await import('./visitTimer');

beforeEach(() => store.clear());

test('دورة الحياة: ضبط ثم قراءة ثم مسح', () => {
  assert.equal(getVisitTimer(), null);
  setVisitTimer({ customerId: 'c1', customerName: 'بقالة النور', startedAt: '2026-08-03T10:00:00.000Z' });
  const t = getVisitTimer();
  assert.equal(t?.customerId, 'c1');
  assert.equal(t?.customerName, 'بقالة النور');
  clearVisitTimer();
  assert.equal(getVisitTimer(), null);
});

test('قيمة تالفة في المخزون ⇒ null لا انهيار', () => {
  store.set('rep_visit_timer', 'ليس JSON');
  assert.equal(getVisitTimer(), null);
});

test('كائن ناقص (بلا startedAt) ⇒ null', () => {
  store.set('rep_visit_timer', JSON.stringify({ customerId: 'c1' }));
  assert.equal(getVisitTimer(), null);
});

test('يحمل بيانات العميل الأوف‑لاين', () => {
  setVisitTimer({ customerId: 'tmp', customerName: 'جديد', startedAt: '2026-08-03T10:00:00.000Z', offline: true, customerClientRef: 'ref-1' });
  const t = getVisitTimer();
  assert.equal(t?.offline, true);
  assert.equal(t?.customerClientRef, 'ref-1');
});

test('elapsedSec يحسب الفرق بالثواني', () => {
  const start = '2026-08-03T10:00:00.000Z';
  const now = new Date('2026-08-03T10:05:30.000Z').getTime();
  assert.equal(elapsedSec(start, now), 330);
});

test('elapsedSec لا يعطي سالباً (ساعة مرتدّة) ولا يسقط على طابع فاسد', () => {
  const start = '2026-08-03T10:05:00.000Z';
  const before = new Date('2026-08-03T10:00:00.000Z').getTime();
  assert.equal(elapsedSec(start, before), 0);
  assert.equal(elapsedSec('تاريخ فاسد', Date.now()), 0);
});

test('fmtElapsed: دقائق:ثوانٍ وساعات عند اللزوم', () => {
  assert.equal(fmtElapsed(0), '0:00');
  assert.equal(fmtElapsed(9), '0:09');
  assert.equal(fmtElapsed(330), '5:30');
  assert.equal(fmtElapsed(3661), '1:01:01');
});
