// M1 — builder فواتير المبيعات (DESIGN.md §5.5 P1–P4، §2.2 الأوزان والخصم، §4.4 سطر العلامة).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildInvoiceMove, invertInvoiceDraft, invoiceItemWeights, invoicePayloadFromRows, resolveInvoiceItemTax,
  type InvoiceKind, type InvoicePayload, type InvoicePayloadItem,
} from '../services/gl/builders/invoice';
import { isNoMove, type BuildContext, type BuildResult, type LineDraft, type MoveDraft, type VatCategory } from '../services/gl/types';
import { validateMove, resolveLineAccount } from '../services/gl/validate';
import { toMilli } from '../services/gl/money';
import { accountIdOf, genericContext, saContext, taxIdOf } from '../services/gl/testing/fixtures';
import { computeInvoiceTotals } from '../lib/invoiceCalc';
import {
  postCashInvoiceEntries, postInvoiceEntries, postReturnEntries,
  reverseCashInvoiceEntries, reverseInvoiceEntries, reverseReturnEntries,
} from '../services/accounting';

// ═══ أدوات ═══

interface RawItem {
  qty: number; unitPrice: number; discountPct?: number; taxPct: number;
  categoryId?: string; vatCategory?: VatCategory; taxKey?: string;
}

function invoice(
  type: InvoiceKind, raw: RawItem[],
  o: { inclusive?: boolean; headPct?: number; decimals?: number; currency?: string; rep?: boolean; dueDate?: string } = {},
): InvoicePayload {
  const dec = o.decimals ?? 2;
  const calc = computeInvoiceTotals(
    raw.map((r) => ({ qty: r.qty, unitPrice: r.unitPrice, discountPct: r.discountPct ?? 0, taxPct: r.taxPct })),
    { companyVat: 15, decimals: dec, invoiceDiscountPct: o.headPct ?? 0, pricesIncludeTax: !!o.inclusive },
  );
  const p = invoicePayloadFromRows({
    invoice: {
      id: 'inv1', number: type === 'RETURN' ? 'RET-0001' : 'INV-0001', type, customerId: 'cust1',
      salesRepId: o.rep === false ? null : 'rep1', pricesIncludeTax: !!o.inclusive,
      subtotal: calc.subtotal, discountAmt: calc.discountAmt, taxAmt: calc.taxAmt, total: calc.total,
    },
    items: calc.items.map((it, i) => ({
      productId: `p${i}`, categoryId: raw[i].categoryId ?? null, qty: it.qty, unitPrice: it.unitPrice,
      taxPct: it.taxPct, taxAmt: it.taxAmt, lineTotal: it.lineTotal, vatCategory: raw[i].vatCategory ?? null,
    })),
    customerName: 'مؤسسة النور', salesRepName: 'خالد', entryDate: '2026-09-10', dueDate: o.dueDate ?? null,
    currency: o.currency ?? 'SAR', currencyDecimals: dec,
  });
  return {
    ...p,
    items: p.items.map((it, i) => (raw[i].taxKey ? { ...it, taxKey: raw[i].taxKey } : it)),
  };
}

function asMove(r: BuildResult): MoveDraft {
  assert.equal(r.kind, 'MOVE', 'المتوقع قيد لا NO_MOVE');
  return r as MoveDraft;
}

/** يتحقق (validate.ts) ويفحص قواعد G6/G7 ويعيد القيد. */
function checked(r: BuildResult, ctx: BuildContext): MoveDraft {
  const m = asMove(r);
  const v = validateMove(m, ctx);
  assert.equal(v.totalDebitMilli, v.totalCreditMilli);
  assert.match(m.narration, /[؀-ۿ]/);
  for (const l of m.lines) {
    assert.match(l.label, /[؀-ۿ]/, 'label عربي غير فارغ');
    if (l.customerId || l.vendorId || l.salesRepId) assert.ok(l.partnerName && l.partnerName.trim() !== '', `partnerName على ${l.label}`);
  }
  return m;
}

const code = (l: LineDraft, ctx: BuildContext) => resolveLineAccount(l, ctx.accounts)?.code;
const on = (m: MoveDraft, ctx: BuildContext, c: string) => m.lines.filter((l) => code(l, ctx) === c);
const net = (ls: LineDraft[]) => ls.reduce((a, l) => a + l.debitMilli - l.creditMilli, 0n);
const M = (x: number | string, dec = 2) => toMilli(x, dec);

// ═══ AccountEntry المكافئة: تشغيل accounting.ts على معاملة مزيّفة في الذاكرة ═══

async function accountEntriesFor(p: InvoicePayload, reverse = false): Promise<{ debit: number; credit: number }[]> {
  const rows: { debit: number; credit: number }[] = [];
  const tx = {
    accountEntry: {
      aggregate: async () => ({ _sum: { debit: rows.reduce((a, r) => a + r.debit, 0), credit: rows.reduce((a, r) => a + r.credit, 0) } }),
      create: async ({ data }: { data: { debit: number; credit: number } }) => { rows.push({ debit: data.debit, credit: data.credit }); return data; },
    },
    customer: { update: async () => ({}) },
  } as never;
  const total = Number(p.total);
  if (!reverse) {
    if (p.type === 'RETURN') await postReturnEntries(tx, 't', p.invoiceId, p.customerId, total);
    else if (p.type === 'CASH') await postCashInvoiceEntries(tx, 't', p.invoiceId, p.customerId, total);
    else await postInvoiceEntries(tx, 't', p.invoiceId, p.customerId, total);
  } else {
    if (p.type === 'RETURN') await reverseReturnEntries(tx, 't', p.invoiceId, p.customerId, total);
    else if (p.type === 'CASH') await reverseCashInvoiceEntries(tx, 't', p.invoiceId, p.customerId, total);
    else await reverseInvoiceEntries(tx, 't', p.invoiceId, p.customerId, total);
  }
  return rows;
}

