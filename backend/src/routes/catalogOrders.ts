import { Router, Response, NextFunction } from 'express';
import { Prisma } from '@prisma/client';
import prisma from '../config/database';
import { authenticate, tenantId } from '../middleware/auth';
import { AuthRequest } from '../types';
import { visibleCustomerIds } from '../services/customerScope';
import {
  CATALOG_ORDER_CODES as CODES, MINE_LIST_LIMIT, OPEN_STATUSES, isUuid, matchableKey, openCounts, parseStatusBody, phoneTail,
  pickMatchedCustomer, shapeOrder, type CustomerCandidate,
} from '../services/catalogOrders';
// «أرشيف العميل — السجل الزمني» (طلب المالك ٢٦ نوفمبر ٢٠٢٦): إغلاق طلب المنيو (تم/إلغاء) حدثٌ في سجلّ عميله — بقاعدة النسبة الواحدة
// (catalogOrderCustomer): عميل أوّل سطرٍ للطلب في السجلّ، وإلا العميل الوحيد المطابق بجواله لحظة الطلب — لا عميل الفاتورة المربوطة
import { activityMeta, catalogOrderCustomer, hasActivityTable, recordActivityInTx } from '../services/customerActivityEvents';

/**
 * «طلب من المنيو» (طلب المالك ٢٤ نوفمبر ٢٠٢٦) — طلبات عملاء منيو المنتجات العام كما يراها المندوب صاحب الرابط، مُركَّبٌ على
 * /api/catalog-orders. المنطق الصافي في services/catalogOrders.ts، والإرسال العلني في routes/publicCatalog.ts.
 *
 * للمندوب وحده (SALES_REP، وغيره ٤٠٣)، وكل استعلام مقيَّدٌ بشركته وبه نفسه (tenantId + salesRepId = req.user.id) — فلا يرى
 * مندوبٌ طلب زميله ولو عرف معرّفه. والشركة التي أُطفئ لها المنيو (Tenant.catalogEnabled): القوائم فارغة والعدّاد صفر فتختفي
 * الأيقونة، والكتابة ٤٠٤ — كأن لا طلبات.
 *   GET  /mine?status=open|all    طلباته الأحدث أولاً (حتى ١٠٠؛ open = NEW|SEEN، الافتراضي) بأسطرها و`matchedCustomer`
 *   GET  /mine/count              { open, fresh } — عدّاد أيقونة «طلب جديد» (fresh = NEW لم يفتحه بعد)
 *   POST /:id/seen                NEW ⇒ SEEN عند فتحه، ومتكرّرٌ بلا أثر
 *   POST /:id/status {status: DONE|CANCELLED, invoiceId?}   إغلاقه من NEW|SEEN وحدهما (وإلا ٤٠٩ بحالته)، والفاتورة المربوطة
 *                                 فاتورةٌ للشركة أصدرها هو (وإلا ٤٠٠)
 */
const router = Router();
router.use(authenticate);
router.use((req: AuthRequest, res: Response, next: NextFunction) => {
  if (req.user?.role !== 'SALES_REP') { res.status(403).json({ success: false, message: 'غير مسموح' }); return; }
  next();
});

/** المنيو مفعّلٌ للشركة؟ (صريحاً true وحده — تعذّر القراءة يُخفي لا يُظهر، كبوّابة المنيو العام) */
async function catalogOn(tid: string): Promise<boolean> {
  const t = await prisma.tenant.findUnique({ where: { id: tid }, select: { catalogEnabled: true } });
  return t?.catalogEnabled === true;
}

/** سقف المرشّحين لمطابقة الجوال في القائمة الواحدة — مئة طلبٍ وعملاءٌ قليلون لكل جوال */
const CANDIDATES_LIMIT = 500;

/**
 * `matchedCustomer` لكل طلب: أحدث عميلٍ غير محذوف في الشركة جوّاله بمفتاح الطلب ويصل إليه المندوب (services/catalogOrders.ts
 * pickMatchedCustomer). مسحٌ واحد لعملاء الشركة يرشّح بآخر ثمانية أرقام من الجوال (بعد ترجمة الأرقام الهندية) ثم الحكم بالمفتاح
 * الكامل في JS — لا يُحمَّل عملاء الشركة إلى الذاكرة. والوصول بقيد العزل نفسه الذي يحكم به canAccessCustomer (customerScope):
 * بلا قيدٍ ⇒ الكل، وبقيدٍ ⇒ استعلامٌ واحد للمرشّحين معاً بدل استعلامٍ لكل مرشّح
 */
