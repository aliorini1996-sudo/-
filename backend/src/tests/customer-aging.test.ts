// «عمر الدين» في تقرير أرصدة العملاء (طلب المالك ٢٣ نوفمبر ٢٠٢٦): الدالّة الصرفة customerAging ثم القراءة loadCustomerAging
// فوق قاعدةٍ مزيّفة في الذاكرة، ثم ربطها بمسار GET /reports/balances.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bandOf, customerAging, dueDayOf, installmentPieces, type DatedDebt } from '../services/customerAging';
import { AGING_ID_CHUNK, isImportMoment, loadCustomerAging } from '../services/customerAgingDb';

const TODAY = '2026-11-23';
const inv = (day: string, amount: number, dueDay: string | null = null): DatedDebt => ({ day, amount, dueDay });
const sumBands = (b: Record<string, number>) => Object.values(b).reduce((s, x) => s + x, 0);

test('الشرائح: ٠–٣٠ ثم ٣١–٦٠ ثم ٦١–٩٠ ثم أكثر من ٩٠ — الحدود داخل شريحتها الأدنى', () => {
  assert.deepEqual([0, 30, 31, 60, 61, 90, 91, 400].map(bandOf),
    ['d0_30', 'd0_30', 'd31_60', 'd31_60', 'd61_90', 'd61_90', 'd90_plus', 'd90_plus']);
});

test('رصيدٌ صفر أو دائن أو غير رقمي ⇒ لا عمر (null)، ويومٌ غير صالح ⇒ null', () => {
  assert.equal(customerAging({ balance: 0, openInvoices: [inv('2026-11-01', 100)], today: TODAY }), null);
  assert.equal(customerAging({ balance: -50, openInvoices: [], today: TODAY }), null);
  assert.equal(customerAging({ balance: 5e-7, openInvoices: [], today: TODAY }), null);
  assert.equal(customerAging({ balance: Number.NaN, openInvoices: [], today: TODAY }), null);
  assert.equal(customerAging({ balance: 100, openInvoices: [inv('2026-11-01', 100)], today: '2026-13-01' }), null);
});

test('الفواتير المفتوحة تساوي الرصيد: كلٌّ في شريحته بعمره، والعمر من أقدمها', () => {
  const a = customerAging({
    balance: 1000,
    openInvoices: [inv('2026-11-20', 300), inv('2026-08-01', 200), inv('2026-10-01', 500)],
    today: TODAY,
  })!;
  assert.equal(a.oldestDay, '2026-08-01');
  assert.equal(a.ageDays, 114);
  assert.deepEqual(a.bands, { d0_30: 300, d31_60: 500, d61_90: 0, d90_plus: 200 });
  assert.equal(a.undated, 0);
  assert.equal(sumBands(a.bands), 1000);
});

test('فاتورة اليوم عمرها صفر وليست متأخّرة، وفاتورةٌ من المستقبل (تاريخٌ مقدَّم) عمرها صفر لا سالب', () => {
  const a = customerAging({ balance: 100, openInvoices: [inv(TODAY, 100)], today: TODAY })!;
  assert.equal(a.ageDays, 0);
  assert.equal(a.overdueDays, 0);
  assert.equal(a.overdueAmount, 0);
  const f = customerAging({ balance: 100, openInvoices: [inv('2026-12-05', 100)], today: TODAY })!;
  assert.equal(f.ageDays, 0);
  assert.equal(f.bands.d0_30, 100);
});

