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
 *
 * «تتبّع اللوط» (D12): بند الصنف المتتبَّع يُختم **داخل** معاملة إصداره من انتهاء تشغيلته، أو من اللقطة القائمة محسوبةً قبلها
 * (services/lotsInvoice.ts)، فالختم اللاحق يتخطّى كل بندٍ مختوم أصلاً (`expiresAt != null`) — سطرٌ واحد بلا استعلام ولا علم.
 */
import type { Prisma } from '@prisma/client';
import prisma from '../config/database';
import { companyTimeZone } from './erpPayload';
import { baseQtyOf } from './units';
import {
  expiryDateFor, fifoBatchAt, localDateIn, purchaseExpiry, returnRuleProblem, shelfLifeBasisOf, shelfLifeOf,
  type ReturnRuleSettings, type ShelfLifeSettings,
} from './shelfLife';

const SALE_TYPES = ['CASH', 'CREDIT'];
const NOTE_KINDS = ['CREDIT_NOTE', 'DEBIT_NOTE'];

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** هل المرتجع في يوم `returnDay` بعد انتهاء الصلاحية؟ يوم الانتهاء نفسه آخر يومٍ صالح */
export function isExpiredOn(returnDay: string, expiresAt: Date): boolean {
  return returnDay > isoDay(expiresAt);
}

/**
 * منطقة الشركة الزمنية من قيمتين مقروءتين: منطقة إعدادات الدفاتر (glSettings.timezone) ثم بلد الشركة (companySettings.countryCode) —
 * حساب tenantTz نفسه بلا استعلام، لمستدعٍ قرأ البلد أصلاً في استعلامه (GET /price-lists)
 */
export function companyZoneOf(glTimezone: string | null | undefined, countryCode: string | null | undefined): string {
  return companyTimeZone(glTimezone, countryCode);
}

/** منطقة الشركة الزمنية — إعدادات الدفاتر ثم البلد */
export async function tenantTz(tenantId: string): Promise<string> {
  const [gl, company] = await Promise.all([
    prisma.glSettings.findUnique({ where: { tenantId }, select: { timezone: true } }),
    prisma.companySettings.findUnique({ where: { tenantId }, select: { countryCode: true } }),
  ]);
  return companyZoneOf(gl?.timezone, company?.countryCode);
}

const LIFE = { shelfLifeEnabled: true, shelfLifeValue: true, shelfLifeUnit: true, shelfLifeBasis: true, shelfLifeFromDate: true } as const;

/** عميل قراءات الصلاحية: prisma افتراضاً، أو قاعدةٌ يمرّرها المستدعي (lotsInvoice.freeReturnStamps قبل معاملة الإصدار) */
export type ExpiryDb = Pick<Prisma.TransactionClient, 'invoiceItem' | 'vanLoadItem' | 'vanLoad'>;

/**
 * صلاحية ما بيع في بند بيعٍ حسب **أساس الصنف** (services/shelfLife.ts): البيع ⇒ يوم الفاتورة؛ الشراء ⇒ التاريخ المكتوب
 * في الصنف؛ تحميل السيارة ⇒ دفعة التحميل التي صُرف منها هذا البيع (الأقدم أولاً). null لصنفٍ بلا صلاحية أو بلا أساسٍ
 * معروف (شراءٌ بلا تاريخ، أو تحميلٌ لبيعٍ بلا مندوب أو قبل أيّ تحميل).
 */
export async function saleExpiryFor(
  tenantId: string, tz: string, product: ShelfLifeSettings,
  sale: { invoiceId: string; invoiceDate: Date; salesRepId: string | null; productId: string; clientCreatedAt?: Date | null },
  db: ExpiryDb = prisma,
): Promise<Date | null> {
  if (!shelfLifeOf(product)) return null;
  const basis = shelfLifeBasisOf(product);
  if (basis === 'PURCHASE') return purchaseExpiry(product);
  if (basis === 'VAN_LOAD') {
    if (!sale.salesRepId) return null;
    const at = await vanLoadBatchAt(tenantId, sale.salesRepId, sale.productId, sale.invoiceId, sale.invoiceDate, db, sale.clientCreatedAt);
    return at ? expiryDateFor(product, at, tz) : null;
  }
  return expiryDateFor(product, sale.invoiceDate, tz);
}

