import { Router, Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import prisma from '../config/database';
import { primaryUnitOf } from '../services/units';
import { isTaxOff } from '../services/taxMode';
import { catalogOrderLimiter, catalogOrderRepLimiter } from '../middleware/rateLimits';
import { sendPushToRep } from '../services/webPush';
import { tenantTz } from '../services/invoiceExpiry';
import { companyDayOf } from '../services/lots';
import { rulesOfLists } from './priceLists';
import {
  CATALOG_ORDER_CODES as CODES, OPEN_STATUSES, isHoneypotHit, menuPriceOf, mergeOrderLines, openCapReached, orderBodyTooLarge, orderPhoneKey,
  orderPushPayload, parseOrderBody, priceOrderLines, type MenuPriceList,
} from '../services/catalogOrders';

/**
 * منيو المنتجات العام — رابط يشاركه المندوب مع عملائه:
 * fieldsa.net/c/{tenantId}/{repId}
 *
 * بلا مصادقة (عميل الشركة طرف خارجي)، والمعرّفان UUID عشوائيان فلا تعداد.
 * يُعاد فقط ما يصلح للعلن: اسم الشركة وشعارها، اسم المندوب ورقم عمله
 * (المؤسسي من تكامل هاتف إن أُسند، وإلا جوّاله)، والأصناف النشطة غير
 * المؤرشفة بأسعار القائمة — لا تكلفة ولا مخزون ولا شرائح أسعار العملاء.
 *
 * الوحدات المتعددة: `unit` و`basePrice` لوحدة الأساس (الحبة)، و`units` وحدات البيع الأكبر النشطة بمعاملها
 * وسعرها (المحدَّد لها، وإلا سعر الأساس × المعامل) — فيرى العميل سعر الكرتون لا سعر الحبة وحده.
 * وصنفٌ بلا وحدات: `units` فارغة والباقي كما كان.
 * «الوحدة الرئيسية» (القاعدة ١٢): الوحدة الرئيسية الصالحة وحدها تحمل `isPrimary: true` فيبرزها الكتالوج سعراً أوّل،
 * والمفتاح غائبٌ في غيرها — فصنفٌ بلا رئيسية يبقى JSON العلن حرفاً كما كان.
 *
 * «طلب من المنيو» (طلب المالك ٢٤ نوفمبر ٢٠٢٦): العميل يضيف أصنافاً إلى سلّةٍ ويرسل طلباً يصل المندوب صاحب الرابط
 * (services/catalogOrders.ts). فصار المنيو يُخرج `id` لكل صنفٍ ولكل وحدة (تسمّي بهما الصفحة أسطر الطلب — UUID عشوائية فلا
 * تعداد) و`orderEnabled: true` في جذر `data`؛ والباقي حرفاً كما كان. والإرسال POST /catalog/:tenantId/:repId/orders أدناه.
 *
 * «الأسعار تظهر للعملاء حسب تسعير الشركة» (المالك ٢٤ نوفمبر ٢٠٢٦): لمندوبٍ له قائمة أسعار افتراضية (SalesRep.defaultPriceListId)
 * يُعرض كل سعرٍ (`basePrice` وسعر كل وحدة) بها — menuPriceOf في services/catalogOrders.ts، والدالة نفسها تسعّر لقطة الطلب.
 * وبلا قائمة: JSON العلن حرفاً كما كان، بلا استعلامٍ زائد. وسعر العميل الخاص لا يدخل: عميل المنيو مجهول.
 */
const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * قائمة المندوب الافتراضية لأصناف المنيو — المحمِّل الواحد للعرض (GET) وللقطة الطلب (POST)، فيلتقي تقدير العميل وما رآه.
 * سعر الصنف الثابت بقراءة الفاتورة نفسها (PriceListItem لأصنافها، routes/invoices.ts)، والقواعد بما يقرؤه تطبيق المندوب
 * (rulesOfLists: قواعد الأصناف المؤرشفة خارجها) — وكلاهما بشركة الرابط، فمعرّف قائمةٍ لا يخصّها لا يُخرج شيئاً. واليوم يوم الشركة
 * بمنطقتها حين في القواعد فترة (كالفاتورة: tenantTz ثم companyDayOf)، وإلا يوم UTC بلا استعلام.
 * بلا قائمةٍ أو بلا أصنافٍ: null بلا أي استعلام؛ وقائمةٌ لا تقول شيئاً (لا أسعار ولا قواعد): null فيبقى سعر اليوم
 */
async function menuPriceListOf(tenantId: string, listId: string | null | undefined, productIds: readonly string[]): Promise<MenuPriceList | null> {
  if (!listId || !productIds.length) return null;
  const [items, rules] = await Promise.all([
    prisma.priceListItem.findMany({
      where: { tenantId, priceListId: listId, productId: { in: [...new Set(productIds)] } },
      select: { productId: true, price: true },
    }),
    rulesOfLists(tenantId, [listId]),
  ]);
  const itemOf = new Map<string, number>();
  for (const r of items ?? []) itemOf.set(r.productId, Number(r.price));
  if (!itemOf.size && !rules.length) return null;
  const now = new Date();
  const dated = rules.some((r) => r.startsOn != null || r.endsOn != null);
  const day = dated ? companyDayOf(now, await tenantTz(tenantId)) : now.toISOString().slice(0, 10);
  return { itemOf, rules, day };
}

router.get('/catalog/:tenantId/:repId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, repId } = req.params;
    if (!UUID_RE.test(tenantId) || !UUID_RE.test(repId)) { res.status(404).json({ success: false }); return; }

    const [tenant, company, rep] = await Promise.all([
      prisma.tenant.findUnique({ where: { id: tenantId }, select: { isActive: true, catalogEnabled: true } }),
      prisma.companySettings.findUnique({
        where: { tenantId },
        select: { name: true, logo: true, primaryColor: true, currency: true, phone: true, taxDisabled: true },
      }),
      prisma.salesRep.findFirst({
        where: { id: repId, tenantId, isActive: true },
        select: { id: true, name: true, phone: true, defaultPriceListId: true },
      }),
    ]);
    // بوابة الاشتراك (كنمط ERP): الميزة يفعلها المالك لكل شركة — الإطفاء = الرابط غير موجود
    if (!tenant?.isActive || !tenant.catalogEnabled || !company || !rep) { res.status(404).json({ success: false }); return; }

    // رقم العمل المؤسسي أولاً (تكامل هاتف) — يبقي علاقة العميل عند الشركة
    const channel = await prisma.workChannel.findFirst({
      where: { tenantId, assignedRepId: repId, isActive: true },
      select: { e164: true },
    });

    const products = await prisma.product.findMany({
      where: { tenantId, status: 'ACTIVE', deletedAt: null },
      orderBy: [{ category: { name: 'asc' } }, { name: 'asc' }],
      take: 500,
      select: {
        id: true, name: true, unit: true, basePrice: true, taxPct: true, image: true, primaryUnitId: true, categoryId: true,
        category: { select: { name: true } },
        // الموقوفة لا تُعرض للعلن — لا يُباع بها اليوم. والمعرّف لمطابقة الرئيسية ولتسمية وحدة سطر الطلب
        units: { where: { isActive: true }, select: { id: true, name: true, factor: true, price: true }, orderBy: [{ sortOrder: 'asc' }, { factor: 'asc' }] },
      },
    });

    // قائمة المندوب الافتراضية (null بلاها — فالأسعار كما كانت حرفاً)
    const list = await menuPriceListOf(tenantId, rep.defaultPriceListId, products.map((p) => p.id));

    // «إزالة الضريبة»: الشركة بلا ضريبة ⇒ نسبة كل صنفٍ صفر فلا يرفع المنيو السعر، وعلمها taxDisabled فيُسقط «الأسعار شاملة الضريبة».
    // والشركة بضريبتها: JSON العلن حرفاً كما كان (المفتاح غائب، والنسبة المخزَّنة)
    const taxOff = isTaxOff(company);
    res.json({
      success: true,
      data: {
        company: {
          name: company.name,
          logo: company.logo,
          primaryColor: company.primaryColor,
          currency: company.currency,
          ...(taxOff && { taxDisabled: true }),
        },
        rep: { name: rep.name, contact: channel?.e164 ?? rep.phone ?? null },
        products: products.map(p => {
          const primaryId = primaryUnitOf({ primaryUnitId: p.primaryUnitId, units: p.units })?.id ?? null;
          return {
            // سعر الأساس وأسعار الوحدات بـmenuPriceOf — دالة لقطة الطلب نفسها (قائمة المندوب إن كانت، وإلا سعر اليوم حرفاً)
            id: p.id, name: p.name, unit: p.unit, basePrice: menuPriceOf(p, null, list), taxPct: taxOff ? 0 : p.taxPct,
            image: p.image, category: p.category?.name ?? null,
            // السعر صافٍ قبل الضريبة كسعر الأساس، والواجهة تضيف taxPct فوقه
            units: p.units.map(u => ({
              id: u.id, name: u.name, factor: u.factor, price: menuPriceOf(p, u, list),
              ...(primaryId && u.id === primaryId && { isPrimary: true }),
            })),
          };
        }),
        // الصفحة تُظهر السلّة و«إتمام الطلب» بهذا العلم وحده — فواجهةٌ أحدث على خادمٍ أقدم تبقى منيو عرضٍ كما كانت
        orderEnabled: true,
      },
    });
  } catch (err) { next(err); }
});

