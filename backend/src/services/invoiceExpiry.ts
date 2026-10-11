/**
 * صلاحية الصنف من **تاريخ البيع** (طلب المالك ١١ أكتوبر ٢٠٢٦) — والغاية: حين يُسجَّل مرتجعٌ يُسجَّل معه هل الصنف
 * المُرتجَع منتهي الصلاحية أم لا.
 *
 * - **بند البيع** (نقدي/آجل): `expiresAt` = يوم الفاتورة بتوقيت الشركة + صلاحية الصنف حينها — لقطةٌ لا تتغيّر
 *   إن عُدّلت صلاحية الصنف لاحقاً.
 * - **بند المرتجع**: يُقاس على بيعه —
 *     · المرتجع المرتبط بفاتورته: بندُ الأصل نفسه — `creditedItemId` (إشعار دائن، المرحلة الثانية) أو `returnOfItemId`
 *       (مرتجعٌ من فاتورة بيع في المرحلة الأولى، services/returnLinks.ts).
 *     · المرتجع الحرّ (المرحلة الأولى، بلا ربط): **آخر بيعٍ لهذا الصنف لهذا العميل** قبل المرتجع — المحلّ يبيع
 *       الأقدم أولاً فما يعود هو آخر ما وصله، وإن كان آخر بيعٍ منتهياً فكل ما قبله منتهٍ.
 *   ويُحفظ `expiresAt` (انتهاء ذلك البيع) و`returnExpired` (يوم المرتجع بعد يوم الانتهاء) و`expirySaleInvoiceId`
 *   (الفاتورة التي قيس عليها، للعرض). بلا بيعٍ سابق أو لصنفٍ بلا صلاحية: يبقى الثلاثة فارغة — لا تخمين.
 *
 * يُستدعى بعد إصدار المستند خارج معاملته (`stampExpiryAfterIssue`) ولا يُفشل الإصدار أبداً: الصلاحية وسمٌ
 * معلوماتي، ومسارات الإصدار (ومنها الفوترة الإلكترونية) لا تُمسّ.
 */
import prisma from '../config/database';
import { companyTimeZone } from './erpPayload';
import { expiryDateFor, localDateIn, shelfLifeOf } from './shelfLife';

const SALE_TYPES = ['CASH', 'CREDIT'];
const NOTE_KINDS = ['CREDIT_NOTE', 'DEBIT_NOTE'];

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** هل المرتجع في يوم `returnDay` بعد انتهاء الصلاحية؟ يوم الانتهاء نفسه آخر يومٍ صالح */
export function isExpiredOn(returnDay: string, expiresAt: Date): boolean {
  return returnDay > isoDay(expiresAt);
}

/** منطقة الشركة الزمنية — إعدادات الدفاتر ثم البلد */
export async function tenantTz(tenantId: string): Promise<string> {
  const [gl, company] = await Promise.all([
    prisma.glSettings.findUnique({ where: { tenantId }, select: { timezone: true } }),
    prisma.companySettings.findUnique({ where: { tenantId }, select: { countryCode: true } }),
  ]);
  return companyTimeZone(gl?.timezone, company?.countryCode);
}

const LIFE = { shelfLifeEnabled: true, shelfLifeValue: true, shelfLifeUnit: true } as const;