async function assertArParity(p: InvoicePayload, m: MoveDraft, ctx: BuildContext, reverse = false) {
  const rows = await accountEntriesFor(p, reverse);
  const ar = on(m, ctx, '113001');
  const dec = p.currencyDecimals;
  assert.equal(net(ar), rows.reduce((a, r) => a + M(r.debit, dec) - M(r.credit, dec), 0n), 'صافي الذمة = صافي AccountEntry');
  // صفاً بصف: نفس المبالغ المدينة والدائنة
  const sortKey = (xs: [bigint, bigint][]) => xs.map(([d, c]) => `${d}/${c}`).sort();
  assert.deepEqual(sortKey(ar.map((l) => [l.debitMilli, l.creditMilli])), sortKey(rows.map((r) => [M(r.debit, dec), M(r.credit, dec)])));
  for (const l of ar) assert.equal(l.customerId, p.customerId);
}

// ═══ P1 آجل ═══

test('P1 آجل غير شامل بخصم بند ورأس: ذمة=total، إيراد=subtotal، خصم=discountAmt، ضريبة=taxAmt على SA_1', async () => {
  const ctx = saContext();
  const p = invoice('CREDIT', [{ qty: 3, unitPrice: 100, discountPct: 10, taxPct: 15 }, { qty: 2, unitPrice: 45.5, taxPct: 15 }],
    { headPct: 5, dueDate: '2026-10-10' });
  const m = checked(buildInvoiceMove(p, ctx), ctx);
  assert.equal(m.moveType, 'OUT_INVOICE');
  assert.equal(m.journalCode, 'INV');
  assert.equal(m.sequencePrefix, 'INV');
  assert.equal(m.origin, 'AUTO');
  assert.equal(m.date, '2026-09-10');
  assert.equal(m.sourceKey, 'INVOICE:inv1:POST');
  assert.equal(m.sourceType, 'INVOICE');
  assert.equal(m.needsAttention, false);
  const ar = on(m, ctx, '113001');
  assert.equal(ar.length, 1);
  assert.equal(ar[0].debitMilli, M(p.total));
  assert.equal(ar[0].dueDate, '2026-10-10');
  assert.equal(ar[0].salesRepId, 'rep1');
  assert.equal(-net(on(m, ctx, '411001')), M(p.subtotal));
  assert.equal(net(on(m, ctx, '413001')), M(p.discountAmt));
  const tax = on(m, ctx, '212001');
  assert.equal(tax.length, 1);
  assert.equal(tax[0].creditMilli, M(p.taxAmt));
  assert.equal(tax[0].taxRole, 'TAX');
  assert.equal(tax[0].taxId, taxIdOf('S15_SALE'));
  assert.equal(tax[0].vatBox, 'SA_1');
  assert.equal(tax[0].taxBaseMilli, M(p.subtotal) - M(p.discountAmt));
  assert.equal(on(m, ctx, '421009').length + on(m, ctx, '911001').length, 0);
  await assertArParity(p, m, ctx);
});

test('P1 شامل الضريبة (تطبيق المندوب): متوازن بلا تقريب ولا معلّق، والوعاء × 15٪ = الضريبة تقريباً', async () => {
  const ctx = saContext();
  const p = invoice('CREDIT', [{ qty: 7, unitPrice: 11.5, discountPct: 3, taxPct: 15 }, { qty: 1, unitPrice: 33.33, taxPct: 15 }],
    { inclusive: true, headPct: 2 });
  const m = checked(buildInvoiceMove(p, ctx), ctx);
  assert.equal(on(m, ctx, '911001').length, 0);
  assert.equal(on(m, ctx, '421009').length, 0);
  assert.equal(-net(on(m, ctx, '411001')), M(p.subtotal));
  assert.equal(net(on(m, ctx, '413001')), M(p.discountAmt));
  assert.equal(-net(on(m, ctx, '212001')), M(p.taxAmt));
  assert.equal(on(m, ctx, '113001')[0].dueDate, '2026-09-10', 'الاستحقاق الافتراضي = تاريخ الفاتورة');
  await assertArParity(p, m, ctx);
});

test('P1 مع postSalesDiscountSeparately=false: إيراد صافٍ = subtotal − discountAmt ولا سطر 413001', () => {
  const ctx = saContext({ settings: { postSalesDiscountSeparately: false } });
  const p = invoice('CREDIT', [{ qty: 4, unitPrice: 25, discountPct: 20, taxPct: 15 }], { headPct: 10 });
  const m = checked(buildInvoiceMove(p, ctx), ctx);
  assert.equal(on(m, ctx, '413001').length, 0);
  assert.equal(-net(on(m, ctx, '411001')), M(p.subtotal) - M(p.discountAmt));
});

