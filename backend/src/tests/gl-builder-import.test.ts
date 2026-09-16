// M1 — وصفة صفوف AccountEntry بلا مستند P11 (الأرصدة والأستاذ المستوردان) وعكسها من الحمولة P12 — DESIGN.md §5.5، §5.2، §5.4.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  arEntryEventKey, buildImportEntriesMove, buildImportEntryMove, groupImportEntries, importEntrySourceKeys,
  type ImportEntryPayload,
} from '../services/gl/builders/importEntry';
import { validateMove } from '../services/gl/validate';
import { saContext } from '../services/gl/testing/fixtures';
import { isNoMove, type BuildContext, type BuildResult, type MoveDraft } from '../services/gl/types';

const ARABIC = /[؀-ۿ]/;

function asMove(r: BuildResult): MoveDraft {
  assert.equal(r.kind, 'MOVE');
  return r as MoveDraft;
}

function checkMove(m: MoveDraft, ctx: BuildContext): void {
  assert.ok(m.narration.trim() && ARABIC.test(m.narration), 'narration عربي غير فارغ');
  for (const l of m.lines) {
    assert.ok(l.label.trim() && ARABIC.test(l.label), 'label عربي غير فارغ');
    if (l.customerId || l.vendorId || l.salesRepId) assert.ok(l.partnerName?.trim(), 'partnerName مملوء');
  }
  const v = validateMove(m, ctx);
  assert.equal(v.totalDebitMilli, v.totalCreditMilli);
}

function codeOf(ctx: BuildContext, l: MoveDraft['lines'][number]): string | undefined {
  const acc = l.accountId ? ctx.accounts.byId(l.accountId)
    : l.accountCode ? ctx.accounts.byCode(l.accountCode)
      : l.accountKey ? ctx.accounts.byKey(l.accountKey) : null;
  return acc?.code;
}

/** Σ(مدين − دائن) على 113001 لكل عميل */
function arByCustomer(m: MoveDraft, ctx: BuildContext): Map<string, bigint> {
  const out = new Map<string, bigint>();
  for (const l of m.lines) {
    if (codeOf(ctx, l) !== '113001') continue;
    assert.ok(l.customerId, 'الشريك إلزامي على 113001');
    out.set(l.customerId!, (out.get(l.customerId!) ?? 0n) + l.debitMilli - l.creditMilli);
  }
  return out;
}

const row = (id: string, customerId: string, debit: string, credit: string, entryDate: string, extra: Partial<ImportEntryPayload> = {}): ImportEntryPayload => ({
  entryId: id, customerId, customerName: `مؤسسة ${customerId}`, debit, credit, description: 'رصيد افتتاحي',
  entryDate, createdAt: '2027-01-05T08:00:00Z', ...extra,
});

test('P11: رصيد مدين مستورد ⇒ مدين 113001 (العميل) / دائن 319002 في دفتر OPEN', () => {
  const ctx = saContext();
  const m = asMove(buildImportEntryMove(row('ae-1', 'c1', '1500.25', '0', '2026-12-31T21:30:00Z'), ctx));
  checkMove(m, ctx);
  assert.equal(m.date, '2027-01-01'); // 00:30 بتوقيت الرياض
  assert.equal(m.journalCode, 'OPEN');
  assert.equal(m.journalSystemKey, 'OPENING');
  assert.equal(m.moveType, 'IMPORT');
  assert.equal(m.origin, 'AUTO');
  assert.equal(m.sourceType, 'AR_ENTRY');
  assert.equal(m.sourceId, 'ae-1');
  assert.equal(m.sourceKey, 'AR_ENTRY:ae-1:POST');
  assert.equal(m.sourceEvent, 'POST');
  assert.equal(m.customerId, 'c1');
  assert.equal(m.lines.length, 2);
  const [ar, eq] = m.lines;
  assert.equal(codeOf(ctx, ar), '113001');
  assert.equal(ar.debitMilli, 1_500_250n);
  assert.equal(ar.customerId, 'c1');
  assert.equal(ar.partnerName, 'مؤسسة c1');
  assert.equal(codeOf(ctx, eq), '319002');
  assert.equal(eq.creditMilli, 1_500_250n);
  assert.equal(m.needsAttention, false);
});