/**
 * لحظة دفعة التحميل التي يُصرف منها بيعٌ في سيارة المندوب: التحميلات حتى لحظة البيع، والمصروف قبله = مبيعاته المؤكَّدة
 * السابقة من الصنف + ما نزّله للمستودع — والأقدم يُصرف أولاً (fifoBatchAt).
 *
 * الدفعات والمصروف كلّها **بالأساس** (الوحدات المتعددة): `_sum.qty` يجمع كراتين وحبّات رقماً واحداً فتُختار دفعةٌ
 * خاطئة، فتاريخ انتهاءٍ خاطئ، فيدخل المرتجع الدلو الخطأ (منتهي/متاح). و`baseQty` عمودٌ يحرسه مُطلِق القاعدة.
 *
 * «تصفير المخزون» (طلب المالك ١ نوفمبر ٢٠٢٦): آخر حركة تصفيرٍ لسيارة هذا المندوب حتى لحظة البيع (`zeroRunId` غير فارغ)
 * **بدايةٌ جديدة** — ما قبلها من دفعات ومصروف لا يُحسب. التصفير يُسقط الرصيد بحركة ADJUST لا يراها هذا الحساب، فلولا
 * الحدّ لبقيت دفعات ما قبل التصفير «غير مستنفدة» وطابق البيعُ الجديد دفعةً صُفّرت: انتهاءٌ أبكر من الحقيقي، فمرتجعٌ يدخل
 * الدلو الخطأ. بلا تصفيرٍ للمندوب: الاستعلامات الثلاثة كما كانت حرفاً بحرف.
 *
 * والحدّ يُقاس على **لحظة البيع على الجهاز** (`clientCreatedAt`) لا يوم المزامنة: بيعٌ دون اتصال قبل التصفير رُفع بعده
 * يحمل `invoiceDate` = لحظة الرفع، فلو قيس عليها لطابق دفعات ما بعد التصفير (انتهاءٌ أبعد من الحقيقي) وهو خرج من بضاعةٍ
 * قبله. ولحظة الجهاز بعد لحظة الرفع (ساعةٌ متقدّمة) لا تُعتمد — لا تصفير بعد الرفع يصير حدّاً لبيعٍ قبله.
 */
