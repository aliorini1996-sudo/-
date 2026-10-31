import { Router, Request, Response, NextFunction } from 'express';
import prisma from '../config/database';
import { primaryUnitOf, unitPriceOf } from '../services/units';

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
 * والمفتاح غائبٌ في غيرها — فصنفٌ بلا رئيسية يبقى JSON العلن حرفاً كما كان. معرّف الوحدة يُقرأ للمطابقة ولا يُخرج.
 */
const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.get('/catalog/:tenantId/:repId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, repId } = req.params;
    if (!UUID_RE.test(tenantId) || !UUID_RE.test(repId)) { res.status(404).json({ success: false }); return; }

    const [tenant, company, rep] = await Promise.all([
      prisma.tenant.findUnique({ where: { id: tenantId }, select: { isActive: true, catalogEnabled: true } }),
      prisma.companySettings.findUnique({
        where: { tenantId },
        select: { name: true, logo: true, primaryColor: true, currency: true, phone: true },
      }),
      prisma.salesRep.findFirst({
        where: { id: repId, tenantId, isActive: true },
        select: { id: true, name: true, phone: true },
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
        name: true, unit: true, basePrice: true, taxPct: true, image: true, primaryUnitId: true,
        category: { select: { name: true } },
        // الموقوفة لا تُعرض للعلن — لا يُباع بها اليوم. والمعرّف لمطابقة الرئيسية وحدها (لا يُخرج)
        units: { where: { isActive: true }, select: { id: true, name: true, factor: true, price: true }, orderBy: [{ sortOrder: 'asc' }, { factor: 'asc' }] },
      },
    });

    res.json({
      success: true,
      data: {
        company: {
          name: company.name,
          logo: company.logo,
          primaryColor: company.primaryColor,
          currency: company.currency,
        },
        rep: { name: rep.name, contact: channel?.e164 ?? rep.phone ?? null },
        products: products.map(p => {
          const primaryId = primaryUnitOf({ primaryUnitId: p.primaryUnitId, units: p.units })?.id ?? null;
          return {
            name: p.name, unit: p.unit, basePrice: p.basePrice, taxPct: p.taxPct,
            image: p.image, category: p.category?.name ?? null,
            // السعر صافٍ قبل الضريبة كسعر الأساس، والواجهة تضيف taxPct فوقه. والفارغ يُمرَّر undefined لا null:
            // Number(null) = 0 «سعرٌ صالح» في unitPriceOf فيُعرض الكرتون مجاناً بدل الأساس × المعامل
            units: p.units.map(u => ({
              name: u.name, factor: u.factor, price: unitPriceOf({ name: u.name, factor: u.factor, price: u.price ?? undefined }, p.basePrice),
              ...(primaryId && u.id === primaryId && { isPrimary: true }),
            })),
          };
        }),
      },
    });
  } catch (err) { next(err); }
});

export default router;