test('P11: رصيد دائن مستورد ⇒ مدين 319002 / دائن 113001 (العميل)', () => {
  const ctx = saContext();
  const m = asMove(buildImportEntryMove(row('ae-2', 'c2', '0', '320', '2027-02-10T09:00:00Z'), ctx));
  checkMove(m, ctx);
  const ar = m.lines.find(l => codeOf(ctx, l) === '113001')!;
  const eq = m.lines.find(l => codeOf(ctx, l) === '319002')!;
  assert.equal(ar.creditMilli, 320_000n);
  assert.equal(ar.debitMilli, 0n);
  assert.equal(eq.debitMilli, 320_000n);
});

test('P11: أحداث الدفعة نفسها تُجمَّع في قيد واحد بسطر لكل عميل، وذمم القيد = Σ AccountEntry لكل عميل', () => {
  const ctx = saContext();
  const d = '2027-01-15T10:00:00Z';
  const rows: ImportEntryPayload[] = [
    row('e1', 'c1', '100', '0', d, { description: 'فاتورة قديمة 1' }),
    row('e2', 'c2', '0', '40.5', d),
    row('e3', 'c1', '250.10', '0', d, { description: 'فاتورة قديمة 2' }),
    row('e4', 'c3', '10', '10', d), // صافٍ صفري: لا سطر
    row('e5', 'c1', '0', '50', d),
    // استيراد /ledger لا يمنع القيم السالبة: الصافي وحده يُعتمد
    row('e6', 'c2', '-5', '0', d),
  ];
  const m = asMove(buildImportEntriesMove(rows, ctx));
  checkMove(m, ctx);
  assert.equal(m.sourceKey, 'AR_ENTRY:e1:POST');
  assert.equal(m.customerId, null);
  assert.deepEqual(importEntrySourceKeys(rows), rows.map(r => `AR_ENTRY:${r.entryId}:POST`));

  const ar = arByCustomer(m, ctx);
  const expected = new Map<string, bigint>();
  for (const r of rows) {
    const v = BigInt(Math.round(Number(r.debit) * 1000)) - BigInt(Math.round(Number(r.credit) * 1000));
    expected.set(r.customerId, (expected.get(r.customerId) ?? 0n) + v);
  }
  for (const [cid, v] of expected) {
    if (v === 0n) assert.equal(ar.has(cid), false);
    else assert.equal(ar.get(cid), v);
  }
  // سطر واحد لكل عميل على 113001
  assert.equal(m.lines.filter(l => codeOf(ctx, l) === '113001').length, 2);
  const eq = m.lines.filter(l => codeOf(ctx, l) === '319002');
  assert.equal(eq.length, 1);
  assert.equal(eq[0].creditMilli - eq[0].debitMilli, 300_100n - 45_500n);
});

test('P11: تقاصّ الأرصدة بين عميلين بلا صافٍ على 319002 ⇒ بلا سطر 319002، والصافي الكلي صفر ⇒ NO_MOVE', () => {
  const ctx = saContext();
  const d = '2027-03-01T10:00:00Z';
  const m = asMove(buildImportEntriesMove([row('a', 'c1', '75', '0', d), row('b', 'c2', '0', '75', d)], ctx));
  checkMove(m, ctx);
  assert.equal(m.lines.length, 2);
  assert.equal(m.lines.filter(l => codeOf(ctx, l) === '319002').length, 0);

  const z = buildImportEntriesMove([row('x', 'c1', '20', '0', d), row('y', 'c1', '0', '20', d)], ctx);
  assert.ok(isNoMove(z));
  assert.equal(z.reason, 'ZERO_VALUE');
  assert.ok(isNoMove(buildImportEntriesMove([], ctx)));
  assert.ok(isNoMove(buildImportEntryMove(row('z', 'c1', '0', '0', d), ctx)));
});