test('حساب إيراد الفئة وتحليلي المندوب: البنود تذهب لحساب الفئة و411001 للباقي', () => {
  const ctx = saContext({
    categoryAccounts: { cat1: { incomeAccountId: accountIdOf('421001'), expenseAccountId: null, cogsAccountId: null, inventoryAccountId: null } },
    repAnalytics: { rep1: 'an1' },
  });
  const p = invoice('CREDIT', [{ qty: 1, unitPrice: 100, taxPct: 15, categoryId: 'cat1' }, { qty: 1, unitPrice: 50, taxPct: 15 }]);
  const m = checked(buildInvoiceMove(p, ctx), ctx);
  assert.equal(-net(on(m, ctx, '421001')), M(100));
  assert.equal(-net(on(m, ctx, '411001')), M(50));
  for (const l of [...on(m, ctx, '421001'), ...on(m, ctx, '411001')]) {
    assert.equal(l.analyticAccountId, 'an1');
    assert.equal(l.taxRole, 'BASE');
    assert.equal(l.taxId, taxIdOf('S15_SALE'));
  }
});

// ═══ P2 نقدي ═══

test('P2 نقدي MAIN_CASH: مدين 111001 = total، والذمة تتقاصّ (مدين ودائن) كصفّي AccountEntry', async () => {
  const ctx = saContext();
  const p = invoice('CASH', [{ qty: 2, unitPrice: 57.5, taxPct: 15 }], { inclusive: true });
  const m = checked(buildInvoiceMove(p, ctx), ctx);
  assert.equal(net(on(m, ctx, '111001')), M(p.total));
  assert.equal(on(m, ctx, '111003').length, 0);
  assert.equal(net(on(m, ctx, '113001')), 0n);
  assert.equal(on(m, ctx, '113001').length, 2);
  await assertArParity(p, m, ctx);
});

test('P2 نقدي بتوجيه CUSTODY: إلى 111003 بالمندوب، وبلا مندوب إلى 111001', () => {
  const ctx = saContext({ settings: { cashInvoiceRouting: 'CUSTODY' } });
  const m1 = checked(buildInvoiceMove(invoice('CASH', [{ qty: 1, unitPrice: 100, taxPct: 15 }]), ctx), ctx);
  const cust = on(m1, ctx, '111003');
  assert.equal(cust.length, 1);
  assert.equal(cust[0].debitMilli, M(115));
  assert.equal(cust[0].salesRepId, 'rep1');
  assert.equal(cust[0].partnerName, 'خالد');
  assert.equal(on(m1, ctx, '111001').length, 0);
  const m2 = checked(buildInvoiceMove(invoice('CASH', [{ qty: 1, unitPrice: 100, taxPct: 15 }], { rep: false }), ctx), ctx);
  assert.equal(net(on(m2, ctx, '111001')), M(115));
  assert.equal(on(m2, ctx, '111003').length, 0);
});

// ═══ P3 مرتجع ═══

test('P3 مرتجع: مدين 412001 = subtotal، مدين 212001 بـvatAdjustment ووعاء سالب، دائن 413001 و113001، الرقم RINV', async () => {
  const ctx = saContext();
  const p = invoice('RETURN', [{ qty: 2, unitPrice: 80, discountPct: 5, taxPct: 15 }], { headPct: 3 });
  const m = checked(buildInvoiceMove(p, ctx), ctx);
  assert.equal(m.moveType, 'OUT_REFUND');
  assert.equal(m.sequencePrefix, 'RINV');
  assert.equal(net(on(m, ctx, '412001')), M(p.subtotal));
  assert.equal(on(m, ctx, '411001').length, 0);
  assert.equal(-net(on(m, ctx, '413001')), M(p.discountAmt));
  assert.equal(-net(on(m, ctx, '113001')), M(p.total));
  assert.equal(on(m, ctx, '113001')[0].dueDate, null);
  const tax = on(m, ctx, '212001');
  assert.equal(tax[0].debitMilli, M(p.taxAmt));
  assert.equal(tax[0].vatAdjustment, true);
  assert.equal(tax[0].taxBaseMilli, -(M(p.subtotal) - M(p.discountAmt)));
  await assertArParity(p, m, ctx);
});

test('P3 مع postReturnsToContra=false: المرتجع مدين على حساب الإيراد', () => {
  const ctx = saContext({ settings: { postReturnsToContra: false } });
  const m = checked(buildInvoiceMove(invoice('RETURN', [{ qty: 1, unitPrice: 100, taxPct: 15 }]), ctx), ctx);
  assert.equal(net(on(m, ctx, '411001')), M(100));
  assert.equal(on(m, ctx, '412001').length, 0);
});

// ═══ P4 العكس من المستند ═══

