import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  toLinkedSale, linkedSaleProblem, clampReturnQty, fillLinkedQty, activeLinkedLines, mergeRefreshedSale,
  linkedReturnTotals, buildLinkedReturnPayload, buildFreeReturnPayload, returnFormProblem, returnIssueError,
  returnDocItems, RETURN_INVOICE_PHRASES, RETURN_REASONS, type LinkedSale, type ReturnHead,
} from './returnInvoice';
import { computeInvoiceTotals } from '../rep/invoiceCalc';
import { PHRASES } from '../i18n/strings';

// طلب المالك: «في صفحة اصدار فاتورة من صفحة الويب اضف قائمة تحدد نوع الفاتورة (فاتورة جديدة او فاتورة ارجاع)».
// فاتورة بيع حقيقية الشكل: ٣ قطع بـ١٠٠ وخصم بند ١٠٪ وضريبة ١٥٪ ⇒ إجمالي البند ٣١٠٫٥٠ ⇒ سعر الاسترداد ١٠٣٫٥٠ للقطعة.
const dto = {
  id: 'sale-1', number: 'INV-2610-000042', invoiceDate: '2026-10-10T09:00:00.000Z', customerId: 'c1',
  lines: [
    { saleItemId: 'si-a', productId: 'p-a', name: 'عصير برتقال', code: 'A1', unit: 'كرتون', sold: 3, returned: 0, returnable: 3, refundUnitPrice: 103.5, taxPct: 15, shelfLife: false, expiresAt: null, expiredToday: null, returnBlocked: null },
    // الصنف نفسه في بندٍ ثانٍ بسعرٍ آخر — المفتاح بند البيع لا الصنف
    { saleItemId: 'si-a2', productId: 'p-a', name: 'عصير برتقال', code: 'A1', unit: 'كرتون', sold: 3, returned: 1, returnable: 2, refundUnitPrice: 33.3333, taxPct: 15, shelfLife: true, expiresAt: '2026-10-18', expiredToday: true, returnBlocked: null },
    { saleItemId: 'si-b', productId: 'p-b', name: 'حليب', code: 'B1', unit: 'علبة', sold: 5, returned: 0, returnable: 5, refundUnitPrice: 4.6, taxPct: 15, shelfLife: true, expiresAt: '2026-09-01', expiredToday: true, returnBlocked: 'تجاوز مدة الإرجاع' },
    { saleItemId: 'si-c', productId: 'p-c', name: 'ماء', code: 'C1', unit: 'كرتون', sold: 2, returned: 2, returnable: 0, refundUnitPrice: 11.5, taxPct: 15, shelfLife: false, expiresAt: null, expiredToday: null, returnBlocked: null },
  ],
};
const head = (over: Partial<ReturnHead> = {}): ReturnHead => ({
  customerId: 'c1', salesRepId: 'r1', returnReason: 'NORMAL', notes: '', invoiceDate: '', phase2: false, noteReason: '', ...over,
});
const withQty = (sale: LinkedSale, q: Record<string, number>): LinkedSale =>
  ({ ...sale, lines: sale.lines.map(l => ({ ...l, qty: clampReturnQty(q[l.saleItemId] ?? 0, l) })) });

test('بنود فاتورة البيع: الكمية تبدأ صفراً (لا إرجاع فاتورة كاملة بلا قصد) والأرقام تُطهَّر', () => {
  const s = toLinkedSale(dto);
  assert.equal(s.id, 'sale-1');
  assert.equal(s.lines.length, 4);
  assert.ok(s.lines.every(l => l.qty === 0));
  assert.equal(s.lines[2].returnBlocked, 'تجاوز مدة الإرجاع');
  assert.equal(s.lines[0].returnBlocked, null);
  const dirty = toLinkedSale({ id: 'x', number: 'n', invoiceDate: 'd', lines: [{ saleItemId: 's', productId: 'p', returnable: '2.5', refundUnitPrice: 'abc', sold: -1 }] });
  assert.equal(dirty.lines[0].returnable, 2.5);
  assert.equal(dirty.lines[0].refundUnitPrice, 0);
  assert.deepEqual(toLinkedSale(null).lines, []);
});