test('P11: تواريخ محلية مختلفة تُرفض، وgroupImportEntries يقسمها بتوقيت الشركة', () => {
  const ctx = saContext();
  const rows = [
    row('r1', 'c1', '10', '0', '2027-01-01T20:59:59Z'), // 2027-01-01 بالرياض
    row('r2', 'c2', '10', '0', '2027-01-01T21:00:00Z'), // 2027-01-02 بالرياض
    row('r3', 'c1', '5', '0', '2027-01-01T05:00:00Z'),
  ];
  assert.throws(() => buildImportEntriesMove(rows, ctx), RangeError);
  const groups = groupImportEntries(rows, ctx.settings.timezone);
  assert.deepEqual(groups.map(g => [g.date, g.entries.map(e => e.entryId)]), [
    ['2027-01-01', ['r1', 'r3']],
    ['2027-01-02', ['r2']],
  ]);
  for (const g of groups) {
    const m = asMove(buildImportEntriesMove(g.entries, ctx));
    checkMove(m, ctx);
    assert.equal(m.date, g.date);
  }
  assert.throws(() => buildImportEntriesMove([rows[0], rows[0]], ctx), RangeError);
});

test('P12 من الحمولة (شقيق POST مشمول بالافتتاح): قلب الجانبين بتاريخ العكس', () => {
  const ctx = saContext();
  const d = '2027-01-15T10:00:00Z';
  const rows = [row('e1', 'c1', '100', '0', d), row('e2', 'c2', '0', '30', d)];
  const post = asMove(buildImportEntriesMove(rows, ctx));
  const rev = asMove(buildImportEntriesMove(rows, ctx, { event: 'REVERSE', date: '2027-04-02' }));
  checkMove(rev, ctx);
  assert.equal(rev.date, '2027-04-02');
  assert.equal(rev.sourceEvent, 'REVERSE');
  assert.equal(rev.sourceKey, arEntryEventKey('e1', 'REVERSE'));
  assert.deepEqual(importEntrySourceKeys(rows, 'REVERSE'), ['AR_ENTRY:e1:REVERSE', 'AR_ENTRY:e2:REVERSE']);
  const a = arByCustomer(post, ctx);
  const b = arByCustomer(rev, ctx);
  for (const [cid, v] of a) assert.equal(b.get(cid), -v);
  assert.throws(() => buildImportEntriesMove(rows, ctx, { event: 'REVERSE' }), RangeError);
  assert.throws(() => buildImportEntriesMove(rows, ctx, { event: 'REVERSE', date: '2027-01-14' }), RangeError);
});

test('G6 (ز): partnerName يُملأ ببديل حين تغيب لقطة الاسم، ويُلتقط من صف لاحق', () => {
  const ctx = saContext();
  const d = '2027-01-15T10:00:00Z';
  const m1 = asMove(buildImportEntryMove(row('n1', 'c9', '10', '0', d, { customerName: null }), ctx));
  checkMove(m1, ctx);
  assert.equal(m1.lines[0].partnerName, 'عميل c9');
  const m2 = asMove(buildImportEntriesMove([
    row('n2', 'c9', '10', '0', d, { customerName: '' }),
    row('n3', 'c9', '5', '0', d, { customerName: 'بقالة النور' }),
  ], ctx));
  checkMove(m2, ctx);
  assert.equal(m2.lines[0].partnerName, 'بقالة النور');
});

test('P11 بعملة بثلاث منازل: المبالغ بالملّي بلا فقد', () => {
  const ctx = saContext({ settings: { currency: 'KWD', currencyDecimals: 3 } });
  const m = asMove(buildImportEntryMove(row('k1', 'c1', '12.345', '0', '2027-01-15T10:00:00Z'), ctx));
  checkMove(m, ctx);
  assert.equal(m.currencyCode, 'KWD');
  assert.equal(m.lines[0].debitMilli, 12_345n);
});

test('الـbuilder صرف: لا prisma ولا I/O', () => {
  const src = fs.readFileSync(path.join(__dirname, '../services/gl/builders/importEntry.ts'), 'utf8');
  const specs = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(m => m[1]);
  assert.ok(specs.length > 0);
  for (const spec of specs) assert.match(spec, /^\.\.\/(types|money|dates)$/);
  assert.doesNotMatch(src, /require\(/);
});
