// M1 — ترقيم القيود (DESIGN.md I6 §2.1، GlSequence §3.2، الدفاتر §4.3، G2 §9.5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  SEQUENCE_PADDING, isValidJournalCode, isSequenceReset, sequencePeriodKey, sequencePrefixFor, sequenceGroup,
  sequenceGroupKey, formatMoveNumber, moveNumberFor, parseMoveNumber, checkSequenceGaps, journalCodeConflict,
} from '../services/gl/sequence';
import { JOURNAL_CODE_BY_SYSTEM_KEY, type JournalRef } from '../services/gl/types';

function journal(code: string, sequenceReset: 'MONTHLY' | 'YEARLY', id = `j-${code}`): Pick<JournalRef, 'id' | 'code' | 'sequenceReset'> {
  return { id, code, sequenceReset };
}

test('مفتاح الفترة حسب sequenceReset', () => {
  assert.equal(sequencePeriodKey('2026-09-16', 'YEARLY'), '2026');
  assert.equal(sequencePeriodKey('2026-09-16', 'MONTHLY'), '2026-09');
  assert.equal(sequencePeriodKey('2026-01-01', 'MONTHLY'), '2026-01');
  assert.equal(sequencePeriodKey('2026-12-31', 'YEARLY'), '2026');
  assert.equal(sequencePeriodKey('2027-01-01', 'YEARLY'), '2027');
  assert.equal(sequencePeriodKey('2028-02-29', 'MONTHLY'), '2028-02');
  assert.throws(() => sequencePeriodKey('2026-13-01', 'MONTHLY'), RangeError);
  assert.throws(() => sequencePeriodKey('2026-09-16', 'WEEKLY' as never), RangeError);
  assert.ok(isSequenceReset('MONTHLY') && isSequenceReset('YEARLY') && !isSequenceReset('DAILY'));
});

test('صيغ §4.3: INV/2026/09/0001 وPAY/2026/00001 وRCPT/2026/00001', () => {
  assert.deepEqual(SEQUENCE_PADDING, { MONTHLY: 4, YEARLY: 5 });
  assert.equal(formatMoveNumber('INV', '2026-09', 'MONTHLY', 1), 'INV/2026/09/0001');
  assert.equal(formatMoveNumber('PAY', '2026', 'YEARLY', 1), 'PAY/2026/00001');
  assert.equal(formatMoveNumber('RCPT', '2026', 'YEARLY', 1), 'RCPT/2026/00001');
  assert.equal(moveNumberFor('RINV', '2026-09-30', 'MONTHLY', 12), 'RINV/2026/09/0012');
  assert.equal(moveNumberFor('CSH1', '2026-09-30', 'YEARLY', 123), 'CSH1/2026/00123');
  // الرقم يتجاوز الحشو ولا يُقصّ
  assert.equal(formatMoveNumber('INV', '2026-09', 'MONTHLY', 12345), 'INV/2026/09/12345');
  assert.equal(formatMoveNumber('PAY', '2026', 'YEARLY', 123456), 'PAY/2026/123456');
  // مدخلات غير صالحة
  assert.throws(() => formatMoveNumber('INV', '2026-09', 'MONTHLY', 0), RangeError);
  assert.throws(() => formatMoveNumber('INV', '2026-09', 'MONTHLY', 1.5), RangeError);
  assert.throws(() => formatMoveNumber('INV', '2026', 'MONTHLY', 1), RangeError);
  assert.throws(() => formatMoveNumber('PAY', '2026-09', 'YEARLY', 1), RangeError);
  assert.throws(() => formatMoveNumber('inv', '2026', 'YEARLY', 1), RangeError);
  assert.throws(() => formatMoveNumber('A/B', '2026', 'YEARLY', 1), RangeError);
});