test('P4 عكس من المستند لكل نوع: قلب الجانبين وسالب الوعاء والتاريخ، ويطابق صفوف reverse* في AccountEntry', async () => {
  const ctx = saContext();
  for (const type of ['CREDIT', 'CASH', 'RETURN'] as InvoiceKind[]) {
    const p = invoice(type, [{ qty: 3, unitPrice: 19.99, discountPct: 5, taxPct: 15 }, { qty: 1, unitPrice: 10, taxPct: 0 }]);
    const post = checked(buildInvoiceMove(p, ctx), ctx);
    const rev = checked(buildInvoiceMove(p, ctx, { event: 'REVERSE', reverseDate: '2026-09-15' }), ctx);
    assert.equal(rev.date, '2026-09-15');
    assert.equal(rev.sourceEvent, 'REVERSE');
    assert.equal(rev.sourceKey, 'INVOICE:inv1:REVERSE');
    assert.equal(rev.lines.length, post.lines.length);
    rev.lines.forEach((l, i) => {
      assert.equal(l.debitMilli, post.lines[i].creditMilli);
      assert.equal(l.creditMilli, post.lines[i].debitMilli);
      if (post.lines[i].taxBaseMilli != null) assert.equal(l.taxBaseMilli, -(post.lines[i].taxBaseMilli as bigint));
    });
    await assertArParity(p, rev, ctx, true);
  }
  assert.throws(() => buildInvoiceMove(invoice('CREDIT', [{ qty: 1, unitPrice: 1, taxPct: 15 }]), ctx, { event: 'REVERSE' }), RangeError);
  const d = asMove(buildInvoiceMove(invoice('CREDIT', [{ qty: 1, unitPrice: 1, taxPct: 15 }]), ctx));
  assert.equal(invertInvoiceDraft(d, '2026-09-20').lines[0].creditMilli, d.lines[0].debitMilli);
});

/* ZATCA Z5.4 وقرار المالك Q1 (مراجعة عدائية): فاتورة نقدية رفضتها الهيئة فأُبطلت — البضاعة سُلّمت والنقد بيد
 * المندوب، فيُعكس شقّ الفاتورة وحده ويبقى المحصَّل رصيداً دائناً للعميل. لو عُكست ساق النقدية أيضاً لنقصت عهدة
 * المندوب نقداً يحمله، ولانفرج فرقٌ دائم بين حساب الذمم الرقابي ودفتر العملاء بمقدار الفاتورة. */
test('عكس نقديّ جزئيّ (Q1): بلا ساق النقدية — الذمة دائنة بالإجمالي والعهدة لا تُمسّ', () => {
  for (const routing of ['MAIN_CASH', 'CUSTODY'] as const) {
    const ctx = saContext({ settings: { cashInvoiceRouting: routing } });
    const p = invoice('CASH', [{ qty: 2, unitPrice: 50, taxPct: 15 }]);
    const full = checked(buildInvoiceMove(p, ctx, { event: 'REVERSE', reverseDate: '2026-09-15' }), ctx);
    const partial = checked(buildInvoiceMove(p, ctx, { event: 'REVERSE', reverseDate: '2026-09-15', keepCashLeg: true }), ctx);

    assert.equal(net(on(full, ctx, '113001')), 0n, 'العكس الكامل يصفّي الذمة (وهو ما لا يريده Q1)');
    assert.equal(net(on(partial, ctx, '113001')), -M(115), 'الذمة لم تبقَ دائنة بالإجمالي = رصيد العميل');
    assert.equal(on(partial, ctx, '113001').length, 1);
    assert.equal(on(partial, ctx, routing === 'CUSTODY' ? '111003' : '111001').length, 0, 'عُكست النقدية رغم بقائها بيد المندوب');
    assert.equal(partial.lines.length, full.lines.length - 2);
    // الإيراد والضريبة يُعكسان كاملين في الحالتين
    assert.equal(net(on(partial, ctx, '411001')), net(on(full, ctx, '411001')));
    assert.equal(net(on(partial, ctx, '212001')), net(on(full, ctx, '212001')));
  }
  // الترحيل لا يتأثّر بالعلم إطلاقاً (للعكس وحده)
  const ctx = saContext();
  const p = invoice('CASH', [{ qty: 1, unitPrice: 100, taxPct: 15 }]);
  const post = checked(buildInvoiceMove(p, ctx, { keepCashLeg: true }), ctx);
  assert.equal(net(on(post, ctx, '113001')), 0n);
  assert.equal(net(on(post, ctx, '111001')), M(115));
});

// ═══ العلامات الصفرية (§4.4) ═══

test('فاتورة مختلطة 15٪ + 0٪: سطر TAX للـ15 وعلامة Z_SALE على 212001 بـ0/0 والوعاء والمربع SA_3', () => {
  const ctx = saContext();
  const p = invoice('CREDIT', [{ qty: 1, unitPrice: 200, taxPct: 15 }, { qty: 3, unitPrice: 40, discountPct: 10, taxPct: 0 }]);
  const m = checked(buildInvoiceMove(p, ctx), ctx);
  const markers = m.lines.filter((l) => l.taxRole === 'MARKER');
  assert.equal(markers.length, 1);
  const mk = markers[0];
  assert.equal(code(mk, ctx), '212001');
  assert.equal(mk.debitMilli, 0n);
  assert.equal(mk.creditMilli, 0n);
  assert.equal(mk.taxId, taxIdOf('Z_SALE'));
  assert.equal(mk.vatBox, 'SA_3');
  assert.equal(mk.taxBaseMilli, M(108));
  const tax = m.lines.filter((l) => l.taxRole === 'TAX');
  assert.equal(tax.length, 1);
  assert.equal(tax[0].taxBaseMilli, M(200));
  assert.equal(tax[0].creditMilli, M(30));
  // سطور الوعاء موسومة بضريبتها
  const zeroBase = m.lines.filter((l) => l.taxRole === 'BASE' && l.taxId === taxIdOf('Z_SALE'));
  assert.equal(net(zeroBase), -M(120) + M(12));
});

