import { Router, Response, NextFunction } from 'express';
import prisma from '../config/database';
import { requireAdmin, tenantId, isOwnerSession } from '../middleware/auth';
import { AuthRequest } from '../types';
import { customerScope } from '../services/customerScope';
import { scopedRecordWhere, SHAPE_VISIT, SHAPE_INVOICE_RECEIPT } from '../services/adminScope';
import { Prisma } from '@prisma/client';
import {
  CUSTOMER_DOC_MAX_PER_CUSTOMER, CUSTOMER_DOC_MAX_PER_REQUEST, CustomerDocInput, docCreateRows, droppedDocsWarning, isServableImage,
  parseCustomerDocs,
} from '../services/customerDocs';

/**
 * «استديو العميل» (طلب المالك ١٣ نوفمبر ٢٠٢٦): كل صورةٍ رُفعت للعميل في مكانٍ واحد — وثائقه (السجل والهوية والشهادة وصورة المحل…)،
 * وصور زياراته الميدانية، ومرفقات سندات قبضه. لمستخدمي الشركة وحدهم (requireAdmin) بصلاحية «العملاء» (الموجّه الأب) وداخل نطاقهم:
 *  • العميل نفسه بنطاق العملاء (customerScope) — خارجَه 404 كأنه غير موجود.
 *  • صور الزيارات بقيد الزيارات نفسه (SHAPE_VISIT): زيارة مندوبٍ خارج نطاق المستخدم أو فريقه لا تظهر، كقائمة الزيارات.
 *  • مرفقات السندات لمن يملك «سندات القبض» وحده، وبقيد السندات (SHAPE_INVOICE_RECEIPT).
 * القائمة بيانات وصفية بلا الصور (قد تبلغ مئات)، والصورة تُطلب وحدها عند ظهورها. وحذف الوثيقة حقيقيّ (والصلاحية canDelete
 * يفحصها authenticate لكل DELETE). صور الزيارات ومرفقات السندات للعرض وحده — تُحذف مع مستندها لا من هنا.
 */
export const customerStudioRouter = Router();

/** سقف صور الزيارات ومرفقات السندات في القائمة (الأحدث أولاً) — وما زاد يُعلَم به (truncated) لا يُسقط بصمت */
export const STUDIO_TAKE = 300;

type Source = 'doc' | 'visit' | 'receipt';
const SOURCES: readonly Source[] = ['doc', 'visit', 'receipt'];

/** العميل داخل شركة الطالب ونطاقه — أو null (فيُردّ 404) */
async function studioCustomer(req: AuthRequest, tid: string) {
  return prisma.customer.findFirst({
    where: { id: String(req.params.id), tenantId: tid, ...(await customerScope(req, tid)) },
    select: { id: true, name: true, businessName: true },
  });
}

/** مرفقات السندات لمن يملك «سندات القبض» (كمسار /receipts نفسه) — وجلسة المالك ترى كل شيء */
async function canSeeReceiptPhotos(req: AuthRequest): Promise<boolean> {
  if (isOwnerSession(req)) return true;
  if (!req.user || req.user.role === 'SALES_REP') return false;
  const admin = await prisma.admin.findUnique({ where: { id: req.user.id }, select: { isActive: true, canManageReceipts: true } });
  return !!admin?.isActive && admin.canManageReceipts !== false;
}

const visitWhereOf = async (req: AuthRequest, tid: string, customerId: string) =>
  ({ tenantId: tid, customerId, ...(await scopedRecordWhere(req, SHAPE_VISIT)) });
const receiptWhereOf = async (req: AuthRequest, tid: string, customerId: string) =>
  ({ tenantId: tid, customerId, ...(await scopedRecordWhere(req, SHAPE_INVOICE_RECEIPT)) });

const notFound = (res: Response) => res.status(404).json({ success: false, message: 'العميل غير موجود' });

const DOC_META = { id: true, kind: true, sizeBytes: true, uploadedByKind: true, uploadedByName: true, createdAt: true } as const;

/**
 * إدراج وثائق تحت قفل صفّ العميل وسقفه (CUSTOMER_DOC_MAX_PER_CUSTOMER): رفعان متزامنان لا يتجاوزانه معاً. strict = رفضٌ كامل
 * حين لا تتّسع (الاستديو: المستخدم أمام الشاشة)، وإلا يُدرج ما يتّسع ويُعدّ الباقي مُسقطاً (صفّ المندوب: لا يُعدَم عمله)
 */
