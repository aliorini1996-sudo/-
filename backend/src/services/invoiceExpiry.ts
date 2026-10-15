/**
 * صلاحية الصنف (طلب المالك ١١ أكتوبر ٢٠٢٦، وأساسها لكل صنف ١٥ أكتوبر) — والغاية: حين يُسجَّل مرتجعٌ يُسجَّل معه هل
 * الصنف المُرتجَع منتهي الصلاحية أم لا.
 *
 * - **بند البيع** (نقدي/آجل): `expiresAt` = تاريخ انتهاء ما بيع حسب أساس الصنف (`saleExpiryFor`: البيع، أو الشراء المكتوب
 *   في الصنف، أو دفعة تحميل السيارة) — لقطةٌ لا تتغيّر إن عُدّلت صلاحية الصنف لاحقاً.
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
import { expiryDateFor, fifoBatchAt, localDateIn, purchaseExpiry, shelfLifeBasisOf, shelfLifeOf, type ShelfLifeSettings } from './shelfLife';

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

const LIFE = { shelfLifeEnabled: true, shelfLifeValue: true, shelfLifeUnit: true, shelfLifeBasis: true, shelfLifeFromDate: true } as const;

/**
 * صلاحية ما بيع في بند بيعٍ حسب **أساس الصنف** (services/shelfLife.ts): البيع ⇒ يوم الفاتورة؛ الشراء ⇒ التاريخ المكتوب
 * في الصنف؛ تحميل السيارة ⇒ دفعة التحميل التي صُرف منها هذا البيع (الأقدم أولاً). null لصنفٍ بلا صلاحية أو بلا أساسٍ
 * معروف (شراءٌ بلا تاريخ، أو تحميلٌ لبيعٍ بلا مندوب أو قبل أيّ تحميل).
 */
export async function saleExpiryFor(
  tenantId: string, tz: string, product: ShelfLifeSettings,
  sale: { invoiceId: string; invoiceDate: Date; salesRepId: string | null; productId: string },
): Promise<Date | null> {
  if (!shelfLifeOf(product)) return null;
  const basis = shelfLifeBasisOf(product);
  if (basis === 'PURCHASE') return purchaseExpiry(product);
  if (basis === 'VAN_LOAD') {
    if (!sale.salesRepId) return null;
    const at = await vanLoadBatchAt(tenantId, sale.salesRepId, sale.productId, sale.invoiceId, sale.invoiceDate);
    return at ? expiryDateFor(product, at, tz) : null;
  }
  return expiryDateFor(product, sale.invoiceDate, tz);
}

/**
 * لحظة دفعة التحميل التي يُصرف منها بيعٌ في سيارة المندوب: التحميلات حتى لحظة البيع، والمصروف قبله = مبيعاته المؤكَّدة
 * السابقة من الصنف + ما نزّله للمستودع — والأقدم يُصرف أولاً (fifoBatchAt).
 */
async function vanLoadBatchAt(tenantId: string, repId: string, productId: string, invoiceId: string, saleAt: Date): Promise<Date | null> {
  const [loads, sold, unloaded] = await Promise.all([
    prisma.vanLoadItem.findMany({
      where: { productId, vanLoad: { tenantId, salesRepId: repId, type: 'LOAD', createdAt: { lte: saleAt } } },
      select: { qty: true, vanLoad: { select: { createdAt: true } } },
    }),
    prisma.invoiceItem.aggregate({
      where: {
        productId,
        invoice: { tenantId, salesRepId: repId, status: 'CONFIRMED', type: { not: 'RETURN' }, id: { not: invoiceId }, invoiceDate: { lt: saleAt } },
      },
      _sum: { qty: true },
    }),
    prisma.vanLoadItem.aggregate({
      where: { productId, vanLoad: { tenantId, salesRepId: repId, type: 'UNLOAD', createdAt: { lt: saleAt } } },
      _sum: { qty: true },
    }),
  ]);
  return fifoBatchAt(
    loads.map((l) => ({ qty: Number(l.qty), at: l.vanLoad.createdAt })),
    Number(sold._sum.qty ?? 0) + Number(unloaded._sum.qty ?? 0),
  );
}

/** يحسب ويسجّل صلاحية بنود فاتورةٍ أو مرتجع صدر للتوّ */
export async function stampInvoiceExpiry(tenantId: string, invoiceId: string): Promise<void> {
  const inv = await prisma.invoice.findFirst({
    where: { id: invoiceId, tenantId },
    select: {
      id: true, type: true, documentKind: true, invoiceDate: true, clientCreatedAt: true, customerId: true, salesRepId: true,
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
    // الحساب قبل المعاملة (أساس تحميل السيارة يقرأ التحميلات والمبيعات السابقة)، والكتابة في معاملةٍ واحدة
    const stamped = await Promise.all(lines.map(async (it) => ({
      id: it.id,
      expiresAt: await saleExpiryFor(tenantId, tz, it.product!, {
        invoiceId: inv.id, invoiceDate: inv.invoiceDate, salesRepId: inv.salesRepId, productId: it.productId!,
      }),
    })));
    await prisma.$transaction([
      ...stamped.map((x) => prisma.invoiceItem.update({ where: { id: x.id }, data: { expiresAt: x.expiresAt } })),
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
        select: { invoiceId: true, expiresAt: true, invoice: { select: { invoiceDate: true, salesRepId: true } } },
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
        select: { invoiceId: true, expiresAt: true, invoice: { select: { invoiceDate: true, salesRepId: true } } },
      });
    if (!sale) continue;
    // بيعٌ قبل الميزة بلا لقطة: يُحسب بأساس الصنف الحالي وصلاحيته
    const expiresAt = sale.expiresAt ?? await saleExpiryFor(tenantId, tz, it.product!, {
      invoiceId: sale.invoiceId, invoiceDate: sale.invoice.invoiceDate, salesRepId: sale.invoice.salesRepId, productId: it.productId!,
    });
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
      select: { id: true, invoiceId: true, productId: true, expiresAt: true, invoice: { select: { invoiceDate: true, salesRepId: true } }, product: { select: LIFE } },
    }),
    tenantTz(tenantId),
  ]);
  const returnDay = localDateIn(returnAt, tz);
  for (const r of rows) {
    const expiresAt = r.expiresAt ?? (r.product && r.productId ? await saleExpiryFor(tenantId, tz, r.product, {
      invoiceId: r.invoiceId, invoiceDate: r.invoice.invoiceDate, salesRepId: r.invoice.salesRepId, productId: r.productId,
    }) : null);
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
