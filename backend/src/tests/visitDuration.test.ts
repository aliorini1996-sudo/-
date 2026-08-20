import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeVisitDuration, formatDuration, MAX_VISIT_SECONDS } from '../services/visitDuration';

const base = new Date('2026-08-03T10:00:00.000Z');
const plus = (sec: number) => new Date(base.getTime() + sec * 1000);

/* ─────────────────── الحساب من الطابعين ─────────────────── */

test('المدة تحسب من الطابعين لا من رقم العميل', () => {
  // العميل يدعي 30 ثانية، والطابعان يقولان 300 — نعتمد الخادم
  const r = computeVisitDuration({ startedAt: base, endedAt: plus(300), clientDurationSec: 30 });
  assert.equal(r.ok, true);
  assert.equal(r.durationSec, 300);
  assert.equal(r.rawSec, 300);
  assert.equal(r.clientMismatch, true, 'فرق كبير مع رقم العميل يرفع علما');
});

test('توافق رقم العميل مع الخادم لا يرفع علما', () => {
  const r = computeVisitDuration({ startedAt: base, endedAt: plus(180), clientDurationSec: 178 });
  assert.equal(r.clientMismatch, false);
});

test('زيارة عادية ٥ دقائق', () => {
  const r = computeVisitDuration({ startedAt: base, endedAt: plus(300) });
  assert.equal(r.durationSec, 300);
  assert.equal(r.capped, false);
});

/* ─────────────────── السقف: التوكن المنسي ─────────────────── */

test('مدة تفوق ٤ ساعات تقص وتعلم capped', () => {
  const r = computeVisitDuration({ startedAt: base, endedAt: plus(6 * 3600) });
  assert.equal(r.ok, true);
  assert.equal(r.durationSec, MAX_VISIT_SECONDS, 'قصت عند السقف');
  assert.equal(r.rawSec, 6 * 3600, 'والخام محفوظ للشفافية');
  assert.equal(r.capped, true);
});

test('عند السقف بالضبط لا تقص', () => {
  const r = computeVisitDuration({ startedAt: base, endedAt: plus(MAX_VISIT_SECONDS) });
  assert.equal(r.capped, false);
  assert.equal(r.durationSec, MAX_VISIT_SECONDS);
});

/* ─────────────────── بيانات فاسدة ─────────────────── */

test('مدة سالبة (endedAt قبل startedAt) ترفض — لا صفر', () => {
  const r = computeVisitDuration({ startedAt: plus(300), endedAt: base });
  assert.equal(r.ok, false);
  assert.equal(r.durationSec, null);
  assert.match(String(r.reason), /غير معقولة/);
});

test('مدة أقصر من ثانيتين ترفض (ضغطة خاطئة)', () => {
  const r = computeVisitDuration({ startedAt: base, endedAt: plus(1) });
  assert.equal(r.ok, false);
  assert.equal(r.durationSec, null);
});

test('طابع زمني فاسد لا يسقط الدالة', () => {
  const r = computeVisitDuration({ startedAt: 'ليس تاريخا', endedAt: plus(300) });
  assert.equal(r.ok, false);
  assert.equal(r.durationSec, null);
  assert.match(String(r.reason), /غير صالح/);
});

test('يقبل ISO نصا كما يصل من العميل', () => {
  const r = computeVisitDuration({
    startedAt: '2026-08-03T10:00:00.000Z',
    endedAt: '2026-08-03T10:07:30.000Z',
  });
  assert.equal(r.durationSec, 450);
});

/* ─────────────────── التنسيق ─────────────────── */

test('تنسيق المدة: دقائق:ثوان وساعات عند اللزوم', () => {
  assert.equal(formatDuration(0), '0:00');
  assert.equal(formatDuration(65), '1:05');
  assert.equal(formatDuration(725), '12:05');
  assert.equal(formatDuration(3800), '1:03:20');
  assert.equal(formatDuration(null), '—');
  assert.equal(formatDuration(-5), '—');
  assert.equal(formatDuration(undefined), '—');
});