test('علامات EXPORT وE_SALE وCIT_SALE السعودية على 212001 بـ0/0 مع الوعاء والمربعات SA_4 وSA_5 وSA_2', () => {
  const ctx = saContext();
  const p = invoice('CREDIT', [
    { qty: 1, unitPrice: 100, taxPct: 0, taxKey: 'EXPORT' },
    { qty: 1, unitPrice: 60, taxPct: 0, vatCategory: 'E' },
    { qty: 1, unitPrice: 30, taxPct: 0, taxKey: 'CIT_SALE' },
    { qty: 1, unitPrice: 10, taxPct: 0 },
  ]);
  const m = checked(buildInvoiceMove(p, ctx), ctx);
  const byTax = new Map(m.lines.filter((l) => l.taxRole === 'MARKER').map((l) => [l.taxId, l]));
  const expect: [string, string, number][] = [['EXPORT', 'SA_4', 100], ['E_SALE', 'SA_5', 60], ['CIT_SALE', 'SA_2', 30], ['Z_SALE', 'SA_3', 10]];
  assert.equal(byTax.size, 4);
  for (const [key, box, base] of expect) {
    const l = byTax.get(taxIdOf(key));
    assert.ok(l, `علامة ${key}`);
    assert.equal(code(l, ctx), '212001');
    assert.equal(l.debitMilli + l.creditMilli, 0n);
    assert.equal(l.vatBox, box);
    assert.equal(l.taxBaseMilli, M(base));
  }
  assert.equal(net(on(m, ctx, '212001')), 0n);
  assert.equal(m.lines.filter((l) => l.taxRole === 'TAX').length, 0);
});

test('O_SALE (خارج النطاق) لا يُصدر علامة، والعلامة لا تُصدر لضريبة صفرية غير نشطة', () => {
  const ctx = saContext();
  const m = checked(buildInvoiceMove(invoice('CREDIT', [{ qty: 1, unitPrice: 50, taxPct: 0, vatCategory: 'O' }, { qty: 1, unitPrice: 50, taxPct: 15 }]), ctx), ctx);
  assert.equal(m.lines.filter((l) => l.taxRole === 'MARKER').length, 0);
  const ctx2 = saContext({ taxes: { Z_SALE: { isActive: false } } });
  const m2 = checked(buildInvoiceMove(invoice('CREDIT', [{ qty: 1, unitPrice: 50, taxPct: 0 }, { qty: 1, unitPrice: 50, taxPct: 15 }]), ctx2), ctx2);
  assert.equal(m2.lines.filter((l) => l.taxRole === 'MARKER').length, 0);
  assert.equal(m2.lines.filter((l) => l.taxRole === 'BASE' && l.taxId == null).length, 0, 'سطر وعاء بلا ضريبة لا يحمل دور BASE');
});

test('علامة صفرية على حساب مؤرشف ⇒ LEDGER_ACCOUNT_ARCHIVED ظاهر لا تجاوز صامت', () => {
  const ctx = saContext({ accounts: { '212001': { isActive: false } } });
  const m = asMove(buildInvoiceMove(invoice('CREDIT', [{ qty: 1, unitPrice: 50, taxPct: 0 }, { qty: 1, unitPrice: 50, taxPct: 0 }]), ctx));
  assert.throws(() => validateMove(m, ctx), (e: unknown) => (e as { code?: string }).code === 'LEDGER_ACCOUNT_ARCHIVED');
});

test('مرتجع صفري: علامة بوعاء سالب وvatAdjustment', () => {
  const ctx = saContext();
  const m = checked(buildInvoiceMove(invoice('RETURN', [{ qty: 2, unitPrice: 25, taxPct: 0 }, { qty: 1, unitPrice: 40, taxPct: 15 }]), ctx), ctx);
  const mk = m.lines.filter((l) => l.taxRole === 'MARKER');
  assert.equal(mk.length, 1);
  assert.equal(mk[0].taxBaseMilli, -M(50));
  assert.equal(mk[0].vatAdjustment, true);
  assert.equal(mk[0].vatBox, 'SA_3');
});

// ═══ القالب العام ═══

test('فاتورة كويتية 0٪ (KWD، 3 منازل): تُرحَّل بلا علامة ولا سطر 212001 وtaxId=null', async () => {
  const ctx = genericContext('KW');
  const p = invoice('CREDIT', [{ qty: 3, unitPrice: 1.235, taxPct: 0 }, { qty: 1, unitPrice: 7.5, discountPct: 10, taxPct: 0 }],
    { decimals: 3, currency: 'KWD' });
  const m = checked(buildInvoiceMove(p, ctx), ctx);
  assert.equal(m.currencyCode, 'KWD');
  assert.equal(m.currencyDecimals, 3);
  assert.equal(on(m, ctx, '212001').length, 0);
  assert.equal(m.lines.filter((l) => l.taxRole != null || l.taxId != null).length, 0);
  assert.equal(m.needsAttention, false);
  assert.equal(net(on(m, ctx, '113001')), M(p.total, 3));
  await assertArParity(p, m, ctx);
});

test('فاتورة كويتية ببند 15٪: الضريبة إلى 911001 مع needsAttention لا خطأ، ولا تمس 212001 المؤرشف', () => {
  const ctx = genericContext('KW');
  const p = invoice('CREDIT', [{ qty: 2, unitPrice: 10, taxPct: 15 }, { qty: 1, unitPrice: 5, taxPct: 0 }], { decimals: 3, currency: 'KWD' });
  const r = buildInvoiceMove(p, ctx);
  const m = checked(r, ctx);
  assert.equal(m.needsAttention, true);
  assert.ok(m.attentionReason && /[؀-ۿ]/.test(m.attentionReason));
  assert.equal(on(m, ctx, '212001').length, 0);
  assert.equal(-net(on(m, ctx, '911001')), M(p.taxAmt, 3));
  assert.equal(M(p.taxAmt, 3), M(3, 3));
});