/**
 * «طلب من المنيو» — إرسال العميل سلّته (بلا مصادقة كالمنيو نفسه):
 *   { clientRef: uuid, name 2..80, phone 5..30, note? ≤300, items: [{ productId, unitId|null, qty >0 ≤100000 بثلاث منازل }] 1..100,
 *     website?: مصيدة الروبوتات — ممتلئةٌ ⇒ 201 بمعرّفٍ وهميّ ولا يُحفظ شيء }
 * ⇒ 201 { id, repName } · المرجع نفسه مكرّراً ⇒ 200 بالمعرّف نفسه (إعادة محاولةٍ بعد انقطاع لا تصنع طلباً ثانياً).
 *
 * الحرّاس: ٤٠٤ بقواعد المنيو نفسها (الشركة نشطة ومفعّلٌ لها المنيو، والمندوب نشطٌ فيها)؛ وcatalogOrderLimiter (٥ كل ١٠ دقائق
 * لكل IP، وIPv6 بشبكته /56)؛ ثم catalogOrderRepLimiter (٣٠ في الساعة لكل مندوب — من يبدّل عناوينه لا يملأ سقف المندوب)؛ و٤١٣ لجسمٍ فوق ٢٠ ك.ب؛ و٤٢٩ CATALOG_ORDER_LIMIT لمندوبٍ عنده مئة طلبٍ مفتوح. والأسعار لقطةٌ من القاعدة بالسعر الذي
 * يعرضه المنيو — لا يُقرأ من العميل سعرٌ ولا اسم صنف — وصنفٌ أو وحدةٌ لم تعد صالحة ⇒ ٤٠٠ CATALOG_ORDER_INVALID للطلب كله.
 * والردّ لا يكشف أكثر مما يكشفه المنيو: لا يقول إن كان الجوال لعميلٍ مسجّل (المطابقة في تطبيق المندوب وحده).
 */
