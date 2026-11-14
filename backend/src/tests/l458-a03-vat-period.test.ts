// «ربط الدفاتر» L4 — A3: فترات الإقرار (vat/period.ts) وOD17 على العكس من القيد الحيّ (reverse.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyReversalVatPeriod, effectivePostingDate, linkedReversalVatPeriod, reversalVatPeriodOf, sameVatPeriod,
  vatPeriodKey, vatPeriodRange, vatPeriodSettingsOf, type ReversalVatPeriod,
} from '../services/gl/vat/period';
import { reversalDraftFromRecord } from '../services/gl/reverse';
import { isVatPeriodStart } from '../services/gl/opening';
import { addDays } from '../services/gl/dates';
import { TAX_PERIODICITIES, type MoveDraft, type TaxPeriodicity } from '../services/gl/types';
import { saContext } from '../services/gl/testing/fixtures';
import { receiptRecord, returnRecord, saleRecord } from './l458-a03-records';

const QUARTERLY: ReversalVatPeriod = { periodicity: 'QUARTERLY', fiscalYearEndMonth: 12, fiscalYearEndDay: 31 };

test('vatPeriodKey/vatPeriodRange: الحدود التقويمية لكل دورية، وFISCAL_YEAR بنهاية السنة المالية', () => {
  const cases: [TaxPeriodicity, string, string, string][] = [
    ['MONTHLY', '2026-09-28', '2026-09-01', '2026-09-30'],
    ['MONTHLY', '2028-02-15', '2028-02-01', '2028-02-29'],
    ['BIMONTHLY', '2026-04-30', '2026-03-01', '2026-04-30'],
    ['QUARTERLY', '2026-09-28', '2026-07-01', '2026-09-30'],
    ['QUARTERLY', '2026-10-03', '2026-10-01', '2026-12-31'],
    ['FOUR_MONTHS', '2026-08-31', '2026-05-01', '2026-08-31'],
    ['SEMIANNUAL', '2026-07-01', '2026-07-01', '2026-12-31'],
    ['ANNUAL', '2026-06-30', '2026-01-01', '2026-12-31'],
  ];
  for (const [p, d, start, end] of cases) {
    assert.deepEqual(vatPeriodRange(d, p), { start, end }, `${p} ${d}`);
    assert.equal(vatPeriodKey(d, p), start);
  }
  assert.deepEqual(vatPeriodRange('2026-06-30', 'FISCAL_YEAR', 6, 30), { start: '2025-07-01', end: '2026-06-30' });
  assert.deepEqual(vatPeriodRange('2026-07-01', 'FISCAL_YEAR', 6, 30), { start: '2026-07-01', end: '2027-06-30' });
  assert.equal(sameVatPeriod('2026-09-28', '2026-09-30', 'QUARTERLY'), true);
  assert.equal(sameVatPeriod('2026-09-28', '2026-10-03', 'QUARTERLY'), false);
  assert.equal(sameVatPeriod('2026-09-28', '2026-10-03', 'ANNUAL'), true);
  assert.throws(() => vatPeriodKey('2026-01-01', 'WEEKLY' as TaxPeriodicity), RangeError);
});

test('التكافؤ مع isVatPeriodStart: لكل يوم 2026–2028 ولكل دورية ونهاية سنة مالية — key(d)=d ⇔ بداية فترة، والفترات متّصلة', () => {
  const fyEnds: [number, number][] = [[12, 31], [6, 30], [3, 31], [2, 28], [2, 29], [9, 30]];
  for (const p of TAX_PERIODICITIES) {
    for (const [m, dd] of p === 'FISCAL_YEAR' ? fyEnds : [[12, 31] as [number, number]]) {
      for (let d = '2026-01-01'; d <= '2028-12-31'; d = addDays(d, 1)) {
        const r = vatPeriodRange(d, p, m, dd);
        assert.equal(r.start === d, isVatPeriodStart(d, p, m, dd), `${p} ${m}/${dd} ${d}`);
        assert.ok(r.start <= d && d <= r.end, `${p} ${d} داخل فترته`);
        assert.equal(vatPeriodKey(addDays(r.end, 1), p, m, dd), addDays(r.end, 1), `${p} ${d}: ما بعد النهاية بداية فترة تالية`);
      }
    }
  }
});