async function matchCustomers(req: AuthRequest, tid: string, orders: readonly { id: string; phoneKey: string | null }[]) {
  const out = new Map<string, { id: string; name: string } | null>();
  const keys = [...new Set(orders.map((o) => o.phoneKey).filter(matchableKey))];
  if (keys.length === 0) return out;
  const tails = [...new Set(keys.map(phoneTail))];
  const rows = await prisma.$queryRaw<CustomerCandidate[]>`
    SELECT id, name, phone, "createdAt" FROM customers
    WHERE "tenantId" = ${tid} AND status <> 'DELETED'
      AND right(regexp_replace(translate(coalesce(phone, ''), '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789'), '[^0-9]', '', 'g'), 8) IN (${Prisma.join(tails)})
    ORDER BY "createdAt" DESC, id DESC
    LIMIT ${Prisma.raw(String(CANDIDATES_LIMIT))}`;
  const candidates = rows ?? [];
  // null = بلا قيد. الحكم في customerScope.ts (visibleCustomerIds) لا هنا: لا يفحص مسارٌ مفاتيح النطاق بنفسه
  const visible = candidates.length > 0 ? await visibleCustomerIds(req, tid, candidates.map((c) => c.id)) : null;
  const canSee = (id: string) => visible === null || visible.has(id);
  for (const o of orders) out.set(o.id, pickMatchedCustomer(o.phoneKey, candidates, canSee));
  return out;
}

router.get('/mine', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    if (!(await catalogOn(tid))) { res.json({ success: true, data: [] }); return; }
    const all = req.query.status === 'all';
    const orders = await prisma.catalogOrder.findMany({
      where: { tenantId: tid, salesRepId: req.user!.id, ...(all ? {} : { status: { in: [...OPEN_STATUSES] } }) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: MINE_LIST_LIMIT,
      select: {
        id: true, status: true, customerName: true, customerPhone: true, phoneKey: true, note: true, invoiceId: true,
        decidedAt: true, createdAt: true,
        // الأسطر بلا عمود ترتيب: بالاسم ثابتاً، لا بترتيب القاعدة المتقلّب بين طلبين
        items: {
          orderBy: [{ productName: 'asc' }, { id: 'asc' }],
          select: { id: true, productId: true, productName: true, unitName: true, unitFactor: true, qty: true, unitPrice: true, taxPct: true },
        },
      },
    });
    const matched = await matchCustomers(req, tid, orders);
    res.json({ success: true, data: orders.map((o) => shapeOrder(o, matched.get(o.id) ?? null)) });
  } catch (err) { next(err); }
});

router.get('/mine/count', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    if (!(await catalogOn(tid))) { res.json({ success: true, data: { open: 0, fresh: 0 } }); return; }
    const groups = await prisma.catalogOrder.groupBy({
      by: ['status'],
      where: { tenantId: tid, salesRepId: req.user!.id, status: { in: [...OPEN_STATUSES] } },
      _count: { _all: true },
    });
    res.json({ success: true, data: openCounts(groups) });
  } catch (err) { next(err); }
});

router.post('/:id/seen', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const id = req.params.id;
    if (!isUuid(id) || !(await catalogOn(tid))) { res.status(404).json({ success: false }); return; }
    const where = { id, tenantId: tid, salesRepId: req.user!.id };
    // الشرط في التحديث نفسه (NEW وحده): فتحٌ ثانٍ أو بعد الإغلاق لا يغيّر شيئاً
    const r = await prisma.catalogOrder.updateMany({ where: { ...where, status: 'NEW' }, data: { status: 'SEEN' } });
    if (r.count > 0) { res.json({ success: true, data: { id, status: 'SEEN' } }); return; }
    const o = await prisma.catalogOrder.findFirst({ where, select: { id: true, status: true } });
    if (!o) { res.status(404).json({ success: false }); return; }
    res.json({ success: true, data: o });
  } catch (err) { next(err); }
});