test('مصر 14٪: S14_SALE على 212001 بلا مربع', () => {
  const ctx = genericContext('EG');
  const p = invoice('CREDIT', [{ qty: 1, unitPrice: 100, taxPct: 14 }]);
  const m = checked(buildInvoiceMove(p, ctx), ctx);
  const tax = m.lines.filter((l) => l.taxRole === 'TAX');
  assert.equal(tax.length, 1);
  assert.equal(tax[0].taxId, taxIdOf('S14_SALE'));
  assert.equal(tax[0].vatBox, null);
  assert.equal(tax[0].creditMilli, M(14));
  assert.equal(m.needsAttention, false);
});

test('نسبة غير قالبية (5٪ في السعودية): AUTO_SALE_5 على 212001 بلا مربع مع تنبيه، لا رفض', () => {
  const ctx = saContext();
  const m = checked(buildInvoiceMove(invoice('CREDIT', [{ qty: 1, unitPrice: 100, taxPct: 5 }]), ctx), ctx);
  const tax = m.lines.filter((l) => l.taxRole === 'TAX');
  assert.equal(tax[0].taxCode, 'AUTO_SALE_5');
  const base = m.lines.filter((l) => l.taxRole === 'BASE');
  assert.ok(base.length > 0 && base.every((l) => l.taxCode === 'AUTO_SALE_5' && l.taxId == null));
  assert.equal(tax[0].vatBox, null);
  assert.equal(code(tax[0], ctx), '212001');
  assert.equal(m.needsAttention, true);
});

// ═══ الأوزان: المتجه الذهبي (§2.2) ═══

test('متجه ذهبي: بند 0٪ مخصوم 100٪ بجوار بند 15٪ — منفصل: إيراد 100+100، خصم 100 على سلة الصفر، علامة بوعاء 0', () => {
  const ctx = saContext();
  const p = invoice('CREDIT', [{ qty: 1, unitPrice: 100, discountPct: 100, taxPct: 0 }, { qty: 1, unitPrice: 100, taxPct: 15 }]);
  assert.equal(p.subtotal, '200.00');
  assert.equal(p.discountAmt, '100.00');
  assert.equal(p.taxAmt, '15.00');
  assert.equal(p.total, '115.00');
  const m = checked(buildInvoiceMove(p, ctx), ctx);
  const rev = on(m, ctx, '411001');
  const z = taxIdOf('Z_SALE');
  const s = taxIdOf('S15_SALE');
  assert.equal(-net(rev.filter((l) => l.taxId === z)), M(100));
  assert.equal(-net(rev.filter((l) => l.taxId === s)), M(100));
  const disc = on(m, ctx, '413001');
  assert.equal(disc.length, 1);
  assert.equal(disc[0].taxId, z);
  assert.equal(disc[0].debitMilli, M(100));
  const mk = m.lines.find((l) => l.taxRole === 'MARKER');
  assert.equal(mk?.taxBaseMilli, 0n);
  const tax = m.lines.find((l) => l.taxRole === 'TAX');
  assert.equal(tax?.taxBaseMilli, M(100));
  assert.equal(tax?.creditMilli, M(15));
  assert.equal(on(m, ctx, '113001')[0].debitMilli, M(115));
  assert.equal(on(m, ctx, '421009').length + on(m, ctx, '911001').length, 0);
});

test('متجه ذهبي في الوضع الصافي: لا إيراد لسلة الصفر، إيراد 15٪ = 100، علامة بوعاء 0', () => {
  const ctx = saContext({ settings: { postSalesDiscountSeparately: false } });
  const p = invoice('CREDIT', [{ qty: 1, unitPrice: 100, discountPct: 100, taxPct: 0 }, { qty: 1, unitPrice: 100, taxPct: 15 }]);
  const m = checked(buildInvoiceMove(p, ctx), ctx);
  const rev = on(m, ctx, '411001');
  assert.equal(rev.length, 1);
  assert.equal(rev[0].taxId, taxIdOf('S15_SALE'));
  assert.equal(rev[0].creditMilli, M(100));
  assert.equal(on(m, ctx, '413001').length, 0);
  assert.equal(m.lines.find((l) => l.taxRole === 'MARKER')?.taxBaseMilli, 0n);
  assert.equal(m.lines.find((l) => l.taxRole === 'TAX')?.taxBaseMilli, M(100));
});

test('invoiceItemWeights: الوعاء قبل الخصم في الوضعين والخصم = الوعاء − الصافي', () => {
  const ex = invoiceItemWeights({ qty: 3, unitPrice: 100, taxPct: 15, taxAmt: '40.50', lineTotal: '310.50' }, false, 2);
  assert.deepEqual(ex, { baseMilli: M(300), discMilli: M(30), netMilli: M(270) });
  const inc = invoiceItemWeights({ qty: 1, unitPrice: 115, taxPct: 15, taxAmt: '15.00', lineTotal: '115.00' }, true, 2);
  assert.deepEqual(inc, { baseMilli: M(100), discMilli: 0n, netMilli: M(100) });
});