test('البادئة: رمز الدفتر، والمرتجع R + الرمز، والصريحة تتقدم', () => {
  assert.equal(sequencePrefixFor('INV', 'OUT_INVOICE'), 'INV');
  assert.equal(sequencePrefixFor('INV', 'OUT_REFUND'), 'RINV');
  assert.equal(sequencePrefixFor('BILL', 'IN_INVOICE'), 'BILL');
  assert.equal(sequencePrefixFor('BILL', 'IN_REFUND'), 'RBILL');
  assert.equal(sequencePrefixFor('RCPT', 'CUST_RECEIPT'), 'RCPT');
  assert.equal(sequencePrefixFor('MISC', 'ENTRY', 'RINV'), 'RINV');
  assert.equal(sequencePrefixFor('MISC', 'ENTRY', ''), 'MISC');
  assert.equal(sequencePrefixFor('MISC', 'ENTRY', null), 'MISC');
  assert.throws(() => sequencePrefixFor('misc', 'ENTRY'), RangeError);
  assert.throws(() => sequencePrefixFor('MISC', 'ENTRY', 'bad prefix'), RangeError);
});

test('رموز الدفاتر المزروعة كلها صالحة (≤6 أحرف لاتينية)', () => {
  for (const code of Object.values(JOURNAL_CODE_BY_SYSTEM_KEY)) {
    assert.ok(isValidJournalCode(code), code);
    assert.equal(sequencePrefixFor(code, 'ENTRY'), code);
  }
  assert.ok(isValidJournalCode('ABCDEF'));
  assert.ok(!isValidJournalCode('ABCDEFG'));
  assert.ok(!isValidJournalCode('1INV'));
  assert.ok(!isValidJournalCode('فاتورة'));
  assert.ok(!isValidJournalCode(''));
});

test('مجموعة التسلسل (دفتر، بادئة، فترة)', () => {
  const inv = journal('INV', 'MONTHLY');
  const g1 = sequenceGroup({ journal: inv, moveType: 'OUT_INVOICE', date: '2026-09-16' });
  assert.deepEqual(g1, { journalId: 'j-INV', prefix: 'INV', periodKey: '2026-09' });
  // المرتجع في الدفتر نفسه سلسلة منفصلة
  const g2 = sequenceGroup({ journal: inv, moveType: 'OUT_REFUND', date: '2026-09-16' });
  assert.deepEqual(g2, { journalId: 'j-INV', prefix: 'RINV', periodKey: '2026-09' });
  assert.notEqual(sequenceGroupKey(g1), sequenceGroupKey(g2));
  // الشهر التالي يبدأ سلسلة جديدة، واليوم الأخير من الشهر في سلسلته
  const g3 = sequenceGroup({ journal: inv, moveType: 'OUT_INVOICE', date: '2026-10-01' });
  assert.equal(g3.periodKey, '2026-10');
  assert.equal(sequenceGroupKey(sequenceGroup({ journal: inv, moveType: 'OUT_INVOICE', date: '2026-09-30' })), sequenceGroupKey(g1));
  // السنوي: كل السنة سلسلة واحدة
  const pay = journal('PAY', 'YEARLY');
  const a = sequenceGroup({ journal: pay, moveType: 'PAYMENT', date: '2026-01-01' });
  const b = sequenceGroup({ journal: pay, moveType: 'PAYMENT', date: '2026-12-31' });
  const c = sequenceGroup({ journal: pay, moveType: 'PAYMENT', date: '2027-01-01' });
  assert.equal(sequenceGroupKey(a), sequenceGroupKey(b));
  assert.notEqual(sequenceGroupKey(a), sequenceGroupKey(c));
  assert.equal(formatMoveNumber(a.prefix, a.periodKey, pay.sequenceReset, 1), 'PAY/2026/00001');
  // دفتران مختلفان بالبادئة نفسها صراحةً لا يتشاركان
  const other = journal('MISC', 'YEARLY', 'j-2');
  const d = sequenceGroup({ journal: other, moveType: 'ENTRY', date: '2026-05-05', sequencePrefix: 'PAY' });
  assert.notEqual(sequenceGroupKey(d), sequenceGroupKey(a));
  assert.throws(() => sequenceGroup({ journal: { id: '', code: 'INV', sequenceReset: 'MONTHLY' }, moveType: 'ENTRY', date: '2026-01-01' }), RangeError);
});