async function vanLoadBatchAt(
  tenantId: string, repId: string, productId: string, invoiceId: string, saleAt: Date, db: ExpiryDb, clientCreatedAt?: Date | null,
): Promise<Date | null> {
  const deviceAt = clientCreatedAt && clientCreatedAt < saleAt ? clientCreatedAt : saleAt;
  const cut = await zeroCutoffAt(tenantId, repId, deviceAt, db);
  // بعد الحدّ وحده — شرطٌ إضافي في AND فيبقى شرط لحظة البيع كما هو، وبلا حدٍّ لا شيء يُضاف
  const loadAfter = cut ? { AND: [{ createdAt: { gt: cut } }] } : {};
  // والبيع السابق مصروفٌ بعد الحدّ إن كانت لحظته على الجهاز بعده: بيعٌ دون اتصال قبل التصفير رُفع بعده خرج من بضاعةٍ صُفّرت،
  // فلو عُدّ مصروفاً من دفعات ما بعده لدفع البيع الحقيقي التالي إلى دفعةٍ أحدث من دفعته. ورفعُه بعد الحدّ شرطٌ قائم: ما رُفع
  // قبل التصفير خرج قبله وإن تقدّمت ساعة جهازه
  const saleAfter = cut
    ? { AND: [{ invoiceDate: { gt: cut } }, { OR: [{ clientCreatedAt: null }, { clientCreatedAt: { gt: cut } }] }] }
    : {};
  const [loads, sold, unloaded] = await Promise.all([
    db.vanLoadItem.findMany({
      where: { productId, vanLoad: { tenantId, salesRepId: repId, type: 'LOAD', createdAt: { lte: saleAt }, ...loadAfter } },
      select: { qty: true, unitFactor: true, baseQty: true, vanLoad: { select: { createdAt: true } } },
    }),
    db.invoiceItem.aggregate({
      where: {
        productId,
        invoice: {
          tenantId, salesRepId: repId, status: 'CONFIRMED', type: { not: 'RETURN' }, id: { not: invoiceId }, invoiceDate: { lt: saleAt },
          ...saleAfter,
        },
      },
      _sum: { baseQty: true },
    }),
    db.vanLoadItem.aggregate({
      where: { productId, vanLoad: { tenantId, salesRepId: repId, type: 'UNLOAD', createdAt: { lt: saleAt }, ...loadAfter } },
      _sum: { baseQty: true },
    }),
  ]);
  return fifoBatchAt(
    loads.map((l) => ({ qty: baseQtyOf(l), at: l.vanLoad.createdAt })),
    Number(sold._sum.baseQty ?? 0) + Number(unloaded._sum.baseQty ?? 0),
  );
}

/**
 * لحظة آخر تصفيرٍ لسيارة المندوب حتى لحظة البيع، أو null. «حتى لحظة البيع» لا «آخر تصفيرٍ مطلقاً»: بيعٌ قديم بلا لقطة
 * يُحسب لاحقاً (المرتجع المرتبط أو الحرّ) يُقاس على دفعاته هو قبل التصفير الذي جاء بعده. حركات التصفير الواحد (تسوية
 * وتالف ومنتهي) متقاربةُ اللحظة فأحدثها هو الحدّ.
 */
async function zeroCutoffAt(tenantId: string, repId: string, saleAt: Date, db: ExpiryDb): Promise<Date | null> {
  const z = await db.vanLoad.findFirst({
    where: { tenantId, salesRepId: repId, zeroRunId: { not: null }, createdAt: { lte: saleAt } },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });
  return z?.createdAt ?? null;
}