router.post('/:id/status', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const repId = req.user!.id;
    const id = req.params.id;
    if (!isUuid(id) || !(await catalogOn(tid))) { res.status(404).json({ success: false }); return; }
    const parsed = parseStatusBody(req.body);
    if (!parsed.ok) { res.status(400).json({ success: false, code: CODES.BAD_INPUT, field: parsed.field }); return; }
    // الفاتورة المربوطة من الشركة نفسها وأصدرها هذا المندوب — لا يُلصق بطلبه معرّفُ فاتورة زميله أو شركةٍ أخرى.
    // وعميلها ورقمها في السؤال نفسه: تفاصيل حدث الإغلاق في «أرشيف العميل» (وعميلها لطلبٍ لم يُنسب لأحد)
    let linked: { id: string; customerId?: string | null; number?: string | null } | null = null;
    if (parsed.invoiceId) {
      linked = await prisma.invoice.findFirst({ where: { id: parsed.invoiceId, tenantId: tid, salesRepId: repId }, select: { id: true, customerId: true, number: true } });
      if (!linked) { res.status(400).json({ success: false, code: CODES.INVOICE_INVALID }); return; }
    }
    const where = { id, tenantId: tid, salesRepId: repId };
    // «أرشيف العميل»: حالة الطلب وجواله ولحظته قبل الإغلاق (للحدث وحده — ومقبضٌ بلا جدول السجل لا يسأل)
    const before = hasActivityTable(prisma)
      ? await prisma.catalogOrder.findFirst({ where, select: { status: true, phoneKey: true, createdAt: true } })
      : null;
    const decidedAt = new Date();
    // الإغلاق وحدثه في «أرشيف العميل» معاملةٌ واحدة (QA ٢٧ نوفمبر): يُلتزمان معاً أو يُتراجعان معاً — لا إغلاق بلا حدثه (كان الحدث
    // بعد الالتزام فيضيع لو تعذّر)، وتعذّر الحدث أو قراءة عميله يُلغي الإغلاق فيعيده التطبيق (لا تُبتلع قراءةٌ فاشلة داخل المعاملة:
    // معاملة PostgreSQL بعد خطأٍ لا تلتزم شيئاً)
    const r = await prisma.$transaction(async (tx) => {
      // من NEW|SEEN وحدهما، والشرط في التحديث نفسه: إغلاقان متزامنان (تم وإلغاء من جهازين) يفوز أحدهما ويُردّ الآخر ٤٠٩
      const done = await tx.catalogOrder.updateMany({
        where: { ...where, status: { in: [...OPEN_STATUSES] } },
        data: { status: parsed.status, invoiceId: parsed.invoiceId, decidedAt },
      });
      // «أرشيف العميل»: الإغلاق حدث CATALOG_ORDER_UPDATED بفاعل المندوب على عميل الطلب بالقاعدة الواحدة (catalogOrderCustomer): عميل
      // أوّل سطرٍ للطلب في السجلّ، وإلا العميل الوحيد المطابق بجواله لحظة الطلب — فاتورةٌ لعميلٍ آخر لا تنقل الطلب إليه فيظهر على عميلين.
      // وطلبٌ لم يُنسب لأحد (لا سطر ولا مطابقٌ وحيد) وأُغلق بفاتورة: عميل الفاتورة — فيصير سطره الأوّل وعميلَه النهائيّ (لا يُشتقّ لغيره).
      // والفاتورة في التفاصيل
      if (done.count === 0 || !before) return done;
      const customerId = (await catalogOrderCustomer(tx, tid, { id, phoneKey: before.phoneKey, createdAt: before.createdAt }))
        ?? linked?.customerId ?? null;
      if (customerId) {
        const meta = activityMeta(req);
        await recordActivityInTx(tx, {
          tenantId: tid, customerId, action: 'CATALOG_ORDER_UPDATED', actor: meta.actor, source: meta.source, refType: 'CATALOG_ORDER', refId: id,
          data: {
            oldStatus: before.status, newStatus: parsed.status,
            ...(linked && { invoiceId: linked.id, ...(linked.number && { invoiceNo: linked.number }) }),
          },
        });
      }
      return done;
    });
    if (r.count === 0) {
      const o = await prisma.catalogOrder.findFirst({ where, select: { status: true } });
      if (!o) { res.status(404).json({ success: false }); return; }
      // الحالة الحالية في الردّ: إعادة محاولةٍ بعد انقطاعٍ تجد الطلب مغلقاً بالحالة التي طلبتها فيعدّها التطبيق نجاحاً
      res.status(409).json({ success: false, code: CODES.CLOSED, status: o.status });
      return;
    }
    res.json({ success: true, data: { id, status: parsed.status, invoiceId: parsed.invoiceId, decidedAt } });
  } catch (err) { next(err); }
});

export default router;
