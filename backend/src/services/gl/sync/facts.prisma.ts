/**
 * تحميل حقائق الاشتقاق بـPrisma («ربط الدفاتر» L4+L5، العقد §3.2) — مصدر واحد للمُطابِق (reconcilerStore.loadFacts) وللمُرحِّل
 * (postingStore.loadSourceData)، فلا تتباعد لقطة الحمولة بين من يكتشف الحدث ومن يعيد بناءه.
 *
 * - كل دالة استعلامات مجمّعة بالمفتاح الأساسي لمعرّفات الصفحة (`id in [...]`) بلا N+1: الفاتورة وعلاقاتها في findMany واحد
 *   (Prisma يجمع العلاقات المتداخلة باستعلام لكل مستوى)، ثم استعلام واحد لكل جدول تابع عند الحاجة فقط (القاعدة 0.1 نواة).
 * - opts.linked=false (الشركات غير المربوطة في المُطابِق): select اليوم حرفاً — لا عمود ولا استعلام زائد. الافتراضي الحقائق كاملة
 *   (المُرحِّل يمرّرها ثم تحرس دوال الحمولة بـctx.linked)، فلا يُفقد حقل لمربوطة نسي المُستدعي علَمها.
 * - الحقائق لقطة لحظة الاشتقاق (القاعدة 5 في الخطة): الحمولة نفسها هي اللقطة ولا عمود فئة على البند.
 */
import type { Prisma } from '@prisma/client';
import type { InvoiceFacts, InvoiceItemFacts, ReceiptFacts } from './desired';

/** أدنى عميل يكفي: PrismaClient وPrisma.TransactionClient ومزيّفات الاختبار */
export type FactsDb = Pick<Prisma.TransactionClient, 'invoice' | 'invoiceItem' | 'receipt' | 'customerPaymentLink' | 'settlementEntry' | 'cardPayment' | 'admin' | 'customer'>;

export interface FactsOptions {
  /** false ⇒ حقائق اليوم وحدها (غير المربوطة). الافتراضي true */
  linked?: boolean;
}

export interface RefundLinkFacts {
  receiptId: string | null;
  customerId: string | null;
  customerName: string | null;
}

const uniq = (ids: readonly (string | null | undefined)[]): string[] => [...new Set(ids.filter((x): x is string => !!x))];