router.post('/catalog/:tenantId/:repId/orders', catalogOrderLimiter, catalogOrderRepLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, repId } = req.params;
    if (!UUID_RE.test(tenantId) || !UUID_RE.test(repId)) { res.status(404).json({ success: false }); return; }
    // الحجم قبل أي قاعدة. express.json العام (index.ts بسقف 10mb) يحلّل الجسم قبل الموجّه فلا يُعيد تحليلَه express.json
    // بسقفٍ أضيق هنا — فيُقاس بالبايتات الخام التي يحفظها ذلك المحلّل نفسه
    if (orderBodyTooLarge((req as Request & { rawBody?: Buffer }).rawBody?.length, req.headers['content-length'])) {
      res.status(413).json({ success: false, code: CODES.TOO_LARGE });
      return;
    }

    const [tenant, company, rep] = await Promise.all([
      prisma.tenant.findUnique({ where: { id: tenantId }, select: { isActive: true, catalogEnabled: true } }),
      prisma.companySettings.findUnique({ where: { tenantId }, select: { taxDisabled: true } }),
      prisma.salesRep.findFirst({ where: { id: repId, tenantId, isActive: true }, select: { id: true, name: true, defaultPriceListId: true } }),
    ]);
    if (!tenant?.isActive || !tenant.catalogEnabled || !company || !rep) { res.status(404).json({ success: false }); return; }

    if (isHoneypotHit(req.body)) { res.status(201).json({ success: true, data: { id: randomUUID(), repName: rep.name } }); return; }

    const parsed = parseOrderBody(req.body);
    if (!parsed.ok) { res.status(400).json({ success: false, code: CODES.BAD_INPUT, field: parsed.field }); return; }
    const input = parsed.value;

    // المرجع نفسه للشركة نفسها ⇒ الطلب نفسه (المرجع UUID تولّده الصفحة لكل إتمام). ومرجعٌ لطلب مندوبٍ آخر لا يصنعه إلا
    // عابث — يُرفض ولا يُكشف معرّف ذلك الطلب
    const replay = async (): Promise<boolean> => {
      const existing = await prisma.catalogOrder.findUnique({
        where: { tenantId_clientRef: { tenantId, clientRef: input.clientRef } },
        select: { id: true, salesRepId: true },
      });
      if (!existing) return false;
      if (existing.salesRepId !== repId) res.status(400).json({ success: false, code: CODES.BAD_INPUT, field: 'clientRef' });
      else res.status(200).json({ success: true, data: { id: existing.id, repName: rep.name } });
      return true;
    };
    if (await replay()) return;

    const lines = mergeOrderLines(input.items);
    if (!lines) { res.status(400).json({ success: false, code: CODES.BAD_INPUT, field: 'items' }); return; }

    // شروط المنيو نفسها: صنف الشركة، نشط، غير مؤرشف، ووحداته النشطة وحدها
    const products = await prisma.product.findMany({
      where: { tenantId, id: { in: [...new Set(lines.map((l) => l.productId))] }, status: 'ACTIVE', deletedAt: null },
      select: {
        id: true, name: true, basePrice: true, taxPct: true, categoryId: true, primaryUnitId: true,
        units: { where: { isActive: true }, select: { id: true, name: true, factor: true, price: true } },
      },
    });
    // السعر بالقائمة والدالة اللتين عرض بهما المنيو (menuPriceListOf ثم menuPriceOf داخل priceOrderLines): تقدير العميل هو ما رآه
    const list = await menuPriceListOf(tenantId, rep.defaultPriceListId, products.map((p) => p.id));
    const priced = priceOrderLines(lines, products, company, list);
    if (!priced.ok) { res.status(400).json({ success: false, code: CODES.INVALID }); return; }

    const open = await prisma.catalogOrder.count({ where: { tenantId, salesRepId: repId, status: { in: [...OPEN_STATUSES] } } });
    if (openCapReached(open)) { res.status(429).json({ success: false, code: CODES.LIMIT }); return; }

    let order: { id: string };
    try {
      order = await prisma.catalogOrder.create({
        data: {
          tenantId, salesRepId: repId, clientRef: input.clientRef,
          customerName: input.name, customerPhone: input.phone, phoneKey: orderPhoneKey(input.phone), note: input.note,
          items: { create: priced.lines },
        },
        select: { id: true },
      });
    } catch (e) {
      // إرسالان متزامنان بالمرجع نفسه (نقرتان، أو إعادة محاولةٍ قبل وصول الردّ): الثاني يصطدم بالفريد فيُجاب بالطلب الأول
      if ((e as { code?: string })?.code === 'P2002' && (await replay())) return;
      throw e;
    }

    res.status(201).json({ success: true, data: { id: order.id, repName: rep.name } });

    // إشعار المندوب بعد الحفظ وبلا انتظار: الطلب محفوظٌ ويظهر في التطبيق على كل حال، فتعذّر الإشعار لا يردّ العميل
    sendPushToRep(repId, orderPushPayload(input.name, priced.lines.length)).catch((err) => {
      console.error('[catalog-order] push failed:', (err as Error)?.message ?? err);
    });
  } catch (err) { next(err); }
});

export default router;