test('فاتورة لا يُرجَع منها شيء أو كل متاحها ممنوعٌ بقيد الصلاحية لا تُربط — برسالة تسمّي الصنف', () => {
  assert.equal(linkedSaleProblem(toLinkedSale(dto)), null);
  const nothing = toLinkedSale({ ...dto, lines: [dto.lines[3]] });
  assert.deepEqual(linkedSaleProblem(nothing), { key: 'لا يوجد في هذه الفاتورة ما يمكن إرجاعه' });
  const blocked = toLinkedSale({ ...dto, lines: [dto.lines[2], dto.lines[3]] });
  assert.deepEqual(linkedSaleProblem(blocked), { key: 'قيد الصلاحية يمنع مرتجع أصناف هذه الفاتورة', detail: 'حليب: تجاوز مدة الإرجاع' });
});

test('كمية المرتجع: لا سالب ولا فوق المتاح، والممنوع والمستنفد صفرٌ دائماً', () => {
  const [a, a2, b, c] = toLinkedSale(dto).lines;
  assert.equal(clampReturnQty(-4, a), 0);
  assert.equal(clampReturnQty(Number.NaN, a), 0);
  assert.equal(clampReturnQty(9, a), 3);
  assert.equal(clampReturnQty(1.25, a2), 1.25);
  assert.equal(clampReturnQty(2, b), 0, 'بند يمنعه قيد المرتجع');
  assert.equal(clampReturnQty(1, c), 0, 'بند أُرجع كاملاً');
  const all = fillLinkedQty(toLinkedSale(dto).lines, true);
  assert.deepEqual(all.map(l => l.qty), [3, 2, 0, 0]);
  assert.deepEqual(fillLinkedQty(all, false).map(l => l.qty), [0, 0, 0, 0]);
  assert.deepEqual(activeLinkedLines(all).map(l => l.saleItemId), ['si-a', 'si-a2']);
});

test('جسم المرتجع المرتبط (المرحلة الأولى): سعر الاسترداد شاملاً بلا أي خصم، وبند البيع لكل صنف، والمصفَّر لا يُرسل', () => {
  const sale = withQty(toLinkedSale(dto), { 'si-a': 1, 'si-a2': 0 });
  const body = buildLinkedReturnPayload(head({ returnReason: 'DAMAGED', notes: 'تلف بالنقل', invoiceDate: '2026-10-12' }), sale);
  assert.deepEqual(body, {
    customerId: 'c1', salesRepId: 'r1', type: 'RETURN', returnReason: 'DAMAGED', originalInvoiceId: 'sale-1',
    pricesIncludeTax: true, discountPct: 0, notes: 'تلف بالنقل', invoiceDate: '2026-10-12',
    items: [{ productId: 'p-a', invoiceItemId: 'si-a', qty: 1, unitPrice: 103.5, discountPct: 0, taxPct: 15 }],
  });
  // لا ما يرفضه الخادم مع المرتجع أو يكسر المرحلة الثانية
  for (const k of ['deliveryDate', 'paymentPlan', 'installmentPlan', 'clientCreatedAt', 'noteReason', 'returnToStock']) {
    assert.ok(!(k in body), `حقلٌ لا مكان له في المرتجع: ${k}`);
  }
});

test('جسم الإشعار الدائن (المرحلة الثانية): السبب مقصوصاً، ولا تاريخ (الخادم يصدره الآن)', () => {
  const sale = withQty(toLinkedSale(dto), { 'si-a2': 2 });
  const body = buildLinkedReturnPayload(head({ phase2: true, noteReason: '  بضاعة منتهية  ', invoiceDate: '2026-10-12' }), sale);
  assert.equal(body.noteReason, 'بضاعة منتهية');
  assert.ok(!('invoiceDate' in body));
  assert.equal(body.originalInvoiceId, 'sale-1');
  assert.deepEqual(body.items, [{ productId: 'p-a', invoiceItemId: 'si-a2', qty: 2, unitPrice: 33.3333, discountPct: 0, taxPct: 15 }]);
});

test('جسم المرتجع الحرّ: بنود المحرّر كما يرسل البيع بنوده (أسعار صافية بلا pricesIncludeTax) والخصم العام', () => {
  const body = buildFreeReturnPayload(head({ returnReason: 'EXCHANGE' }), [
    { productId: 'p-a', qty: 2, unitPrice: 90, discountPct: 5, taxPct: 15 },
  ], 2);
  assert.deepEqual(body, {
    customerId: 'c1', salesRepId: 'r1', type: 'RETURN', returnReason: 'EXCHANGE', discountPct: 2, notes: '',
    items: [{ productId: 'p-a', qty: 2, unitPrice: 90, discountPct: 5, taxPct: 15 }],
  });
  assert.ok(!('pricesIncludeTax' in body) && !('originalInvoiceId' in body));
});

