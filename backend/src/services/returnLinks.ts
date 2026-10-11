/**
 * المرتجع من فاتورة بيع (طلب المالك ١١ أكتوبر ٢٠٢٦): للأصناف المفعّلة صلاحيتها يختار المندوب **فاتورة البيع** التي يُرجَع
 * منها — كامل أصنافها أو بعضها — فتُقاس صلاحية كل بند على بيعه هو بالضبط، ويدخل المنتهي منها مخزون السيارة «منتهي
 * الصلاحية» لا يُباع (routes/vanStock.ts).
 *
 * في المرحلة الأولى يُحفظ الربط في `InvoiceItem.returnOfItemId` (عمودٌ مستقلّ عن `creditedItemId` الذي تملكه
 * الفوترة الإلكترونية في المرحلة الثانية). والمرتجَع من كل بند بيع = مرتجعات مرتبطة به غير ملغاة + إشعارات دائنة عليه.
 */
import { Prisma } from '@prisma/client';
import prisma from '../config/database';

type Db = Prisma.TransactionClient | typeof prisma;

export const SALE_TYPES = ['CASH', 'CREDIT'] as const;

export interface SaleItemRow {
  id: string;
  productId: string | null;
  qty: number;
}

export interface ReturnLineRequest {
  productId: string;
  saleItemId: string | null;
  qty: number;
}

export class ReturnLinkError extends Error {
  constructor(message: string, readonly status = 422, readonly code = 'RETURN_LINK_INVALID') { super(message); }
}

const EPS = 1e-9;

/** الكمية المرتجَعة من كل بند بيع — مرتجعات مرتبطة غير ملغاة (المرحلة الأولى) وإشعارات دائنة (المرحلة الثانية) */
export async function returnedBySaleItem(db: Db, tenantId: string, saleItemIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!saleItemIds.length) return out;
  const rows = await db.invoiceItem.findMany({
    where: {
      OR: [{ returnOfItemId: { in: saleItemIds } }, { creditedItemId: { in: saleItemIds } }],
      invoice: { tenantId, status: { not: 'CANCELLED' } },
    },
    select: { qty: true, returnOfItemId: true, creditedItemId: true },
  });
  for (const r of rows) {
    const key = r.returnOfItemId ?? r.creditedItemId;
    if (key) out.set(key, (out.get(key) ?? 0) + Number(r.qty));
  }
  return out;
}

/** المتاح للإرجاع من كل بند: المبيع ناقص ما أُرجع، ولا يقلّ عن صفر */
export function returnableOf(items: SaleItemRow[], returned: Map<string, number>): Map<string, number> {
  return new Map(items.map((it) => [it.id, Math.max(0, Number(it.qty) - (returned.get(it.id) ?? 0))]));
}

/**
 * يتحقّق من مرتجعٍ مرتبط بفاتورة بيع — صرفةٌ على ما قُرئ. يعيد رسالة عربية أو null.
 * كل بندٍ يشير إلى بندٍ من **الفاتورة نفسها** وبالصنف نفسه، والكمية (مجموعةً لكل بند بيع) ضمن المتاح.
 */
export function returnLinkProblem(input: {
  sale: { customerId: string; type: string; status: string; documentKind: string | null; items: SaleItemRow[] } | null;
  customerId: string;
  lines: ReturnLineRequest[];
  returnable: Map<string, number>;
}): string | null {
  const { sale, customerId, lines, returnable } = input;
  if (!sale) return 'فاتورة البيع غير موجودة';
  if (sale.customerId !== customerId) return 'فاتورة البيع لعميلٍ آخر';
  if (!(SALE_TYPES as readonly string[]).includes(sale.type) || sale.status !== 'CONFIRMED'
    || sale.documentKind === 'CREDIT_NOTE' || sale.documentKind === 'DEBIT_NOTE') {
    return 'الفاتورة المختارة ليست فاتورة بيع قائمة';
  }
  const byId = new Map(sale.items.map((it) => [it.id, it]));
  const want = new Map<string, number>();
  for (const l of lines) {
    if (!l.saleItemId) return 'كل أصناف المرتجع يجب أن تكون من فاتورة البيع المختارة';
    const it = byId.get(l.saleItemId);
    if (!it) return 'صنفٌ في المرتجع ليس من فاتورة البيع المختارة';
    if (it.productId !== l.productId) return 'صنف المرتجع لا يطابق صنف فاتورة البيع';
    want.set(l.saleItemId, (want.get(l.saleItemId) ?? 0) + l.qty);
  }
  for (const [id, qty] of want) {
    const left = returnable.get(id) ?? 0;
    if (qty > left + EPS) return `الكمية المرتجعة أكبر من المتبقي في فاتورة البيع (${Number(left.toFixed(3))})`;
  }
  return null;
}

/**
 * يقرأ فاتورة البيع ومتاحها ويتحقّق من الطلب — يُستدعى قبل الإصدار (لرسالةٍ واضحة) وداخل معاملته بعد قفل صفّ فاتورة
 * البيع (`lock`) فلا يتجاوز مرتجعان متزامنان المتاح معاً. يرمي ReturnLinkError عند المخالفة.
 */
export async function assertReturnLinks(db: Db, input: {
  tenantId: string; customerId: string; saleInvoiceId: string; lines: ReturnLineRequest[]; lock?: boolean;
}): Promise<void> {
  if (input.lock) {
    await db.$queryRaw`SELECT id FROM invoices WHERE id = ${input.saleInvoiceId} AND "tenantId" = ${input.tenantId} FOR UPDATE`;
  }
  const sale = await db.invoice.findFirst({
    where: { id: input.saleInvoiceId, tenantId: input.tenantId },
    select: { customerId: true, type: true, status: true, documentKind: true, items: { select: { id: true, productId: true, qty: true } } },
  });
  const returned = sale ? await returnedBySaleItem(db, input.tenantId, sale.items.map((i) => i.id)) : new Map<string, number>();
  const problem = returnLinkProblem({
    sale: sale as never, customerId: input.customerId, lines: input.lines,
    returnable: sale ? returnableOf(sale.items, returned) : new Map(),
  });
  if (problem) throw new ReturnLinkError(problem, input.lock ? 409 : 422);
}