/** يحسب ويسجّل صلاحية بنود فاتورةٍ أو مرتجع صدر للتوّ */
export async function stampInvoiceExpiry(tenantId: string, invoiceId: string): Promise<void> {
  const inv = await prisma.invoice.findFirst({
    where: { id: invoiceId, tenantId },
    select: {
      id: true, type: true, documentKind: true, invoiceDate: true, clientCreatedAt: true, customerId: true,
      items: { select: { id: true, productId: true, creditedItemId: true, returnOfItemId: true, product: { select: LIFE } } },
    },
  });
  if (!inv) return;
  const lines = inv.items.filter((it) => it.productId && it.product && shelfLifeOf(it.product));
  if (!lines.length) return;
  const tz = await tenantTz(tenantId);
  const isReturn = inv.type === 'RETURN' || inv.documentKind === 'CREDIT_NOTE';

  if (!isReturn) {
    if (inv.documentKind === 'DEBIT_NOTE' || !SALE_TYPES.includes(inv.type)) return;
    await prisma.$transaction([
      ...lines.map((it) => prisma.invoiceItem.update({
        where: { id: it.id },
        data: { expiresAt: expiryDateFor(it.product!, inv.invoiceDate, tz) },
      })),
      touchInvoice(inv.id),
    ]);
    return;
  }

  // يوم المرتجع: لحظة إنشائه على الجهاز إن رُفع لاحقاً (دون اتصال) — لا يوم المزامنة
  const returnDay = localDateIn(inv.clientCreatedAt ?? inv.invoiceDate, tz);
  const updates = [];
  for (const it of lines) {
    // البيع الذي يُقاس عليه: بند الأصل للمرتجع المرتبط (إشعار دائن أو مرتجعٌ من فاتورة بيع)، وإلا آخر بيعٍ لهذا الصنف
    // لهذا العميل قبل المرتجع
    const linkedSaleItem = it.creditedItemId ?? it.returnOfItemId;
    const sale = linkedSaleItem
      ? await prisma.invoiceItem.findFirst({
        where: { id: linkedSaleItem, invoice: { tenantId } },
        select: { invoiceId: true, expiresAt: true, invoice: { select: { invoiceDate: true } } },
      })
      : await prisma.invoiceItem.findFirst({
        where: {
          productId: it.productId,
          invoice: {
            tenantId, customerId: inv.customerId, id: { not: inv.id },
            type: { in: SALE_TYPES }, status: { not: 'CANCELLED' },
            OR: [{ documentKind: null }, { documentKind: { notIn: NOTE_KINDS } }],
            invoiceDate: { lte: inv.invoiceDate },
          },
        },
        orderBy: [{ invoice: { invoiceDate: 'desc' } }, { invoice: { createdAt: 'desc' } }],
        select: { invoiceId: true, expiresAt: true, invoice: { select: { invoiceDate: true } } },
      });
    if (!sale) continue;
    // بيعٌ قبل الميزة بلا لقطة: يُحسب من تاريخه بصلاحية الصنف الحالية
    const expiresAt = sale.expiresAt ?? expiryDateFor(it.product!, sale.invoice.invoiceDate, tz);
    if (!expiresAt) continue;
    updates.push(prisma.invoiceItem.update({
      where: { id: it.id },
      data: { expiresAt, returnExpired: isExpiredOn(returnDay, expiresAt), expirySaleInvoiceId: sale.invoiceId },
    }));
  }
  if (updates.length) await prisma.$transaction([...updates, touchInvoice(inv.id)]);
}

/**
 * البنود بلا طابع تعديل وتُضمَّن في الفاتورة، والختم يجري بعد ردّ الإصدار — فيُلمس طابع الفاتورة معه،
 * وإلا قرأت مزامنةٌ (ERP أو /api/v1/sync) الفاتورة قبل الختم ولم ترَ صلاحية بنودها أبداً.
 */
const touchInvoice = (id: string) => prisma.invoice.update({ where: { id }, data: { updatedAt: new Date() } });

/**
 * صلاحية بنود مرتجعٍ مرتبط بفاتورة بيع (services/returnLinks.ts) — تُحسب **قبل** الإصدار فتُكتب مع بنوده داخل معاملته:
 * لو سُجّلت بعدها وتعثّر التسجيل لدخل المنتهي المتاحَ للبيع في السيارة. خريطة بند البيع ⇒ ما يُكتب على بند المرتجع.
 */
export async function linkedReturnExpiry(
  tenantId: string, saleItemIds: string[], returnAt: Date,
): Promise<Map<string, { expiresAt: Date; returnExpired: boolean; expirySaleInvoiceId: string }>> {
  const out = new Map<string, { expiresAt: Date; returnExpired: boolean; expirySaleInvoiceId: string }>();
  if (!saleItemIds.length) return out;
  const [rows, tz] = await Promise.all([
    prisma.invoiceItem.findMany({
      where: { id: { in: saleItemIds }, invoice: { tenantId } },
      select: { id: true, invoiceId: true, expiresAt: true, invoice: { select: { invoiceDate: true } }, product: { select: LIFE } },
    }),
    tenantTz(tenantId),
  ]);
  const returnDay = localDateIn(returnAt, tz);
  for (const r of rows) {
    const expiresAt = r.expiresAt ?? (r.product ? expiryDateFor(r.product, r.invoice.invoiceDate, tz) : null);
    if (expiresAt) out.set(r.id, { expiresAt, returnExpired: isExpiredOn(returnDay, expiresAt), expirySaleInvoiceId: r.invoiceId });
  }
  return out;
}

/**
 * بعد ردّ الإصدار: إن صدر مستندٌ جديد (201) تُسجَّل صلاحية بنوده. لا يرمي أبداً — فشلُه يُسجَّل في السجلّ
 * والمستند صادرٌ كما هو.
 */
export async function stampExpiryAfterIssue(tenantId: string, status: number, body: unknown): Promise<void> {
  if (status !== 201) return;
  const id = (body as { data?: { id?: unknown } } | null)?.data?.id;
  if (typeof id !== 'string') return;
  try {
    await stampInvoiceExpiry(tenantId, id);
  } catch (err) {
    console.error('invoice expiry stamp failed:', id, (err as Error)?.message);
  }
}