/** يحسب ويسجّل صلاحية بنود فاتورةٍ أو مرتجع صدر للتوّ */
export async function stampInvoiceExpiry(tenantId: string, invoiceId: string): Promise<void> {
  const inv = await prisma.invoice.findFirst({
    where: { id: invoiceId, tenantId },
    select: {
      id: true, type: true, documentKind: true, invoiceDate: true, clientCreatedAt: true, customerId: true, salesRepId: true,
      items: { select: { id: true, productId: true, creditedItemId: true, returnOfItemId: true, expiresAt: true, product: { select: LIFE } } },
    },
  });
  if (!inv) return;
  // البند المختوم داخل معاملة إصداره (تشغيلة الصنف المتتبَّع، أو صلاحية المرتجع المرتبط) لا يُكتب فوقه (D12)
  const lines = inv.items.filter((it) => it.productId && it.product && shelfLifeOf(it.product) && it.expiresAt == null);
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
        // بيعٌ دون اتصال: لحظته على الجهاز هي ما يُقاس عليه حدّ التصفير، لا لحظة الرفع
        clientCreatedAt: inv.clientCreatedAt,
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
  // المرتجع الحرّ (بلا ربط): آخر بيعٍ لهذا الصنف لهذا العميل قبل المرتجع — freeReturnStamps نفسها التي يختم بها المرتجع الحرّ
  // لصنفٍ متتبَّع قبل معاملته (lotsInvoice.freeReturnStamps)، فلا نسختان
  const free = await freeReturnStamps(tenantId, { id: inv.id, customerId: inv.customerId, invoiceDate: inv.invoiceDate, returnAt: inv.clientCreatedAt ?? inv.invoiceDate },
    lines.filter((it) => !(it.creditedItemId ?? it.returnOfItemId)).map((it) => ({ key: it.id, productId: it.productId!, product: it.product! })),
    { tz });
  const updates = [];
  for (const it of lines) {
    // البيع الذي يُقاس عليه: بند الأصل للمرتجع المرتبط (إشعار دائن أو مرتجعٌ من فاتورة بيع)، وإلا آخر بيعٍ لهذا الصنف
    // لهذا العميل قبل المرتجع (أعلاه)
    const linkedSaleItem = it.creditedItemId ?? it.returnOfItemId;
    let stamp: ReturnStamp | null = free.get(it.id) ?? null;
    if (linkedSaleItem) {
      const sale = await prisma.invoiceItem.findFirst({
        where: { id: linkedSaleItem, invoice: { tenantId } },
        select: { invoiceId: true, expiresAt: true, invoice: { select: { invoiceDate: true, clientCreatedAt: true, salesRepId: true } } },
      });
      if (!sale) continue;
      // بيعٌ قبل الميزة بلا لقطة: يُحسب بأساس الصنف الحالي وصلاحيته
      const expiresAt = sale.expiresAt ?? await saleExpiryFor(tenantId, tz, it.product!, {
        invoiceId: sale.invoiceId, invoiceDate: sale.invoice.invoiceDate, salesRepId: sale.invoice.salesRepId, productId: it.productId!,
        clientCreatedAt: sale.invoice.clientCreatedAt,
      });
      stamp = expiresAt ? { expiresAt, returnExpired: isExpiredOn(returnDay, expiresAt), expirySaleInvoiceId: sale.invoiceId } : null;
    }
    if (!stamp) continue;
    updates.push(prisma.invoiceItem.update({ where: { id: it.id }, data: stamp }));
  }
  if (updates.length) await prisma.$transaction([...updates, touchInvoice(inv.id)]);
}

/** ما يُكتب على بند مرتجع: انتهاء البيع الذي قيس عليه، وهل المرتجع بعده، وفاتورة ذلك البيع */
export interface ReturnStamp { expiresAt: Date; returnExpired: boolean; expirySaleInvoiceId: string }

/**
 * لقطة «آخر بيع» للمرتجع الحرّ (بلا ربط): لكل صنف آخر بيعٍ له لهذا العميل حتى تاريخ المرتجع، غير ملغى ولا إشعار — المحلّ
 * يبيع الأقدم أولاً فما يعود هو آخر ما وصله، وإن كان آخر بيعٍ منتهياً فكل ما قبله منتهٍ. الانتهاء من لقطة بند البيع (ومنها
 * المختومة من تشغيلة صنفٍ متتبَّع وإن كانت صلاحيته مطفأة، D21)، وإلا بأساس الصنف الحالي. بلا بيعٍ أو بلا انتهاءٍ معروف: لا
 * مدخل — لا تخمين. يستعملها الختم اللاحق أعلاه، والمرتجع الحرّ لصنفٍ متتبَّع **قبل** معاملة إصداره (lotsInvoice.freeReturnStamps)
 * فيُكتب داخلها (ن١-٣). `inv.id` غائبٌ قبل الإصدار (لا فاتورة بعد تُستثنى).
 */