test('سندٌ غير موزَّع (الرصيد أقل من المفتوح): الفرق يُطفئ الأقدم أولاً فيصير العمر من الأحدث الباقي', () => {
  // مفتوح ١٥٠٠ والرصيد ٥٠٠: سندٌ بألفٍ لم يُوزَّع ⇒ يُطفئ فاتورة أغسطس (١٠٠٠) كلها، ويبقى نوفمبر
  const a = customerAging({ balance: 500, openInvoices: [inv('2026-08-01', 1000), inv('2026-11-10', 500)], today: TODAY })!;
  assert.equal(a.oldestDay, '2026-11-10');
  assert.equal(a.ageDays, 13);
  assert.deepEqual(a.bands, { d0_30: 500, d31_60: 0, d61_90: 0, d90_plus: 0 });
  // وإطفاءٌ جزئيّ للأقدم: يبقى منه الفرق في شريحته
  const b = customerAging({ balance: 1200, openInvoices: [inv('2026-08-01', 1000), inv('2026-11-10', 500)], today: TODAY })!;
  assert.equal(b.oldestDay, '2026-08-01');
  assert.deepEqual(b.bands, { d0_30: 500, d31_60: 0, d61_90: 0, d90_plus: 700 });
  assert.equal(sumBands(b.bands), 1200);
});

test('رصيدٌ افتتاحيّ ليس على فاتورة: يُؤرَّخ بقيود التسوية المدينة من الأحدث إلى الأقدم، والباقي «بلا تاريخ»', () => {
  // فاتورة ٣٠٠ والرصيد ١٠٠٠ ⇒ ٧٠٠ ليست على فاتورة؛ قيدا تسوية: ٥٠٠ (يناير) و٤٠٠ (مارس) ⇒ مارس كلّه ثم ٣٠٠ من يناير
  const a = customerAging({
    balance: 1000,
    openInvoices: [inv('2026-11-01', 300)],
    adjustments: [inv('2026-01-15', 500), inv('2026-03-01', 400)],
    today: TODAY,
  })!;
  assert.equal(a.oldestDay, '2026-01-15');
  assert.deepEqual(a.bands, { d0_30: 300, d31_60: 0, d61_90: 0, d90_plus: 700 });
  assert.equal(a.undated, 0);
  // تسويةٌ لا تكفي ⇒ الباقي بلا تاريخ، ولا يُخترع له يوم
  const b = customerAging({ balance: 1000, openInvoices: [inv('2026-11-01', 300)], adjustments: [inv('2026-10-01', 200)], today: TODAY })!;
  assert.equal(b.undated, 500);
  assert.equal(sumBands(b.bands) + b.undated, 1000);
  // ولا فواتير ولا تسويات: الرصيد كلّه بلا تاريخ، والعمر مجهول لا صفر
  const c = customerAging({ balance: 250, openInvoices: [], today: TODAY })!;
  assert.equal(c.oldestDay, null);
  assert.equal(c.ageDays, null);
  assert.equal(c.undated, 250);
});

test('التأخّر من يوم الاستحقاق: أقدم استحقاقٍ فات، ومبلغ المتأخّر وحده', () => {
  const a = customerAging({
    balance: 900,
    openInvoices: [inv('2026-10-01', 400, '2026-10-31'), inv('2026-11-15', 500, '2026-12-15')],
    today: TODAY,
  })!;
  assert.equal(a.ageDays, 53);
  assert.equal(a.overdueDays, 23);
  assert.equal(a.overdueAmount, 400);
  // استحقاقٌ اليوم ليس متأخّراً بعد
  const b = customerAging({ balance: 100, openInvoices: [inv('2026-10-24', 100, TODAY)], today: TODAY })!;
  assert.equal(b.overdueDays, 0);
  assert.equal(b.overdueAmount, 0);
});

test('غبار العائمة: مجموع الشرائح يساوي الرصيد بستّ منازل، ولا شريحة بكسورٍ سالبة', () => {
  const a = customerAging({ balance: 0.3, openInvoices: [inv('2026-11-01', 0.1), inv('2026-11-02', 0.2)], today: TODAY })!;
  assert.equal(a.bands.d0_30, 0.3);
  const b = customerAging({ balance: 100.004, openInvoices: [inv('2026-11-01', 100.001), inv('2026-11-02', 0.004)], today: TODAY })!;
  assert.ok(Object.values(b.bands).every((x) => x >= 0));
  assert.equal(Math.round((sumBands(b.bands) + b.undated) * 1e6) / 1e6, 100.004);
});