test('معاينة المرتجع المرتبط = ما يحسبه الخادم: إرجاع قطعة من ٣١٠٫٥٠ يعيد ١٠٣٫٥٠ منها ضريبة ١٣٫٥٠', () => {
  const one = linkedReturnTotals(withQty(toLinkedSale(dto), { 'si-a': 1 }).lines, 2);
  assert.deepEqual({ subtotal: one.subtotal, discountAmt: one.discountAmt, taxAmt: one.taxAmt, total: one.total },
    { subtotal: 90, discountAmt: 0, taxAmt: 13.5, total: 103.5 });
  assert.deepEqual(one.lineTotals, { 'si-a': 103.5 });
  // إرجاع البند كاملاً يعيد إجمالي بند البيع بالضبط: ٣ × ١٠٣٫٥ = ٣١٠٫٥٠
  assert.equal(linkedReturnTotals(withQty(toLinkedSale(dto), { 'si-a': 3 }).lines, 2).total, 310.5);
  // سعر الاسترداد بأربع خانات (١٠٠ ÷ ٣): ٣ قطع تعود ١٠٠٫٠٠ لا ٩٩٫٩٩ — التقريب على الإجمالي بخانات العملة
  const thirds = toLinkedSale({ ...dto, lines: [{ ...dto.lines[1], returned: 0, returnable: 3 }] });
  assert.equal(linkedReturnTotals(withQty(thirds, { 'si-a2': 3 }).lines, 2).total, 100);
  // ولا بنود ⇒ صفر (لا قسمة على لا شيء)
  assert.equal(linkedReturnTotals(toLinkedSale(dto).lines, 2).total, 0);
});

test('المعاينة تطابق محرّك الخادم حرفياً على الجسم المُرسل نفسه (backend/src/lib/invoiceCalc.ts)', async (t) => {
  const url = new URL('../../../backend/src/lib/invoiceCalc.ts', import.meta.url);
  let server: { computeInvoiceTotals: typeof computeInvoiceTotals } | null = null;
  try { readFileSync(url); server = await import(url.href); } catch { t.skip('مصدر الخادم غير متاح في هذا الفحص'); return; }
  const cases: Record<string, number>[] = [{ 'si-a': 1 }, { 'si-a': 3, 'si-a2': 2 }, { 'si-a': 0.5, 'si-a2': 1.75 }, { 'si-a2': 1 }];
  for (const dec of [2, 3]) {
    for (const q of cases) {
      const sale = withQty(toLinkedSale(dto), q);
      const body = buildLinkedReturnPayload(head(), sale) as {
        items: { qty: number; unitPrice: number; discountPct: number; taxPct: number }[]; discountPct: number; pricesIncludeTax: boolean;
      };
      // كما في routes/invoices.ts: computeInvoiceTotals(body.items…, { companyVat, decimals: dec, invoiceDiscountPct: body.discountPct, pricesIncludeTax: body.pricesIncludeTax })
      const srv = server!.computeInvoiceTotals(
        body.items.map(i => ({ qty: i.qty, unitPrice: i.unitPrice, discountPct: i.discountPct, taxPct: i.taxPct })),
        { companyVat: 15, decimals: dec, invoiceDiscountPct: body.discountPct, pricesIncludeTax: body.pricesIncludeTax },
      );
      const ui = linkedReturnTotals(sale.lines, dec);
      assert.deepEqual({ subtotal: ui.subtotal, discountAmt: ui.discountAmt, taxAmt: ui.taxAmt, total: ui.total },
        { subtotal: srv.subtotal, discountAmt: srv.discountAmt, taxAmt: srv.taxAmt, total: srv.total }, JSON.stringify({ dec, q }));
      assert.deepEqual(Object.values(ui.lineTotals), srv.items.map(i => i.lineTotal));
    }
  }
});

