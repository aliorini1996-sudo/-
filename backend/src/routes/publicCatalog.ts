import { Router, Request, Response, NextFunction } from 'express';
import prisma from '../config/database';

/**
 * منيو المنتجات العام — رابط يشاركه المندوب مع عملائه:
 * fieldsa.net/c/{tenantId}/{repId}
 *
 * بلا مصادقة (عميل الشركة طرف خارجي)، والمعرّفان UUID عشوائيان فلا تعداد.
 * يُعاد فقط ما يصلح للعلن: اسم الشركة وشعارها، اسم المندوب ورقم عمله
 * (المؤسسي من تكامل هاتف إن أُسند، وإلا جوّاله)، والأصناف النشطة غير
 * المؤرشفة بأسعار القائمة — لا تكلفة ولا مخزون ولا شرائح أسعار العملاء.
 */
const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.get('/catalog/:tenantId/:repId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tenantId, repId } = req.params;
    if (!UUID_RE.test(tenantId) || !UUID_RE.test(repId)) { res.status(404).json({ success: false }); return; }

    const [tenant, company, rep] = await Promise.all([
      prisma.tenant.findUnique({ where: { id: tenantId }, select: { isActive: true } }),
      prisma.companySettings.findUnique({
        where: { tenantId },
        select: { name: true, logo: true, primaryColor: true, currency: true, phone: true },
      }),
      prisma.salesRep.findFirst({
        where: { id: repId, tenantId, isActive: true },
        select: { id: true, name: true, phone: true },
      }),
    ]);
    if (!tenant?.isActive || !company || !rep) { res.status(404).json({ success: false }); return; }

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
        name: true, unit: true, basePrice: true, taxPct: true, image: true,
        category: { select: { name: true } },
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
        products: products.map(p => ({
          name: p.name, unit: p.unit, basePrice: p.basePrice, taxPct: p.taxPct,
          image: p.image, category: p.category?.name ?? null,
        })),
      },
    });
  } catch (err) { next(err); }
});

export default router;