export async function freeReturnStamps<K>(
  tenantId: string,
  inv: { id?: string | null; customerId: string; invoiceDate: Date; returnAt: Date },
  items: { key: K; productId: string; product: ShelfLifeSettings }[],
  opts: { tz?: string; db?: ExpiryDb } = {},
): Promise<Map<K, ReturnStamp>> {
  const out = new Map<K, ReturnStamp>();
  if (!items.length) return out;
  const db = opts.db ?? prisma;
  const tz = opts.tz ?? await tenantTz(tenantId);
  const returnDay = localDateIn(inv.returnAt, tz);
  for (const it of items) {
    const sale = await db.invoiceItem.findFirst({
      where: {
        productId: it.productId,
        invoice: {
          tenantId, customerId: inv.customerId, ...(inv.id ? { id: { not: inv.id } } : {}),
          type: { in: SALE_TYPES }, status: { not: 'CANCELLED' },
          OR: [{ documentKind: null }, { documentKind: { notIn: NOTE_KINDS } }],
          invoiceDate: { lte: inv.invoiceDate },
        },
      },
      orderBy: [{ invoice: { invoiceDate: 'desc' } }, { invoice: { createdAt: 'desc' } }],
      select: { invoiceId: true, expiresAt: true, invoice: { select: { invoiceDate: true, clientCreatedAt: true, salesRepId: true } } },
    });
    if (!sale) continue;
    // بيعٌ قبل الميزة بلا لقطة: يُحسب بأساس الصنف الحالي وصلاحيته
    const expiresAt = sale.expiresAt ?? await saleExpiryFor(tenantId, tz, it.product, {
      invoiceId: sale.invoiceId, invoiceDate: sale.invoice.invoiceDate, salesRepId: sale.invoice.salesRepId, productId: it.productId,
      clientCreatedAt: sale.invoice.clientCreatedAt,
    }, db);
    if (!expiresAt) continue;
    out.set(it.key, { expiresAt, returnExpired: isExpiredOn(returnDay, expiresAt), expirySaleInvoiceId: sale.invoiceId });
  }
  return out;
}

/**
 * قيد المرتجع لكل صنف (طلب المالك ١٥ أكتوبر ٢٠٢٦، `returnRuleProblem`): كل بند مرتجعٍ صنفُه قيدُه مفعّل يُقاس على البيع
 * الذي يقيس عليه الوسم (stampInvoiceExpiry): بند الأصل للمرتبط (أو بند الصنف في فاتورة الأصل)، وإلا آخر بيعٍ للصنف لهذا
 * العميل حتى تاريخ المرتجع. أول رفضٍ «اسم الصنف: السبب»، أو null. بيعٌ لا يُعرف انتهاؤه (لا بيع سابق، أو أساسٌ بلا تاريخ)
 * لا يُرفض به — لا تخمين. ويُستدعى قبل الإصدار بمرحلتيه لفاتورةٍ فيها صنفٌ قيدُه مفعّل وحدها.
 */