test('ما يمنع الإصدار قبل الإرسال: مرآة رفض الخادم بلغة المدير', () => {
  const sale = toLinkedSale(dto);
  const base = { phase2: false, linked: null as LinkedSale | null, freeLines: [{ qty: 1 }], noteReason: '', invoiceDate: '' };
  assert.equal(returnFormProblem(base), null, 'مرتجع حرّ سليم في المرحلة الأولى');
  assert.equal(returnFormProblem({ ...base, freeLines: [] }), 'أضف صنفا على الأقل');
  assert.equal(returnFormProblem({ ...base, freeLines: [{ qty: 0 }] }), 'الكمية يجب أن تكون أكبر من صفر');
  // ZATCA_RETURN_NEEDS_ORIGINAL
  assert.equal(returnFormProblem({ ...base, phase2: true, noteReason: 'سبب كاف' }), 'اختر فاتورة البيع الأصلية — المرتجع في المرحلة الثانية إشعار دائن مرتبط بها');
  assert.equal(returnFormProblem({ ...base, linked: sale }), 'أدخل كمية مرتجعة لصنف واحد على الأقل');
  const one = withQty(sale, { 'si-a': 1 });
  assert.equal(returnFormProblem({ ...base, linked: one }), null);
  assert.equal(returnFormProblem({ ...base, linked: one, invoiceDate: '2026-10-09' }), 'تاريخ المرتجع قبل تاريخ فاتورة البيع');
  assert.equal(returnFormProblem({ ...base, linked: one, invoiceDate: '2026-10-10' }), null, 'يوم البيع نفسه مقبول');
  // سبب الإشعار ٣–١٠٠٠ حرف بعد القصّ (assertReason على الخادم)
  assert.equal(returnFormProblem({ ...base, phase2: true, linked: one, noteReason: '  أب ' }), 'سبب الإشعار الدائن مطلوب من 3 إلى 1000 حرف');
  assert.equal(returnFormProblem({ ...base, phase2: true, linked: one, noteReason: 'x'.repeat(1001) }), 'سبب الإشعار الدائن مطلوب من 3 إلى 1000 حرف');
  assert.equal(returnFormProblem({ ...base, phase2: true, linked: one, noteReason: 'تالف' }), null);
  // المرحلة الثانية لا تفحص التاريخ (لا يُرسل أصلاً)
  assert.equal(returnFormProblem({ ...base, phase2: true, linked: one, noteReason: 'تالف', invoiceDate: '2020-01-01' }), null);
});

test('أخطاء الإصدار: رسالة الخادم أولاً، وأسباب البنود تُلحق، والتعارض على المتاح يطلب تحديث البنود', () => {
  const e = (data: unknown) => ({ response: { status: 422, data } });
  assert.deepEqual(returnIssueError(e({ success: false, code: 'RETURN_LINK_INVALID', message: 'الكمية المرتجعة أكبر من المتبقي في فاتورة البيع (2)' })),
    { message: 'الكمية المرتجعة أكبر من المتبقي في فاتورة البيع (2)', code: 'RETURN_LINK_INVALID', refreshLines: true });
  const lines = returnIssueError(e({ code: 'ZATCA_NOTE_LINES_INVALID', message: 'بنود الإشعار غير صحيحة', issues: [
    { severity: 'error', messageAr: 'صنف ليس في الفاتورة' }, { severity: 'error', messageAr: 'صنف ليس في الفاتورة' }, { severity: 'warning', messageAr: 'تنبيه' },
  ] }));
  assert.equal(lines.message, 'بنود الإشعار غير صحيحة: صنف ليس في الفاتورة');
  assert.equal(lines.refreshLines, false);
  assert.equal(returnIssueError(e({ code: 'ZATCA_CREDIT_QTY_EXCEEDED' })).message, 'الكمية المرتجعة أكبر من المتاح للإرجاع');
  assert.equal(returnIssueError(e({ code: 'ZATCA_NOTHING_TO_CREDIT', message: 'كل كميات هذه الفاتورة مُرتجعة سابقاً' })).refreshLines, true);
  assert.equal(returnIssueError(new Error('Network Error')).message, 'تعذر إصدار المستند حاول مجددا');
  assert.equal(returnIssueError(null).code, null);
});

test('ورقة المرتجع من ردّ الخادم: الاسم من بند البيع (المرحلتان) والصلاحية المقيسة على الخادم أولاً', () => {
  const sources = toLinkedSale(dto).lines.map(l => ({ productId: l.productId, name: l.name + ':' + l.saleItemId, unit: l.unit, saleItemId: l.saleItemId, shelfLife: l.shelfLife, expiresAt: l.expiresAt, expiredToday: l.expiredToday }));
  const items = returnDocItems([
    // المرحلة الأولى: returnOfItemId، وصلاحيةٌ كتبها الخادم مع البند
    { productId: 'p-a', returnOfItemId: 'si-a2', qty: '2', unitPrice: '33.3333', discountPct: '0', taxPct: '15', lineTotal: '66.67', returnExpired: false, expiresAt: '2026-11-01T00:00:00.000Z' },
    // المرحلة الثانية: creditedItemId، بلا صلاحية من الخادم ⇒ ما عرضته الشاشة
    { productId: 'p-a', creditedItemId: 'si-a2', qty: 1, unitPrice: 30, discountPct: 0, taxPct: 15, lineTotal: 34.5 },
    // مرتجع حرّ: بالصنف
    { productId: 'p-b', qty: 1, unitPrice: 4, discountPct: 0, taxPct: 15, lineTotal: 4.6 },
    { productId: 'p-z', qty: 1, unitPrice: 1, discountPct: 0, taxPct: 0, lineTotal: 1 },
  ], sources);
  assert.equal(items[0].name, 'عصير برتقال:si-a2');
  assert.equal(items[0].qty, 2);
  assert.equal(items[0].lineTotal, 66.67);
  assert.equal(items[0].returnExpired, false);
  assert.equal(items[0].expiresAt, '2026-11-01T00:00:00.000Z');
  assert.equal(items[1].name, 'عصير برتقال:si-a2');
  assert.equal(items[1].returnExpired, true);
  assert.equal(items[1].expiresAt, '2026-10-18');
  assert.equal(items[2].name, 'حليب:si-b');
  assert.equal(items[3].name, '-');
  assert.ok(!('returnExpired' in items[3]));
  assert.deepEqual(returnDocItems(undefined, sources), []);
});