test('يوم الاستحقاق: الصريح يغلب، وإلا يوم الدين + مهلة العميل، والمهلة غير الرقمية أو السالبة صفر', () => {
  assert.equal(dueDayOf('2026-11-01', '2026-11-10', 30), '2026-11-10');
  assert.equal(dueDayOf('2026-11-01', null, 30), '2026-12-01');
  assert.equal(dueDayOf('2026-11-01', null, '15'), '2026-11-16');
  assert.equal(dueDayOf('2026-11-01', null, -5), '2026-11-01');
  assert.equal(dueDayOf('2026-11-01', null, 'x'), '2026-11-01');
  assert.equal(dueDayOf('2026-11-01', undefined, null), '2026-11-01');
});

// ═══════════════ القراءة من القاعدة ═══════════════

interface FakeInstallment { seq: number; dueDate: Date; amount: number }
interface FakeInvoice {
  tenantId: string; customerId: string; status: string; type: string; remainingAmt: number; invoiceDate: Date; dueDate: Date | null;
  total?: number; installments?: FakeInstallment[];
}
interface FakeEntry { id?: string; tenantId: string; customerId: string; type: string; debit: number; entryDate: Date; description?: string }
interface FakeAdjustment { id: string; tenantId: string; customerId: string; kind: string; status: string; reverseEntryId: string | null }

function fakeDb(invoices: FakeInvoice[], entries: FakeEntry[] = [], adjustments: FakeAdjustment[] = []) {
  const calls = { invoice: [] as any[], accountEntry: [] as any[], customerAdjustment: [] as any[] };
  const db = {
    invoice: {
      findMany: async (args: any) => {
        calls.invoice.push(args);
        const w = args.where;
        return invoices
          .filter((i) => i.tenantId === w.tenantId && w.customerId.in.includes(i.customerId) && i.status === w.status && i.type === w.type && i.remainingAmt > w.remainingAmt.gt)
          .map((i) => ({
            customerId: i.customerId, invoiceDate: i.invoiceDate, dueDate: i.dueDate, remainingAmt: i.remainingAmt, total: i.total ?? i.remainingAmt,
            installments: [...(i.installments ?? [])].sort((a, b) => a.seq - b.seq),
          }));
      },
    },
    accountEntry: {
      findMany: async (args: any) => {
        calls.accountEntry.push(args);
        const w = args.where;
        return entries
          .filter((e) => e.tenantId === w.tenantId && w.customerId.in.includes(e.customerId) && e.type === w.type && e.debit > w.debit.gt)
          .map((e, i) => ({ id: e.id ?? `e${i}`, customerId: e.customerId, entryDate: e.entryDate, debit: e.debit, description: e.description ?? 'تسوية' }));
      },
    },
    customerAdjustment: {
      findMany: async (args: any) => {
        calls.customerAdjustment.push(args);
        const w = args.where;
        return adjustments
          .filter((a) => a.tenantId === w.tenantId && w.customerId.in.includes(a.customerId) && (w.status === undefined || a.status === w.status))
          .map((a) => ({ id: a.id, kind: a.kind, status: a.status, reverseEntryId: a.reverseEntryId }));
      },
    },
  };
  return { db: db as any, calls };
}

const NOW = new Date('2026-11-23T09:00:00Z'); // ١٢ ظهراً بتوقيت الرياض