test('vatPeriodSettingsOf/reversalVatPeriodOf/linkedReversalVatPeriod: undefined لغير المربوطة، والإعدادات والإقفالات للمربوطة', () => {
  const plain = saContext();
  assert.equal(linkedReversalVatPeriod(plain), undefined);
  const linked = saContext({ settings: { linkedPosting: true, taxPeriodicity: 'MONTHLY', taxLockDate: '2026-08-31' } });
  const v = linkedReversalVatPeriod(linked);
  assert.ok(v);
  assert.deepEqual(vatPeriodSettingsOf(linked.settings), { periodicity: 'MONTHLY', fiscalYearEndMonth: 12, fiscalYearEndDay: 31 });
  assert.equal(v.periodicity, 'MONTHLY');
  assert.equal(v.lockShift?.locks.taxLockDate, '2026-08-31');
  assert.deepEqual(reversalVatPeriodOf(linked).periodicity, 'MONTHLY');
});

test('OD17 على العكس من القيد الحيّ (E4.10): بيع 2026-09-28 ⇒ عكس 2026-10-03 يعلّم TAX وMARKER وحدهما، و2026-09-30 كما كان حرفاً', () => {
  const rec = saleRecord('2026-09-28');
  const plain = reversalDraftFromRecord(rec, { date: '2026-10-03', reason: 'إلغاء' });
  const od17 = reversalDraftFromRecord(rec, { date: '2026-10-03', reason: 'إلغاء', vatPeriod: QUARTERLY });
  assert.equal(od17.lines.length, plain.lines.length);
  od17.lines.forEach((l, i) => {
    const tagged = l.taxRole === 'TAX' || l.taxRole === 'MARKER';
    assert.deepEqual(l, tagged ? { ...plain.lines[i], vatAdjustment: true } : plain.lines[i], `سطر ${i}`);
  });
  assert.deepEqual(od17.lines.map((l) => l.vatAdjustment), [false, false, true, true]);
  // الأرقام كما هي: Dr 411001 100 / Dr 212001 15 / Cr 113001 115
  assert.deepEqual(od17.lines.map((l) => [l.debitMilli, l.creditMilli]), [[0n, 115_000n], [100_000n, 0n], [15_000n, 0n], [0n, 0n]]);
  assert.equal(od17.lines[2].taxBaseMilli, -100_000n);
  // الفترة نفسها ⇒ الكائن نفسه حرفاً
  assert.deepEqual(reversalDraftFromRecord(rec, { date: '2026-09-30', reason: 'إلغاء', vatPeriod: QUARTERLY }), reversalDraftFromRecord(rec, { date: '2026-09-30', reason: 'إلغاء' }));
});

test('OD17: المرتجع معلَّم أصلاً فيبقى، والسند بلا ضريبة لا يتغيّر، والأصل المُزاح يُقاس بتاريخ ترحيله الفعلي', () => {
  for (const d of ['2026-09-30', '2026-10-03']) {
    const r = reversalDraftFromRecord(returnRecord(), { date: d, reason: 'إلغاء', vatPeriod: QUARTERLY });
    assert.equal(r.lines.find((l) => l.taxRole === 'TAX')?.vatAdjustment, true, d);
    assert.deepEqual(r, reversalDraftFromRecord(returnRecord(), { date: d, reason: 'إلغاء' }));
  }
  assert.deepEqual(
    reversalDraftFromRecord(receiptRecord(), { date: '2027-01-05', reason: 'إلغاء', vatPeriod: QUARTERLY }),
    reversalDraftFromRecord(receiptRecord(), { date: '2027-01-05', reason: 'إلغاء' }),
  );
  // أصلٌ وصل متأخراً فرُحِّل في 2026-10-01 (originalDate 2026-09-28): ضريبته في الربع الرابع، والعكس فيه ⇒ لا تعديل
  const late = { ...saleRecord('2026-10-01'), lateArrival: true, originalDate: new Date('2026-09-28T00:00:00.000Z') };
  const r = reversalDraftFromRecord(late, { date: '2026-10-05', reason: 'إلغاء', vatPeriod: QUARTERLY });
  assert.ok(r.lines.every((l) => l.vatAdjustment === false));
});