test('resolveInvoiceItemTax: 15⇒S15_SALE، 0⇒zeroRatedSalesTaxKey، E⇒E_SALE، مفتاح صريح غير نشط يسقط للاشتقاق', () => {
  const ctx = saContext({ taxes: { EXPORT: { isActive: false } } });
  const base: InvoicePayloadItem = { qty: 1, unitPrice: 1, taxPct: 15, taxAmt: 0, lineTotal: 0 };
  assert.equal(resolveInvoiceItemTax(base, ctx)?.key, 'S15_SALE');
  assert.equal(resolveInvoiceItemTax({ ...base, taxPct: 0 }, ctx)?.key, 'Z_SALE');
  assert.equal(resolveInvoiceItemTax({ ...base, taxPct: 0, vatCategory: 'E' }, ctx)?.key, 'E_SALE');
  assert.equal(resolveInvoiceItemTax({ ...base, taxPct: 0, taxKey: 'EXPORT' }, ctx)?.key, 'Z_SALE');
  assert.equal(resolveInvoiceItemTax({ ...base, taxPct: 0 }, genericContext('KW')), null);
});

// ═══ الفواتير القديمة المخالفة ═══

test('فاتورة قديمة بفرق كبير (قبل a296b30): سطر 911001 مع needsAttention، لا رفض', async () => {
  const ctx = saContext();
  // قديماً: subtotal قبل خصم البند والإجمالي يخالف subtotal − discount + tax
  const p: InvoicePayload = {
    ...invoice('CREDIT', [{ qty: 3, unitPrice: 100, discountPct: 10, taxPct: 15 }]),
    subtotal: '300.00', discountAmt: '0.00', taxAmt: '40.50', total: '340.50',
  };
  const m = checked(buildInvoiceMove(p, ctx), ctx);
  // 340.50 − (300 − 0 + 40.50) = 0 ⇒ متّزنة بلا تنبيه؛ نصنع فرقاً حقيقياً (الإجمالي المطبوع 310.50)
  assert.equal(m.needsAttention, false);
  assert.equal(on(m, ctx, '911001').length + on(m, ctx, '421009').length, 0);
  const p2: InvoicePayload = { ...p, total: '310.50' };
  const m2 = checked(buildInvoiceMove(p2, ctx), ctx);
  assert.equal(net(on(m2, ctx, '911001')), M(30));
  assert.equal(m2.needsAttention, true);
  assert.equal(on(m2, ctx, '113001')[0].debitMilli, M('310.50'));
  await assertArParity(p2, m2, ctx);
});

test('فرق ضمن حد التقريب (≤ وحدة × عدد البنود حتى 5) ⇒ 421009 بلا تنبيه', () => {
  const ctx = saContext();
  const base = invoice('CREDIT', [{ qty: 1, unitPrice: 10, taxPct: 15 }, { qty: 1, unitPrice: 20, taxPct: 15 }]);
  const m = checked(buildInvoiceMove({ ...base, total: '34.52' }, ctx), ctx);
  assert.equal(-net(on(m, ctx, '421009')), M('0.02'));
  assert.equal(m.needsAttention, false);
  // فرق سالب ضمن الحد (بندان ⇒ 0.02) ⇒ 421009 مدين
  const m2 = checked(buildInvoiceMove({ ...base, total: '34.48' }, ctx), ctx);
  assert.equal(net(on(m2, ctx, '421009')), M('0.02'));
  assert.equal(m2.needsAttention, false);
  const m4 = checked(buildInvoiceMove({ ...base, total: '34.47' }, ctx), ctx);
  assert.equal(net(on(m4, ctx, '911001')), M('0.03'));
  assert.equal(m4.needsAttention, true);
  const m3 = checked(buildInvoiceMove({ ...base, total: '34.53' }, ctx), ctx);
  assert.equal(on(m3, ctx, '421009').length, 0);
  assert.equal(net(on(m3, ctx, '911001')), -M('0.03'));
  assert.equal(m3.needsAttention, true);
});

test('فاتورة قديمة: Σ item.taxAmt ≠ taxAmt ⇒ يُوزَّع taxAmt على النسب الموجبة بأكبر الباقي', () => {
  const ctx = saContext();
  const base = invoice('CREDIT', [{ qty: 1, unitPrice: 100, taxPct: 15 }, { qty: 1, unitPrice: 100, taxPct: 5 }]);
  const items = base.items.map((it, i) => ({ ...it, taxAmt: i === 0 ? '14.99' : '5.00' }));
  const m = checked(buildInvoiceMove({ ...base, items }, ctx), ctx);
  const taxes = m.lines.filter((l) => l.taxRole === 'TAX');
  assert.equal(taxes.reduce((a, l) => a + l.creditMilli, 0n), M(base.taxAmt));
  assert.equal(on(m, ctx, '421009').length + on(m, ctx, '911001').length, 0);
});

// ═══ الصفر ═══