/** حقائق الفواتير بالمعرّف — البنود بترتيب id (ثابت عبر إعادة الاشتقاق) والأقساط بترتيب seq */
export async function loadInvoiceFacts(db: FactsDb, tenantId: string, ids: string[], opts: FactsOptions = {}): Promise<Map<string, InvoiceFacts>> {
  const want = uniq(ids);
  if (want.length === 0) return new Map();
  const linked = opts.linked !== false;
  if (!linked) {
    // select المُطابِق قبل «ربط الدفاتر» حرفاً
    const list = await db.invoice.findMany({
      where: { tenantId, id: { in: want } },
      select: {
        id: true, number: true, type: true, customerId: true, salesRepId: true, pricesIncludeTax: true,
        subtotal: true, discountAmt: true, taxAmt: true, total: true, dueDate: true,
        taxFree: true, // «إزالة الضريبة»: ختم الفاتورة ⇒ الحمولة (حين true وحده)
        customer: { select: { name: true } }, salesRep: { select: { name: true } },
        items: {
          select: { productId: true, qty: true, unitPrice: true, taxPct: true, taxAmt: true, lineTotal: true, vatCategory: true, product: { select: { categoryId: true } } },
          orderBy: { id: 'asc' },
        },
      },
    });
    return new Map(list.map((i): [string, InvoiceFacts] => [i.id, {
      id: i.id, number: i.number, type: i.type, customerId: i.customerId, salesRepId: i.salesRepId,
      pricesIncludeTax: i.pricesIncludeTax, subtotal: i.subtotal, discountAmt: i.discountAmt, taxAmt: i.taxAmt, total: i.total,
      dueDate: i.dueDate, customerName: i.customer?.name ?? null, salesRepName: i.salesRep?.name ?? null, taxFree: i.taxFree,
      items: i.items.map((it) => ({
        productId: it.productId, categoryId: it.product?.categoryId ?? null, qty: it.qty, unitPrice: it.unitPrice,
        taxPct: it.taxPct, taxAmt: it.taxAmt, lineTotal: it.lineTotal, vatCategory: it.vatCategory,
      })),
    }]));
  }

  const list = await db.invoice.findMany({
    where: { tenantId, id: { in: want } },
    select: {
      id: true, number: true, type: true, customerId: true, salesRepId: true, pricesIncludeTax: true,
      subtotal: true, discountAmt: true, taxAmt: true, total: true, dueDate: true, taxFree: true,
      invoiceDate: true, cashCollectedByRep: true, remainingApplied: true, documentKind: true, originalInvoiceId: true,
      customer: { select: { name: true, paymentDays: true } }, salesRep: { select: { name: true } },
      items: {
        select: {
          productId: true, qty: true, unitPrice: true, taxPct: true, taxAmt: true, lineTotal: true, vatCategory: true,
          baseQty: true, unitFactor: true, itemName: true, returnOfItemId: true,
          product: { select: { categoryId: true, name: true } },
        },
        orderBy: { id: 'asc' },
      },
      installments: { select: { seq: true, dueDate: true, amount: true }, orderBy: { seq: 'asc' } },
    },
  });

  // المرتجع المرتبط ⇒ فاتورة البيع: أول بند مرتبط (بنود المرتجع كلها من فاتورة واحدة — services/returnLinks.ts)، باستعلام واحد للصفحة
  const firstReturnOf = new Map<string, string>();
  for (const i of list) {
    const link = i.type === 'RETURN' ? i.items.find((it) => !!it.returnOfItemId)?.returnOfItemId : null;
    if (link) firstReturnOf.set(i.id, link);
  }
  const saleOfItem = new Map<string, string>();
  const saleItemIds = uniq([...firstReturnOf.values()]);
  if (saleItemIds.length > 0) {
    const rows = await db.invoiceItem.findMany({
      where: { id: { in: saleItemIds }, invoice: { tenantId } },
      select: { id: true, invoiceId: true },
    });
    for (const r of rows) saleOfItem.set(r.id, r.invoiceId);
  }

  return new Map(list.map((i): [string, InvoiceFacts] => {
    const returnOf = firstReturnOf.get(i.id);
    const items: InvoiceItemFacts[] = i.items.map((it) => ({
      productId: it.productId, categoryId: it.product?.categoryId ?? null, qty: it.qty, unitPrice: it.unitPrice,
      taxPct: it.taxPct, taxAmt: it.taxAmt, lineTotal: it.lineTotal, vatCategory: it.vatCategory,
      baseQty: it.baseQty, unitFactor: it.unitFactor, productName: it.itemName ?? it.product?.name ?? null,
    }));
    return [i.id, {
      id: i.id, number: i.number, type: i.type, customerId: i.customerId, salesRepId: i.salesRepId,
      pricesIncludeTax: i.pricesIncludeTax, subtotal: i.subtotal, discountAmt: i.discountAmt, taxAmt: i.taxAmt, total: i.total,
      dueDate: i.dueDate, customerName: i.customer?.name ?? null, salesRepName: i.salesRep?.name ?? null, taxFree: i.taxFree,
      items,
      invoiceDate: i.invoiceDate,
      cashCollectedByRep: i.cashCollectedByRep,
      installments: i.installments.map((x) => ({ seq: x.seq, dueDate: x.dueDate, amount: x.amount })),
      customerPaymentDays: i.customer?.paymentDays ?? null,
      remainingApplied: i.remainingApplied,
      saleInvoiceId: returnOf ? (saleOfItem.get(returnOf) ?? null) : null,
      documentKind: i.documentKind,
      originalInvoiceId: i.originalInvoiceId,
    }];
  }));
}

/**
 * حقائق السندات بالمعرّف: paylinkId من CustomerPaymentLink.receiptId = receipt.id (لا clientRef)، والاسترداد الأحدث للرابط؛
 * وللمربوطة: الطريقة المخصّصة، والبطاقة (CardPayment.receiptId @unique)، والتخصيصات، ومصدر ردّ المال عند الإلغاء ولقطة مستخدمه.
 */