test('القراءة: الفواتير الآجلة المؤكَّدة المفتوحة للشركة وحدها، بيومها بتوقيت الشركة، والاستحقاق بمهلة العميل', async () => {
  const { db, calls } = fakeDb([
    // ٢٢:٣٠ UTC يوم ٣١ أكتوبر = ١ نوفمبر في الرياض — يومها بتوقيت الشركة لا UTC
    { tenantId: 't1', customerId: 'c1', status: 'CONFIRMED', type: 'CREDIT', remainingAmt: 400, invoiceDate: new Date('2026-10-31T22:30:00Z'), dueDate: null },
    { tenantId: 't1', customerId: 'c1', status: 'CANCELLED', type: 'CREDIT', remainingAmt: 999, invoiceDate: new Date('2026-01-01T09:00:00Z'), dueDate: null },
    { tenantId: 't1', customerId: 'c1', status: 'CONFIRMED', type: 'CASH', remainingAmt: 999, invoiceDate: new Date('2026-01-01T09:00:00Z'), dueDate: null },
    { tenantId: 't2', customerId: 'c1', status: 'CONFIRMED', type: 'CREDIT', remainingAmt: 999, invoiceDate: new Date('2026-01-01T09:00:00Z'), dueDate: null },
  ]);
  const m = await loadCustomerAging(db, 't1', [{ id: 'c1', balance: 400, paymentDays: 10 }], 'Asia/Riyadh', NOW);
  const a = m.get('c1')!;
  assert.equal(a.oldestDay, '2026-11-01');
  assert.equal(a.ageDays, 22);
  assert.equal(a.overdueDays, 12, 'الاستحقاق ١١ نوفمبر (١ نوفمبر + ١٠ أيام)');
  assert.equal(a.bands.d0_30, 400);
  assert.equal(calls.accountEntry.length, 0, 'الرصيد يساوي المفتوح ⇒ لا قراءة لقيود التسوية');
  assert.deepEqual(calls.invoice[0].where.status, 'CONFIRMED');
  assert.deepEqual(calls.invoice[0].where.type, 'CREDIT');
});

test('القراءة: غير المدين لا يُستعلم عنه ولا مفتاح له، وقيود التسوية تُقرأ لمن رصيده أكبر من فواتيره وحده', async () => {
  const { db, calls } = fakeDb(
    [{ tenantId: 't1', customerId: 'c1', status: 'CONFIRMED', type: 'CREDIT', remainingAmt: 100, invoiceDate: new Date('2026-11-10T09:00:00Z'), dueDate: null }],
    [
      { tenantId: 't1', customerId: 'c2', type: 'ADJUSTMENT_DEBIT', debit: 800, entryDate: new Date('2026-02-01T09:00:00Z') },
      { tenantId: 't1', customerId: 'c2', type: 'ADJUSTMENT_CREDIT', debit: 0, entryDate: new Date('2026-03-01T09:00:00Z') },
    ],
  );
  const m = await loadCustomerAging(db, 't1', [
    { id: 'c1', balance: 100 },
    { id: 'c2', balance: 800 },
    { id: 'c3', balance: 0 },
    { id: 'c4', balance: -20 },
  ], 'Asia/Riyadh', NOW);
  assert.equal(m.has('c3'), false);
  assert.equal(m.has('c4'), false);
  assert.deepEqual(calls.invoice[0].where.customerId.in, ['c1', 'c2']);
  assert.deepEqual(calls.accountEntry[0].where.customerId.in, ['c2']);
  assert.equal(calls.accountEntry[0].where.type, 'ADJUSTMENT_DEBIT');
  assert.equal(m.get('c2')!.oldestDay, '2026-02-01');
  assert.equal(m.get('c2')!.bands.d90_plus, 800);
});

test('القراءة: لا مدين ⇒ لا استعلام أصلاً، وكثرة العملاء تُقسَّم دفعاتٍ في IN', async () => {
  const none = fakeDb([]);
  const empty = await loadCustomerAging(none.db, 't1', [{ id: 'c1', balance: 0 }], 'Asia/Riyadh', NOW);
  assert.equal(empty.size, 0);
  assert.equal(none.calls.invoice.length, 0);
  const many = fakeDb([]);
  const ids = Array.from({ length: AGING_ID_CHUNK * 2 + 5 }, (_, i) => ({ id: `c${i}`, balance: 10 }));
  const m = await loadCustomerAging(many.db, 't1', ids, 'Asia/Riyadh', NOW);
  assert.equal(many.calls.invoice.length, 3);
  assert.ok(many.calls.invoice.every((c: any) => c.where.customerId.in.length <= AGING_ID_CHUNK));
  assert.equal(m.size, ids.length);
  assert.equal(m.get('c0')!.undated, 10, 'مدينٌ بلا فواتير ولا تسويات: رصيده بلا تاريخ');
});