export async function returnRuleBlock(
  tenantId: string,
  ret: { customerId: string; saleInvoiceId: string | null; invoiceDate: Date; returnAt: Date },
  lines: { productId: string; saleItemId: string | null }[],
  products: (ReturnRuleSettings & { id: string; name: string })[],
): Promise<string | null> {
  const ruled = new Map(products.filter((p) => p.returnRuleEnabled && shelfLifeOf(p)).map((p) => [p.id, p]));
  const todo = lines.filter((l) => ruled.has(l.productId));
  if (!todo.length) return null;
  const tz = await tenantTz(tenantId);
  const returnDay = localDateIn(ret.returnAt, tz);
  const pick = { invoiceId: true, expiresAt: true, invoice: { select: { invoiceDate: true, clientCreatedAt: true, salesRepId: true } } } as const;
  for (const l of todo) {
    const p = ruled.get(l.productId)!;
    const sale = l.saleItemId
      ? await prisma.invoiceItem.findFirst({ where: { id: l.saleItemId, invoice: { tenantId } }, select: pick })
      : ret.saleInvoiceId
        ? await prisma.invoiceItem.findFirst({ where: { productId: l.productId, invoiceId: ret.saleInvoiceId, invoice: { tenantId } }, select: pick })
        : await prisma.invoiceItem.findFirst({
          where: {
            productId: l.productId,
            invoice: {
              tenantId, customerId: ret.customerId,
              type: { in: SALE_TYPES }, status: { not: 'CANCELLED' },
              OR: [{ documentKind: null }, { documentKind: { notIn: NOTE_KINDS } }],
              invoiceDate: { lte: ret.invoiceDate },
            },
          },
          orderBy: [{ invoice: { invoiceDate: 'desc' } }, { invoice: { createdAt: 'desc' } }],
          select: pick,
        });
    if (!sale) continue;
    const expiresAt = sale.expiresAt ?? await saleExpiryFor(tenantId, tz, p, {
      invoiceId: sale.invoiceId, invoiceDate: sale.invoice.invoiceDate, salesRepId: sale.invoice.salesRepId, productId: l.productId,
      clientCreatedAt: sale.invoice.clientCreatedAt,
    });
    if (!expiresAt) continue;
    const why = returnRuleProblem(p, expiresAt, returnDay);
    if (why) return `${p.name}: ${why}`;
  }
  return null;
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
      select: { id: true, invoiceId: true, productId: true, expiresAt: true, invoice: { select: { invoiceDate: true, clientCreatedAt: true, salesRepId: true } }, product: { select: LIFE } },
    }),
    tenantTz(tenantId),
  ]);
  const returnDay = localDateIn(returnAt, tz);
  for (const r of rows) {
    const expiresAt = r.expiresAt ?? (r.product && r.productId ? await saleExpiryFor(tenantId, tz, r.product, {
      invoiceId: r.invoiceId, invoiceDate: r.invoice.invoiceDate, salesRepId: r.invoice.salesRepId, productId: r.productId,
      clientCreatedAt: r.invoice.clientCreatedAt,
    }) : null);
    if (expiresAt) out.set(r.id, { expiresAt, returnExpired: isExpiredOn(returnDay, expiresAt), expirySaleInvoiceId: r.invoiceId });
  }
  return out;
}

/**
 * بعد ردّ الإصدار: إن صدر مستندٌ جديد (201) تُسجَّل صلاحية بنوده. لا يرمي أبداً — فشلُه يُسجَّل في السجلّ
 * والمستند صادرٌ كما هو.
 *
 * ومراجعة المخزون (البند ١، D6): و202 أيضاً — إشعارٌ قياسيّ تأخّر اعتماده أو CLEARED_NO_XML صدر ولم يُختم فبقي منتهيه «متاحاً
 * للبيع» — وردّ التكرار 200 (`idempotent: true`) يختم ما بقي بلا ختم (رفعٌ أوّل تعثّر ختمه). والختم يتخطّى المختوم أصلاً
 * (expiresAt != null) فلا يُعاد حساب شيء — من الآن فصاعداً بلا أثرٍ رجعيّ على ما سبق.
 */
export async function stampExpiryAfterIssue(tenantId: string, status: number, body: unknown): Promise<void> {
  const replayed = status === 200 && (body as { idempotent?: unknown } | null)?.idempotent === true;
  if (status !== 201 && status !== 202 && !replayed) return;
  const id = (body as { data?: { id?: unknown } } | null)?.data?.id;
  if (typeof id !== 'string') return;
  await stampExpiryIfMissing(tenantId, id);
}

/**
 * ختم ما بقي من بنود مستندٍ قائم بلا ختم (D6) — لردّ التكرار وسباق clientRef: الختم الأول تعثّر (فشلٌ عابر أو إعادة تشغيل
 * الخادم بعد الالتزام) فتُكمله إعادة الرفع. لا يرمي، وبلا بندٍ صنفُه بصلاحية لا كتابة (stampInvoiceExpiry نفسها).
 */
export async function stampExpiryIfMissing(tenantId: string, id: string): Promise<void> {
  try {
    await stampInvoiceExpiry(tenantId, id);
  } catch (err) {
    console.error('invoice expiry stamp failed:', id, (err as Error)?.message);
  }
}