export async function loadReceiptFacts(db: FactsDb, tenantId: string, ids: string[], opts: FactsOptions = {}): Promise<Map<string, ReceiptFacts>> {
  const want = uniq(ids);
  if (want.length === 0) return new Map();
  const linked = opts.linked !== false;
  const list = linked
    ? await db.receipt.findMany({
      where: { tenantId, id: { in: want } },
      select: {
        id: true, number: true, customerId: true, salesRepId: true, paymentMethod: true, amount: true,
        customer: { select: { name: true } }, salesRep: { select: { name: true } },
        paymentMethodKey: true, cancelRefundFrom: true, cancelRefundUserId: true,
        invoiceItems: { select: { id: true, invoiceId: true, amount: true }, orderBy: { id: 'asc' } },
      },
    })
    : await db.receipt.findMany({
      where: { tenantId, id: { in: want } },
      select: {
        id: true, number: true, customerId: true, salesRepId: true, paymentMethod: true, amount: true,
        customer: { select: { name: true } }, salesRep: { select: { name: true } },
      },
    });
  // paylinkId من CustomerPaymentLink.receiptId = receipt.id — لا من clientRef
  const links = await db.customerPaymentLink.findMany({
    where: { tenantId, receiptId: { in: want } },
    select: { id: true, receiptId: true },
  });
  const linkByReceipt = new Map(links.filter((l) => l.receiptId).map((l) => [l.receiptId as string, l.id]));
  const refunds = links.length === 0 ? [] : await db.settlementEntry.findMany({
    where: { tenantId, kind: 'REFUND', linkId: { in: links.map((l) => l.id) } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true, linkId: true, amount: true },
  });
  const refundByLink = new Map<string, { entryId: string; amount: number }>();
  for (const r of refunds) if (r.linkId && !refundByLink.has(r.linkId)) refundByLink.set(r.linkId, { entryId: r.id, amount: r.amount });

  // للمربوطة: البطاقة والمستخدم — استعلام واحد لكلٍّ للصفحة، وحين يلزم فقط
  const cardByReceipt = new Map<string, string>();
  const userNames = new Map<string, string>();
  if (linked) {
    const cards = await db.cardPayment.findMany({
      where: { tenantId, receiptId: { in: want } },
      select: { id: true, receiptId: true },
    });
    for (const c of cards) if (c.receiptId) cardByReceipt.set(c.receiptId, c.id);
    const userIds = uniq(list.map((r) => (r as { cancelRefundUserId?: string | null }).cancelRefundUserId));
    for (const [id, name] of await loadAdminNames(db, tenantId, userIds)) userNames.set(id, name);
  }

  return new Map(list.map((r): [string, ReceiptFacts] => {
    const paylinkId = linkByReceipt.get(r.id) ?? null;
    const base: ReceiptFacts = {
      id: r.id, number: r.number, customerId: r.customerId, salesRepId: r.salesRepId, paymentMethod: r.paymentMethod,
      amount: r.amount, customerName: r.customer?.name ?? null, salesRepName: r.salesRep?.name ?? null,
      paylinkId, refund: paylinkId ? (refundByLink.get(paylinkId) ?? null) : null,
    };
    if (!linked) return [r.id, base];
    const x = r as typeof r & {
      paymentMethodKey: string | null; cancelRefundFrom: string | null; cancelRefundUserId: string | null;
      invoiceItems: { id: string; invoiceId: string; amount: number }[];
    };
    return [r.id, {
      ...base,
      paymentMethodKey: x.paymentMethodKey ?? null,
      cardPaymentId: cardByReceipt.get(r.id) ?? null,
      allocations: (x.invoiceItems ?? []).map((a) => ({ id: a.id, invoiceId: a.invoiceId, amount: a.amount })),
      cancelRefundFrom: x.cancelRefundFrom ?? null,
      cancelRefundUserId: x.cancelRefundUserId ?? null,
      cancelRefundUserName: x.cancelRefundUserId ? (userNames.get(x.cancelRefundUserId) ?? null) : null,
    }];
  }));
}

/** Admin.id ⇒ الاسم (مستخدمو الشركة نفسها وحدها) */
export async function loadAdminNames(db: FactsDb, tenantId: string, ids: string[]): Promise<Map<string, string>> {
  const want = uniq(ids);
  if (want.length === 0) return new Map();
  const list = await db.admin.findMany({ where: { tenantId, id: { in: want } }, select: { id: true, name: true } });
  return new Map(list.map((a) => [a.id, a.name]));
}

/** روابط الدفع لصفوف REFUND: الرابط ⇒ سنده وعميله ولقطة اسمه */
export async function loadRefundLinks(db: FactsDb, tenantId: string, linkIds: string[]): Promise<Map<string, RefundLinkFacts>> {
  const want = uniq(linkIds);
  if (want.length === 0) return new Map();
  const list = await db.customerPaymentLink.findMany({
    where: { tenantId, id: { in: want } },
    select: { id: true, receiptId: true, customerId: true, customer: { select: { name: true } } },
  });
  return new Map(list.map((l): [string, RefundLinkFacts] => [l.id, {
    receiptId: l.receiptId ?? null, customerId: l.customerId ?? null, customerName: l.customer?.name ?? null,
  }]));
}