test('تحليل الرقم عكس التنسيق', () => {
  assert.deepEqual(parseMoveNumber('INV/2026/09/0001'), { prefix: 'INV', periodKey: '2026-09', reset: 'MONTHLY', n: 1 });
  assert.deepEqual(parseMoveNumber('PAY/2026/00001'), { prefix: 'PAY', periodKey: '2026', reset: 'YEARLY', n: 1 });
  assert.deepEqual(parseMoveNumber('RBILL/2027/02/12345'), { prefix: 'RBILL', periodKey: '2027-02', reset: 'MONTHLY', n: 12345 });
  assert.equal(parseMoveNumber('INV/2026/13/0001'), null);
  assert.equal(parseMoveNumber('INV/2026/0001'), null); // 4 خانات بلا شهر ليست سنوية
  assert.equal(parseMoveNumber('PAY/2026/00000'), null);
  assert.equal(parseMoveNumber('garbage'), null);
  for (const reset of ['MONTHLY', 'YEARLY'] as const) {
    for (const date of ['2026-01-01', '2026-09-16', '2028-02-29', '2030-12-31']) {
      for (const n of [1, 9, 10, 999, 1000, 9999, 10000, 99999, 100000]) {
        const s = moveNumberFor('INV', date, reset, n);
        assert.deepEqual(parseMoveNumber(s), { prefix: 'INV', periodKey: sequencePeriodKey(date, reset), reset, n }, s);
      }
    }
  }
});

test('C12: أرقام المجموعة = {1 … nextNumber − 1} تماماً', () => {
  assert.deepEqual(checkSequenceGaps([1, 2, 3], 4), { ok: true, missing: [], unexpected: [], duplicates: [] });
  assert.deepEqual(checkSequenceGaps([], 1), { ok: true, missing: [], unexpected: [], duplicates: [] });
  // {1، 2، 4} ⇒ أحمر (G2)
  const r = checkSequenceGaps([1, 2, 4]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, [3]);
  // ترتيب غير مرتب لا يهم
  assert.equal(checkSequenceGaps([3, 1, 2], 4).ok, true);
  // تراجع المعاملة بعد منح الرقم يعيد العدّاد: nextNumber لم يتقدم ⇒ لا فجوة
  assert.equal(checkSequenceGaps([1, 2], 3).ok, true);
  // عدّاد تقدّم بلا قيد (منح خارج المعاملة) ⇒ فجوة في الذيل
  assert.deepEqual(checkSequenceGaps([1, 2], 4).missing, [3]);
  // رقم خارج المدى ومكرّر
  assert.deepEqual(checkSequenceGaps([1, 2, 5], 3).unexpected, [5]);
  assert.deepEqual(checkSequenceGaps([1, 1, 2], 3).duplicates, [1]);
  assert.equal(checkSequenceGaps([1, 1, 2], 3).ok, false);
  assert.deepEqual(checkSequenceGaps([0, 1], 2).unexpected, [0]);
  assert.throws(() => checkSequenceGaps([1], 0), RangeError);
});

test('sequence.ts صرف: لا prisma ولا I/O', () => {
  const src = fs.readFileSync(path.join(__dirname, '../services/gl/sequence.ts'), 'utf8');
  assert.doesNotMatch(src, /prisma|@prisma\/client|from ['"](node:)?fs['"]|process\.env/);
});

test('journalCodeConflict: رمز يساوي بادئة مرتجع دفتر آخر (أو العكس) يُرفض — G2 @@unique([tenantId, number])', () => {
  assert.equal(journalCodeConflict('RINV', ['INV']), 'INV');
  assert.equal(journalCodeConflict('INV', ['RINV']), 'RINV');
  assert.equal(journalCodeConflict('BNK1', ['INV', 'BILL']), null);
  assert.equal(journalCodeConflict('R', []), null);
  assert.equal(journalCodeConflict('INV', ['INV']), 'INV');
  assert.equal(journalCodeConflict('RBILL', ['INV', 'BILL']), 'BILL');
  // التصادم فعلي: الرقمان متطابقان
  assert.equal(moveNumberFor(sequencePrefixFor('INV', 'OUT_REFUND'), '2026-09-01', 'MONTHLY', 1),
    moveNumberFor(sequencePrefixFor('RINV', 'OUT_INVOICE'), '2026-09-01', 'MONTHLY', 1));
  // الدفاتر الافتراضية (§4.3) لا تتصادم فيما بينها
  const defaults = Object.values(JOURNAL_CODE_BY_SYSTEM_KEY) as string[];
  defaults.forEach((c, i) => assert.equal(journalCodeConflict(c, defaults.filter((_, j) => j !== i)), null, c));
});