test('كل عبارة تمرّ إلى tr() بمتغيّر من هذا المسار مترجمة بأربع لغات', () => {
  for (const p of new Set([...RETURN_INVOICE_PHRASES, ...RETURN_REASONS.map(([, l]) => l)])) {
    const e = PHRASES[p];
    assert.ok(e, `عبارة غير موجودة في القاموس: ${p}`);
    for (const lang of ['en', 'fr', 'tr', 'zh'] as const) assert.ok(e[lang]?.trim(), `${p} بلا ${lang}`);
  }
});

// ═══ حرّاس نصّيّة على النافذة: البيع كما كان حرفاً بحرف، والمرتجع يُطبع مرتجعاً ═══
const modal = readFileSync(new URL('../components/forms/InvoiceModal.tsx', import.meta.url), 'utf8');

test('مسار البيع لم يتغيّر: الجسم المرسل نفسه حرفياً', () => {
  assert.ok(modal.includes(`    mutation.mutate({
      customerId, salesRepId, type, discountPct, notes,
      ...(invoiceDate && { invoiceDate }),
      ...(deliveryDate && { deliveryDate }),
      ...(plan === 'INSTALLMENT' && {
        paymentPlan: 'INSTALLMENT',
        installmentPlan: { count: insCount, firstDueDate: insFirst, period: insPeriod },
      }),
      items: lines.map(l => ({
        productId: l.productId, qty: l.qty, unitPrice: l.unitPrice,
        discountPct: l.discountPct, taxPct: l.taxPct,
      })),
    });`.replace(/\n/g, modal.includes('\r\n') ? '\r\n' : '\n')), 'جسم فاتورة البيع تغيّر');
  // المرتجع يتفرّع قبل فحوص البيع ولا يمرّ بها
  assert.match(modal, /const handleSubmit = \(\) => \{\s*if \(isReturn\) \{ submitReturn\(\); return; \}/);
  // القائمة بلفظ المالك: «نوع الفاتورة» بخياري «فاتورة جديدة» و«فاتورة إرجاع»
  assert.match(modal, /<option value="SALE">\{tr\('فاتورة جديدة'\)\}<\/option>/);
  assert.match(modal, /<option value="RETURN">\{tr\('فاتورة إرجاع'\)\}<\/option>/);
});

test('المرتجع: يُطبع مرتجعاً من ردّ الخادم، و202 لا ورقة له، وتغيير العميل يفكّ فاتورة البيع', () => {
  const ret = modal.slice(modal.indexOf("if ((vars as { type?: string } | undefined)?.type === 'RETURN') {"), modal.indexOf('const doc: InvoiceDoc = {'));
  assert.ok(ret.length > 100, 'فرع المرتجع في onSuccess اختفى');
  assert.match(ret, /type: 'CREDIT', isReturn: true/);
  assert.match(ret, /if \(res\.status !== 201\)[\s\S]*zatcaIssueOutcome\(res,[\s\S]*return;[\s\S]*onSaved\(retDoc\)/);
  assert.match(ret, /subtotal: Number\(inv\.subtotal\)[\s\S]*total: Number\(inv\.total\)/);
  assert.match(ret, /zatca: zatcaDocView\(inv\)/);
  assert.match(modal, /setSelectedCustomer\(\(customers \|\| \[\]\)\.find\(c => c\.id === v\) \|\| null\); unlinkSale\(\);/);
  // مفتاح صفّ البند المرتبط بند البيع لا الصنف
  assert.match(modal, /<tr key=\{l\.saleItemId\}/);
});