test('OD17 مع إزاحة الإقفال (lockShift): عكسٌ في الربع نفسه بتاريخ ≤ taxLockDate يُعلَّم لأنّ postMove سيزيحه إلى الربع التالي', () => {
  const rec = saleRecord('2026-09-28');
  const ctxOpen = saContext({ settings: { linkedPosting: true } });
  const ctxLocked = saContext({ settings: { linkedPosting: true, taxLockDate: '2026-09-30' } });
  const open = reversalDraftFromRecord(rec, { date: '2026-09-29', reason: 'إلغاء', vatPeriod: linkedReversalVatPeriod(ctxOpen) });
  assert.ok(open.lines.every((l) => l.vatAdjustment === false));
  const locked = reversalDraftFromRecord(rec, { date: '2026-09-29', reason: 'إلغاء', vatPeriod: linkedReversalVatPeriod(ctxLocked) });
  assert.equal(locked.date, '2026-09-29', 'التاريخ لا يُزاح هنا (postMove يفعل)');
  assert.deepEqual(locked.lines.map((l) => l.vatAdjustment), [false, false, true, true]);
  assert.equal(effectivePostingDate(locked, linkedReversalVatPeriod(ctxLocked) as ReversalVatPeriod), '2026-10-01');
  // بلا lockShift: الحكم على التاريخ المعطى وحده
  assert.ok(reversalDraftFromRecord(rec, { date: '2026-09-29', reason: 'إلغاء', vatPeriod: QUARTERLY }).lines.every((l) => l.vatAdjustment === false));
  // إقفال المبيعات وحده يزيح قيداً على الذمم أيضاً (applicableLockFields) — فالحكم يتبع الإزاحة الفعلية
  const salesLocked = saContext({ settings: { linkedPosting: true, salesLockDate: '2026-09-30' } });
  const s = reversalDraftFromRecord(rec, { date: '2026-09-29', reason: 'إلغاء', vatPeriod: linkedReversalVatPeriod(salesLocked) });
  assert.equal(s.lines.find((l) => l.taxRole === 'TAX')?.vatAdjustment, true);
});

test('applyReversalVatPeriod: لا ينسخ المسودة حين لا تغيير (الكائن نفسه)، ولا يلمس سطوراً بلا taxRole', () => {
  const draft: MoveDraft = {
    kind: 'MOVE', journalCode: 'INV', moveType: 'OUT_INVOICE', origin: 'AUTO', date: '2026-10-03', ref: null, narration: 'عكس',
    lines: [
      { accountKey: 'AR_CONTROL', label: 'ذمة', debitMilli: 0n, creditMilli: 10n, customerId: 'c', partnerName: 'ع' },
      { accountKey: 'POSTING_SUSPENSE', label: 'معلّق ضريبة', debitMilli: 10n, creditMilli: 0n },
    ],
  } as MoveDraft;
  assert.equal(applyReversalVatPeriod(draft, '2026-09-28', QUARTERLY), draft);
  const withTax = { ...draft, lines: [...draft.lines, { accountKey: 'OUTPUT_VAT' as const, label: 'ضريبة', debitMilli: 0n, creditMilli: 0n, taxRole: 'MARKER' as const, vatAdjustment: true }] };
  assert.equal(applyReversalVatPeriod(withTax, '2026-09-28', QUARTERLY), withTax, 'معلَّم أصلاً ⇒ الكائن نفسه');
  assert.equal(applyReversalVatPeriod(withTax, '2026-10-01', QUARTERLY), withTax, 'الفترة نفسها ⇒ الكائن نفسه');
});