async function insertDocsCapped(tid: string, customerId: string, docs: CustomerDocInput[], req: AuthRequest,
  opts: { strict: boolean; clientRef?: string | null }) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM customers WHERE id = ${customerId} FOR UPDATE`;
    const count = await tx.customerDocument.count({ where: { tenantId: tid, customerId } });
    const room = Math.max(0, CUSTOMER_DOC_MAX_PER_CUSTOMER - count);
    if (opts.strict && docs.length > room) return { over: count, created: [], skipped: 0 };
    const out: Prisma.CustomerDocumentGetPayload<{ select: typeof DOC_META }>[] = [];
    for (const r of docCreateRows(tid, docs.slice(0, room), req, opts.clientRef)) {
      out.push(await tx.customerDocument.create({ data: { ...r, customerId }, select: DOC_META }));
    }
    return { over: null, created: out, skipped: docs.length - out.length };
  });
}

// القائمة: وثائق العميل وصور زياراته ومرفقات سنداته — بلا بيانات الصور
customerStudioRouter.get('/:id/studio', requireAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const customer = await studioCustomer(req, tid);
    if (!customer) { notFound(res); return; }
    const receiptsOk = await canSeeReceiptPhotos(req);
    const [docs, visitPhotos, receiptPhotos] = await Promise.all([
      prisma.customerDocument.findMany({
        where: { tenantId: tid, customerId: customer.id },
        select: { id: true, kind: true, sizeBytes: true, uploadedByKind: true, uploadedByName: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.visitPhoto.findMany({
        where: { visit: await visitWhereOf(req, tid, customer.id) },
        select: { id: true, createdAt: true, visit: { select: { id: true, note: true, createdAt: true, salesRep: { select: { name: true } } } } },
        orderBy: { createdAt: 'desc' },
        take: STUDIO_TAKE + 1,
      }),
      receiptsOk
        ? prisma.receiptPhoto.findMany({
          where: { receipt: await receiptWhereOf(req, tid, customer.id) },
          select: { id: true, createdAt: true, receipt: { select: { id: true, number: true, status: true, receiptDate: true, salesRep: { select: { name: true } } } } },
          orderBy: { createdAt: 'desc' },
          take: STUDIO_TAKE + 1,
        })
        : Promise.resolve(null),
    ]);
    const items = [
      ...docs.map((d) => ({
        source: 'doc' as const, id: d.id, kind: d.kind, sizeBytes: d.sizeBytes, at: d.createdAt,
        by: d.uploadedByName, byKind: d.uploadedByKind,
      })),
      ...visitPhotos.slice(0, STUDIO_TAKE).map((p) => ({
        source: 'visit' as const, id: p.id, at: p.visit.createdAt, by: p.visit.salesRep?.name ?? null,
        visitId: p.visit.id, note: p.visit.note ? p.visit.note.slice(0, 200) : null,
      })),
      ...(receiptPhotos ?? []).slice(0, STUDIO_TAKE).map((p) => ({
        source: 'receipt' as const, id: p.id, at: p.receipt.receiptDate, by: p.receipt.salesRep?.name ?? null,
        receiptId: p.receipt.id, number: p.receipt.number, cancelled: p.receipt.status === 'CANCELLED',
      })),
    ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
    res.json({
      success: true,
      data: {
        customer: { id: customer.id, name: customer.name, businessName: customer.businessName },
        items,
        receiptsHidden: !receiptsOk,
        truncated: { visit: visitPhotos.length > STUDIO_TAKE, receipt: (receiptPhotos?.length ?? 0) > STUDIO_TAKE },
        limits: { perRequest: CUSTOMER_DOC_MAX_PER_REQUEST, perCustomer: CUSTOMER_DOC_MAX_PER_CUSTOMER, docCount: docs.length },
      },
    });
  } catch (err) { next(err); }
});

// صورةٌ واحدة (data URL) — بالقيود نفسها التي أظهرتها في القائمة
customerStudioRouter.get('/:id/studio/:source/:itemId', requireAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const source = String(req.params.source) as Source;
    if (!SOURCES.includes(source)) { res.status(404).json({ success: false, message: 'الصورة غير موجودة' }); return; }
    const customer = await studioCustomer(req, tid);
    if (!customer) { notFound(res); return; }
    const itemId = String(req.params.itemId);
    let row: { data: string } | null = null;
    if (source === 'doc') {
      row = await prisma.customerDocument.findFirst({ where: { id: itemId, tenantId: tid, customerId: customer.id }, select: { data: true } });
    } else if (source === 'visit') {
      row = await prisma.visitPhoto.findFirst({ where: { id: itemId, visit: await visitWhereOf(req, tid, customer.id) }, select: { data: true } });
    } else if (await canSeeReceiptPhotos(req)) {
      row = await prisma.receiptPhoto.findFirst({ where: { id: itemId, receipt: await receiptWhereOf(req, tid, customer.id) }, select: { data: true } });
    }
    // صور الزيارات والسندات نصٌّ حُفظ بلا فحص صيغة (visits.ts / receipts.ts): ما ليس data URL لصورة لا يُعاد أبداً —
    // لا رابط javascript: ولا عنوان خارجي يصير href «تنزيل» أو src صورة تتبّع
    if (!row || !isServableImage(row.data)) { res.status(404).json({ success: false, message: 'الصورة غير موجودة' }); return; }
    // الصورة لا تتغيّر بعد رفعها (تُحذف ولا تُعدَّل) — تخزينٌ خاصّ في متصفح المستخدم وحده
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.json({ success: true, data: { data: row.data } });
  } catch (err) { next(err); }
});

// رفع وثائق من الاستديو (وتعديل العميل): حتى ستّ صور في الطلب، وستون للعميل
customerStudioRouter.post('/:id/documents', requireAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const customer = await studioCustomer(req, tid);
    if (!customer) { notFound(res); return; }
    const { docs, dropped } = parseCustomerDocs(req.body?.documents);
    if (docs.length === 0) {
      res.status(400).json({ success: false, message: 'اختر صورة صالحة (JPEG أو PNG أو WebP) بحجم معقول' });
      return;
    }
    const result = await insertDocsCapped(tid, customer.id, docs, req, { strict: true });
    if (result.over != null) {
      res.status(409).json({
        success: false, code: 'CUSTOMER_DOCS_LIMIT',
        message: `بلغ العميل الحد الأقصى للوثائق (${CUSTOMER_DOC_MAX_PER_CUSTOMER}) — احذف ما لا تحتاجه ثم ارفع من جديد`,
        data: { count: result.over, max: CUSTOMER_DOC_MAX_PER_CUSTOMER },
      });
      return;
    }
    const warning = droppedDocsWarning(dropped);
    res.status(201).json({ success: true, data: result.created, ...(warning && { warnings: [warning] }) });
  } catch (err) { next(err); }
});

// حذف وثيقة — حقيقيّ بلا أرشفة (أمر المالك ٥ نوفمبر). صور الزيارات والسندات لا تُحذف من هنا
customerStudioRouter.delete('/:id/documents/:docId', requireAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const customer = await studioCustomer(req, tid);
    if (!customer) { notFound(res); return; }
    const { count } = await prisma.customerDocument.deleteMany({ where: { id: String(req.params.docId), tenantId: tid, customerId: customer.id } });
    if (count === 0) { res.status(404).json({ success: false, message: 'الوثيقة غير موجودة' }); return; }
    res.json({ success: true });
  } catch (err) { next(err); }
});

/**
 * صور وثائق العميل الجديد من صفّ المندوب دون اتصال (offlineSync: النوع customerDocs، بعد الفواتير والسندات والزيارات):
 * العميل نفسه يُرفع خفيفاً أولاً — وصوره (ميغابايتات) آخر الصفّ، فلا تحبس شبكةٌ ضعيفة فواتير اليوم خلفها.
 * للمندوب وحده، ولعميلٍ أنشأه هو (بمعرّفه أو بـclientRef العميل). إعادة الإرسال بالمفتاح نفسه لا تكرّر (ولا ما حُفظ مع العميل مباشرةً —
 * المفتاح واحد: docsBatchRef). وما لا يتّسع تحت سقف العميل يُسقط بتحذير ولا يُرفض الطلب
 */
customerStudioRouter.post('/rep-documents', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (req.user?.role !== 'SALES_REP') { res.status(403).json({ success: false, message: 'غير مسموح' }); return; }
    const tid = tenantId(req);
    const b = (req.body ?? {}) as { customerId?: unknown; customerClientRef?: unknown; clientRef?: unknown; documents?: unknown };
    const clientRef = typeof b.clientRef === 'string' ? b.clientRef.trim().slice(0, 120) : '';
    const customerId = typeof b.customerId === 'string' && b.customerId ? b.customerId : null;
    const customerClientRef = typeof b.customerClientRef === 'string' && b.customerClientRef ? b.customerClientRef : null;
    if (!clientRef || (!customerId && !customerClientRef)) {
      res.status(400).json({ success: false, message: 'طلب صور الوثائق ناقص' });
      return;
    }
    const customer = await prisma.customer.findFirst({
      where: { tenantId: tid, createdBySalesRepId: req.user.id, ...(customerId ? { id: customerId } : { clientRef: customerClientRef }) },
      select: { id: true },
    });
    if (!customer) { notFound(res); return; }
    if (await prisma.customerDocument.findFirst({ where: { tenantId: tid, customerId: customer.id, clientRef }, select: { id: true } })) {
      res.json({ success: true, data: [], idempotent: true });
      return;
    }
    const { docs, dropped } = parseCustomerDocs(b.documents);
    if (docs.length === 0) {
      res.status(400).json({ success: false, message: 'اختر صورة صالحة (JPEG أو PNG أو WebP) بحجم معقول' });
      return;
    }
    const result = await insertDocsCapped(tid, customer.id, docs, req, { strict: false, clientRef });
    const warning = droppedDocsWarning(dropped + result.skipped);
    res.status(201).json({ success: true, data: { id: customer.id, count: result.created.length }, ...(warning && { warnings: [warning] }) });
  } catch (err) { next(err); }
});