// ═══════════════ إصلاحات المراجعة (٢٣ نوفمبر ٢٠٢٦) ═══════════════

const monthly = (n: number, amount: number, firstDue: string): FakeInstallment[] =>
  Array.from({ length: n }, (_, i) => {
    const d = new Date(`${firstDue}T09:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + i);
    return { seq: i + 1, dueDate: d, amount };
  });

test('التقسيط: متبقّي الفاتورة على أقساطها — المتأخّر ما فات استحقاقه منها لا صفر حتى آخر قسط، والعمر والشرائح بيوم الفاتورة', async () => {
  // ١٢٬٠٠٠ بتاريخ ١ يناير، ١٢ قسطاً شهرياً من ١ فبراير (آخرها ١ يناير ٢٠٢٧ = dueDate الفاتورة)، لا سداد، اليوم ٢٣ نوفمبر
  const inv = (remainingAmt: number): FakeInvoice => ({
    tenantId: 't1', customerId: 'c1', status: 'CONFIRMED', type: 'CREDIT', remainingAmt, total: 12000,
    invoiceDate: new Date('2026-01-01T09:00:00Z'), dueDate: new Date('2027-01-01T09:00:00Z'), installments: monthly(12, 1000, '2026-02-01'),
  });
  const none = await loadCustomerAging(fakeDb([inv(12000)]).db, 't1', [{ id: 'c1', balance: 12000 }], 'Asia/Riyadh', NOW);
  const a = none.get('c1')!;
  assert.equal(a.overdueAmount, 10000, 'عشرة أقساط فات استحقاقها (فبراير..نوفمبر)');
  assert.equal(a.overdueDays, 295, 'من ١ فبراير');
  assert.equal(a.ageDays, 326);
  assert.equal(a.bands.d90_plus, 12000, 'الشرائح بيوم الفاتورة كما هي');
  // سدادٌ جزئيّ ٢٬٥٠٠ يُطفئ القسطين الأولين ونصف الثالث ⇒ المتأخّر ٧٬٥٠٠ من استحقاق الثالث (١ أبريل)
  const part = (await loadCustomerAging(fakeDb([inv(9500)]).db, 't1', [{ id: 'c1', balance: 9500 }], 'Asia/Riyadh', NOW)).get('c1')!;
  assert.equal(part.overdueAmount, 7500);
  assert.equal(part.overdueDays, 236);
  assert.equal(part.bands.d90_plus, 9500);
});

test('التقسيط (صرف): مجموع الأجزاء = المتبقّي دائماً — أقساطٌ أقلّ أو أكثر من الإجمالي، وبلا أقساطٍ صالحة استحقاق الفاتورة', () => {
  const sum = (ds: DatedDebt[]) => Math.round(ds.reduce((s, d) => s + d.amount, 0) * 1e6) / 1e6;
  const ins = [{ dueDay: '2026-02-01', amount: 500 }, { dueDay: '2026-03-01', amount: 500 }];
  assert.equal(sum(installmentPieces('2026-01-01', 1200, 1200, ins, '2026-03-01')), 1200, 'الأقساط أقل من الإجمالي');
  assert.equal(sum(installmentPieces('2026-01-01', 800, 800, ins, '2026-03-01')), 800, 'الأقساط أكثر من الإجمالي');
  assert.deepEqual(installmentPieces('2026-01-01', 1000, 1000, [], '2026-03-01'), [{ day: '2026-01-01', amount: 1000, dueDay: '2026-03-01' }]);
  assert.deepEqual(installmentPieces('2026-01-01', 1000, 0, ins, null), []);
  const p = installmentPieces('2026-01-01', 1000, 600, ins, null);
  assert.deepEqual(p.map((d) => [d.dueDay, d.amount]), [['2026-02-01', 100], ['2026-03-01', 500]], 'المسدَّد يُطفئ الأقساط بترتيبها');
});

test('إلغاء شطب ذمة: الصفّ العاكس لا يؤرّخ الدين المستعاد بيوم الإلغاء — يبقى بيوم الرصيد الافتتاحي', async () => {
  // افتتاحيّ ٥٠٠٠ بتاريخ ١ يونيو ٢٠٢٥ (منتصف ليل الرياض)، شُطب ثم أُلغي الشطب في ٢٠ نوفمبر ٢٠٢٦
  const entries: FakeEntry[] = [
    { id: 'open', tenantId: 't1', customerId: 'c1', type: 'ADJUSTMENT_DEBIT', debit: 5000, entryDate: new Date('2025-05-31T21:00:00Z'), description: 'رصيد افتتاحي' },
    { id: 'rev', tenantId: 't1', customerId: 'c1', type: 'ADJUSTMENT_DEBIT', debit: 5000, entryDate: new Date('2026-11-20T10:00:00Z'), description: 'إلغاء شطب ذمة' },
  ];
  const adjs: FakeAdjustment[] = [{ id: 'wo', tenantId: 't1', customerId: 'c1', kind: 'BAD_DEBT_WRITEOFF', status: 'CANCELLED', reverseEntryId: 'rev' }];
  const { db, calls } = fakeDb([], entries, adjs);
  const a = (await loadCustomerAging(db, 't1', [{ id: 'c1', balance: 5000 }], 'Asia/Riyadh', NOW)).get('c1')!;
  assert.equal(a.oldestDay, '2025-06-01');
  assert.equal(a.bands.d90_plus, 5000);
  assert.ok(a.overdueDays > 500);
  assert.equal(calls.customerAdjustment[0].select.status, true, 'كل تسويات العميل: اليدويّ يُعرف بها والملغى منها يُتخطّى');
  // وردّ رصيدٍ دائنٍ ملغى: قيده المدين لا يؤرّخ شيئاً (معرّف التسوية = معرّف قيدها)
  const refund = fakeDb([], [
    { id: 'old', tenantId: 't1', customerId: 'c2', type: 'ADJUSTMENT_DEBIT', debit: 300, entryDate: new Date('2026-01-09T21:00:00Z'), description: 'تسوية' },
    { id: 'rf', tenantId: 't1', customerId: 'c2', type: 'ADJUSTMENT_DEBIT', debit: 300, entryDate: new Date('2026-11-19T10:00:00Z'), description: 'ردّ رصيد دائن' },
  ], [{ id: 'rf', tenantId: 't1', customerId: 'c2', kind: 'CREDIT_REFUND', status: 'CANCELLED', reverseEntryId: 'rfx' }]);
  const b = (await loadCustomerAging(refund.db, 't1', [{ id: 'c2', balance: 300 }], 'Asia/Riyadh', NOW)).get('c2')!;
  assert.equal(b.oldestDay, '2026-01-10');
});

test('قيدٌ مستورد بلا تاريخ (لحظة الاستيراد): «بلا تاريخ» لا عمرَ من يوم الاستيراد — والمؤرَّخ صراحةً بيومه', async () => {
  const opening = (debit: number, at: string): FakeEntry => ({ tenantId: 't1', customerId: 'c1', type: 'ADJUSTMENT_DEBIT', debit, entryDate: new Date(at), description: 'رصيد افتتاحي' });
  const inv: FakeInvoice = { tenantId: 't1', customerId: 'c1', status: 'CONFIRMED', type: 'CREDIT', remainingAmt: 300, invoiceDate: new Date('2026-11-10T09:00:00Z'), dueDate: null };
  // استُورد ١ نوفمبر ١٤:٣٧ بلا تاريخ
  const u = (await loadCustomerAging(fakeDb([inv], [opening(5000, '2026-11-01T11:37:12.345Z')]).db, 't1', [{ id: 'c1', balance: 5300 }], 'Asia/Riyadh', NOW)).get('c1')!;
  assert.equal(u.undated, 5000);
  assert.equal(u.oldestDay, '2026-11-10', 'العمر من المؤرَّخ وحده');
  assert.equal(u.bands.d0_30, 300);
  // بتاريخٍ صريح: منتصف ليل الرياض، أو منتصف ليل UTC لشركةٍ بلا منطقة دفاتر، أو منتصف ليل دبي (منطقة الكاتب غير منطقة التقرير)
  // — مؤرَّخٌ أيّاً كانت المنطقة التي كُتب بها
  for (const at of ['2025-12-31T21:00:00.000Z', '2026-01-01T00:00:00.000Z', '2025-12-31T20:00:00.000Z']) {
    const d = (await loadCustomerAging(fakeDb([inv], [opening(5000, at)]).db, 't1', [{ id: 'c1', balance: 5300 }], 'Asia/Riyadh', NOW)).get('c1')!;
    assert.equal(d.undated, 0, at);
    assert.equal(d.bands.d90_plus, 5000, at);
  }
  // صفّ كشف حسابٍ مستورد (/import/ledger، وصفه حرّ لا «رصيد افتتاحي») بلا تاريخ: بلا تاريخ أيضاً
  const ledgerRow: FakeEntry = { tenantId: 't1', customerId: 'c1', type: 'ADJUSTMENT_DEBIT', debit: 2000, entryDate: new Date('2026-11-20T07:15:42.118Z'), description: 'قيد مستورد' };
  const l = (await loadCustomerAging(fakeDb([], [ledgerRow]).db, 't1', [{ id: 'c1', balance: 2000 }], 'Asia/Riyadh', NOW)).get('c1')!;
  assert.equal(l.undated, 2000);
  assert.equal(l.ageDays, null);
  assert.equal(l.overdueAmount, 0, 'لا تأخّر مخترع من يوم الاستيراد');
  // وردّ رصيدٍ دائنٍ يدويّ نشط بلحظته (لا منتصف ليل): تسويةٌ يدوية تُؤرَّخ بيومها لا «بلا تاريخ»
  const refund = fakeDb([], [{ id: 'rf1', tenantId: 't1', customerId: 'c1', type: 'ADJUSTMENT_DEBIT', debit: 400, entryDate: new Date('2026-11-21T08:42:17.555Z'), description: 'ردّ رصيد دائن' }],
    [{ id: 'rf1', tenantId: 't1', customerId: 'c1', kind: 'CREDIT_REFUND', status: 'ACTIVE', reverseEntryId: null }]);
  const r = (await loadCustomerAging(refund.db, 't1', [{ id: 'c1', balance: 400 }], 'Asia/Riyadh', NOW)).get('c1')!;
  assert.equal(r.undated, 0);
  assert.equal(r.oldestDay, '2026-11-21');
  // حدّ ربع الساعة: لحظةٌ بالملّي ثانية ليست عليه، وكل منتصف ليلٍ لمنطقةٍ حقيقية عليه (فروق المناطق مضاعفات ربع ساعة)
  assert.equal(isImportMoment(new Date('2026-11-01T11:37:12.345Z')), true);
  for (const at of ['2026-01-01T00:00:00Z', '2025-12-31T21:00:00Z', '2025-12-31T18:30:00Z', '2026-01-01T05:45:00Z']) {
    assert.equal(isImportMoment(new Date(at)), false, at);
  }
});

test('المسار: GET /reports/balances يضمّ aging لكل صفّ (null لغير المدين) من loadCustomerAging بمنطقة الشركة', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'reports.ts'), 'utf8');
  const start = src.indexOf("router.get('/balances'");
  const end = src.indexOf('router.get(', start + 10);
  const handler = src.slice(start, end);
  assert.match(handler, /loadCustomerAging\(prisma, tid, result, await tenantTz\(tid\)\)/);
  assert.match(handler, /aging: aging\.get\(c\.id\) \?\? null/);
});