test('فاتورة إجماليها صفر (سعر 0 أو خصم 100٪) ⇒ NO_MOVE(ZERO_VALUE) بلا سطر ذمة صفري، لكل الأنواع والعكس', () => {
  const ctx = saContext();
  for (const type of ['CREDIT', 'CASH', 'RETURN'] as InvoiceKind[]) {
    const r1 = buildInvoiceMove(invoice(type, [{ qty: 5, unitPrice: 0, taxPct: 15 }]), ctx);
    assert.ok(isNoMove(r1));
    assert.equal(r1.kind === 'NO_MOVE' && r1.reason, 'ZERO_VALUE');
    const r2 = buildInvoiceMove(invoice(type, [{ qty: 2, unitPrice: 30, discountPct: 100, taxPct: 15 }]), ctx);
    assert.ok(isNoMove(r2));
    assert.ok(isNoMove(buildInvoiceMove(invoice(type, [{ qty: 2, unitPrice: 30, taxPct: 15 }], { headPct: 100 }), ctx, { event: 'REVERSE', reverseDate: '2026-09-11' })));
  }
});

/** وعاء كل سطر TAX/MARKER × الإشارة = Σ(lineTotal − taxAmt) لبنود نسبته (P1: صافي النسبة بعد كل خصم) */
function assertBasePerRate(p: InvoicePayload, m: MoveDraft, where: string) {
  const dec = p.currencyDecimals;
  const sgn = p.type === 'RETURN' ? -1n : 1n;
  const netOf = (pct: number) => p.items
    .filter((it) => (Number(it.taxPct) || 0) === pct)
    .reduce((a, it) => a + M(it.lineTotal, dec) - M(it.taxAmt, dec), 0n);
  for (const l of m.lines) {
    if (l.taxRole !== 'TAX' && l.taxRole !== 'MARKER') continue;
    const pct = l.taxRole === 'MARKER' ? 0 : 15; // الخاصية تولّد 15٪ و0٪ فقط
    assert.equal((l.taxBaseMilli ?? 0n) * sgn, netOf(pct), `وعاء ${l.taxRole} ${pct}٪ = صافي بنوده (${where})`);
  }
}

test('متجه ذهبي: شامل + خصم منفصل بلا خصم رأس ⇒ وعاء 15٪ = 670.82 لا 670.83، والعلامة الصفرية بصافي بنودها', () => {
  for (const separate of [true, false]) {
    const ctx = saContext({ settings: { postSalesDiscountSeparately: separate } });
    const p = invoice('CREDIT', [
      { qty: 16, unitPrice: 83, taxPct: 0 }, { qty: 2, unitPrice: 93, taxPct: 15 },
      { qty: 12, unitPrice: 39, discountPct: 27, taxPct: 15 }, { qty: 5, unitPrice: 43, taxPct: 15 },
      { qty: 17, unitPrice: 50, taxPct: 0 }, { qty: 20, unitPrice: 98, taxPct: 0 },
      { qty: 20, unitPrice: 2, discountPct: 28, taxPct: 15 },
    ], { inclusive: true });
    const m = checked(buildInvoiceMove(p, ctx), ctx);
    const tax = m.lines.filter((l) => l.taxRole === 'TAX');
    assert.equal(tax.length, 1);
    assert.equal(tax[0].taxBaseMilli, 670_820n, `separate=${separate}`);
    assertBasePerRate(p, m, `separate=${separate}`);
  }
});

// ═══ خاصية: آلاف الفواتير العشوائية ═══

test('خاصية: فواتير عشوائية (أنواع، شامل/غير شامل، منازل 2 و3، الوضعان) ⇒ متوازنة بلا معلّق، وذمة = AccountEntry', async () => {
  let seed = 20260916;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
  for (let n = 0; n < 1500; n++) {
    const separate = rnd() < 0.5;
    const dec = pick([2, 2, 3]);
    const ctx = saContext({ settings: { postSalesDiscountSeparately: separate, cashInvoiceRouting: pick(['MAIN_CASH', 'CUSTODY'] as const) } });
    const count = 1 + Math.floor(rnd() * 8);
    const items: RawItem[] = Array.from({ length: count }, () => ({
      qty: pick([1, 2, 3, 0.5, 12, 7]),
      unitPrice: Math.round(rnd() * 50000) / pick([100, 1000, 10]),
      discountPct: pick([0, 0, 5, 10, 12.5, 100]),
      taxPct: pick([15, 15, 0]),
    }));
    const type = pick(['CASH', 'CREDIT', 'RETURN'] as const);
    const p = invoice(type, items, { inclusive: rnd() < 0.5, headPct: pick([0, 0, 3, 7.5]), decimals: dec });
    const r = buildInvoiceMove(p, ctx);
    if (M(p.total, dec) === 0n) { assert.ok(isNoMove(r)); continue; }
    const m = checked(r, ctx);
    assert.equal(on(m, ctx, '911001').length, 0, `معلّق غير متوقع في الحالة ${n}`);
    assert.equal(m.needsAttention, false);
    const inc = type === 'RETURN' ? 1n : -1n;
    assert.equal(net(m.lines.filter((l) => l.taxRole === 'TAX')) * inc, M(p.taxAmt, dec));
    if (separate) {
      assert.equal(net(on(m, ctx, type === 'RETURN' ? '412001' : '411001')) * inc, M(p.subtotal, dec));
      assert.equal(net(on(m, ctx, '413001')) * -inc, M(p.discountAmt, dec));
    }
    assertBasePerRate(p, m, `الحالة ${n}`);
    if (n % 25 === 0) await assertArParity(p, m, ctx);
  }
});

test('الـbuilder صرف: لا يستورد prisma ولا @prisma/client', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'gl', 'builders', 'invoice.ts'), 'utf8');
  assert.doesNotMatch(src, /from\s+['"](@prisma\/client|.*prisma)['"]/);
  assert.doesNotMatch(src, /require\(/);
});
