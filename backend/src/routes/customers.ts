import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../config/database';
import { authenticate, requireAdmin, requireAdminPermission, tenantId } from '../middleware/auth';
import { AuthRequest } from '../types';

/* العميل المحذوف: صفُّه باقٍ لتقرأ فواتيرُه اسمَه، فيُستثنى صراحةً من كلّ
 * قائمةٍ لا تفلتر ACTIVE. وما يفلترها (تقرير الأرصدة مثلاً) يُسقطه وحده. */
const NOT_DELETED = { status: { not: 'DELETED' } } as const;
import { paginate, paginationMeta } from '../utils/helpers';
import { resolveLocationUrl } from '../services/geoLink';
import { explicitPinWins } from '../services/customerPinSource';
import { withDeletedProductName } from '../services/deletedProduct';
import { purgeInTx } from '../services/ownerPurge';
import { customerScope, ensureAssignment, canAccessCustomer } from '../services/customerScope';
import { scopedRecordWhere, SHAPE_INVOICE_RECEIPT, teamSupervisorIdOf } from '../services/adminScope';
import { scaleTeamRows, teamReceiptShare, teamStatementTotals } from '../services/teams';
import { deriveRunningBalances, clean } from '../services/accounting';
import { statementEntryDateFilter } from '../services/statementRange';
import { explicitTimezone } from '../services/importLedger';
import { CustomerBuyerDataDeps, applyBuyerGateToWrite, createCustomerBuyerDataRouter } from './customersZatca';
import { OUTLET_TYPE_CODES } from '../ai-rep/taxonomy';
import { linkConvertedCustomer } from '../ai-rep/convert';
import { aiRepForRep } from '../ai-rep/access';
import { invalidateEstimateData } from '../ai-rep/estimateData';
import { patchSessionOutlet } from '../ai-rep/session';
import { UnitInvalidError } from '../services/warehouseStock';
import { PRICE_LIST_MESSAGES } from '../services/priceLists';
import { CUSTOMER_PHONE_MAX } from '../services/importMatch';
import { phoneDupExempt } from '../services/customerPhoneDup';
import { findLocationDuplicate, locationDupBody, validPoint } from '../services/customerLocationDup';
import { DEVICE_NOW_HEADER, headerText, offlineInvoiceDate } from '../services/offlineInvoiceDate';
import { parseCustomerDocs, droppedDocsWarning, docCreateRows, docsBatchRef } from '../services/customerDocs';
import { customerStudioRouter } from './customerStudio';
// «الوحدة الرئيسية» §2.10: أسعار العميل لوحدة الأساس تُكتب تحت قفل صفّ الصنف مقارنةً بالأساس الذي كُتبت له
import {
  ProductUnitsBusyError, ProductUnitsChangedError, baseGuardReply, lockBases, missingBaseForApi, staleClientBase, type ExpectedBases,
} from '../services/baseGuard';

const router = Router();
router.use(authenticate);
router.use(requireAdminPermission('canManageCustomers'));

// فوترة ZATCA (Z5.1a، D2): بيانات المشتري — شركة تجمع بيانات الفوترة وحدها ((العلم || التفعيل) && SA)؛ غيرها كما اليوم
const buyerDataDeps: CustomerBuyerDataDeps = {
  db: prisma,
  customerScope: (req, tid) => customerScope(req, tid) as Promise<Record<string, unknown>>,
  canAccessCustomer,
  tenantId,
};

/**
 * جوال العميل حرّ (أمر المالك ٧ نوفمبر ٢٠٢٦: «فك القيد بالكامل… اجعل تسجيل الجوال ليس إجبارياً»): اختياريّ بلا حدٍّ أدنى
 * ولا صيغة — يُقصّ طرفاه، وسقفه ٣٠ حرفاً أماناً وحده. والعمود NOT NULL فالغائب والفارغ وnull يُخزَّن '' (لا مخطّط جديد).
 * والجوال الفارغ لا يُطابَق به عميلٌ ولا يُكشف به تكرار (لا يساوي '' فارغاً آخر). للعملاء وحدهم: جوال المندوب وربط واتساب كما هما
 * السقف معرَّفٌ مرّةً في services/importMatch.ts (يقصّ به الاستيراد) ويُعاد تصديره هنا — فلا يفترق حدّا البطاقة والاستيراد
 */
export { CUSTOMER_PHONE_MAX };

// «بلا قيود على العميل» (أمر المالك ٩ نوفمبر ٢٠٢٦): فتح العميل ونقله (اللوحة والمندوب والربط البرمجي) لا يُرفض لحقل —
// القيمة غير الصالحة تُصحَّح أو تُهمل: أي نصّ يُقبل (أرقام تُحوَّل نصاً)، والجوال والبريد كما كُتبا، والإحداثيات خارج النطاق تُهمل،
// والقيمة المجهولة في القوائم (القناة والنوع والحالة) تُهمل، والأرقام النصية تُحوَّل، والاسم الفارغ يأخذ بديلاً (customerNameFallback)
const looseText = z.preprocess((v) => (v == null ? v : typeof v === 'object' ? JSON.stringify(v) : String(v)), z.string().nullish());
const looseCoord = (lim: number) => z.preprocess((v) => {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && Math.abs(n) <= lim ? n : null;
}, z.number().nullish());
const looseNumber = z.preprocess((v) => {
  if (v == null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}, z.number().optional());
const customerSchema = z.object({
  // الرقم المرجعي للعميل في نظام المُرسِل (Odoo وغيره) يُحفظ كوداً للعميل — customerRefOf يقرأ أسماءه الشائعة أيضاً
  code: looseText,
  name: looseText,
  // nullish على الحقول النصية الاختيارية: نموذج التحرير (react-hook-form) يرسل null للحقول
  // غير المُعبّأة لعميل قائم، وz.string().optional() ترفض null فتفشل كل عملية تعديل لعميل بحقول فارغة
  businessName: looseText,
  commercialReg: looseText,
  taxNumber: looseText,
  // اختياريّ بلا حدّ — والغائب/null/الفارغ يُكتب '' في الإنشاء وفي التعديل حين يُرسل. الطويل يُقصّ إلى ٢٠٠ لا يُرفض
  phone: z.preprocess((v) => (v == null ? v : String(v).trim().slice(0, 200)), z.string().nullish()),
  altPhone: looseText,
  email: z.preprocess((v) => (v == null ? v : String(v).trim()), z.string().nullish()),
  city: looseText,
  district: looseText,
  address: looseText,
  // موقع العميل على الخريطة (اختياري): إحداثيات مباشرة أو رابط خرائط Google يحلّه الخادم
  // nullish: نموذج التحرير قد يرسل null لعميل بلا موقع
  lat: looseCoord(90),
  lng: looseCoord(180),
  locationUrl: z.preprocess((v) => (v == null ? undefined : String(v).slice(0, 2000)), z.string().optional()),
  // قناة البيع (تصنيف مؤسسي) — يقبل قيمة صحيحة أو فارغ/null/غياب (كلها = غير محدّد)، والمجهول يُهمل
  channel: z.enum(['MT', 'WHOLESALE', 'TT', 'DISCOUNTER', 'CASH_VAN', 'ECOMMERCE']).nullish().or(z.literal('')).catch(null),
  // المندوب الذكي: نوع المنفذ (أساس مقارنة المحلات المتشابهة) ومعرّف المكان في Google لمحلٍّ مقترح حُوِّل عميلاً
  outletType: z.enum(OUTLET_TYPE_CODES as unknown as [string, ...string[]]).nullish().or(z.literal('')).catch(null),
  aiPlaceId: z.string().min(1).max(300).nullish().catch(null),
  status: z.enum(['ACTIVE', 'INACTIVE', 'BLOCKED']).optional().catch(undefined),
  creditLimit: looseNumber,
  paymentDays: z.preprocess((v) => {
    if (v == null || v === '') return undefined;
    const n = Math.trunc(Number(v));
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  }, z.number().int().optional()),
  // «أنواع الأسعار»: نوع سعر العميل — null أو الفارغ = السعر الأساسي. للإدارة وحدها (يُسقط من جسم المندوب في الإنشاء والتعديل)،
  // والمعرّف من الشركة نفسها وإلا 400 PRICE_LIST_INVALID (priceListOwned)
  priceListId: z.string().nullish(),
  // العمل دون اتصال: idempotency + لحظة الإنشاء على الجهاز — nullish لأن نموذج التحرير
  // يرسلهما null لعملاء لوحة الإدارة (لا تُحرَّر؛ تُستبعد من التحديث)
  // مرجعٌ ليس UUID (معرّف نظامٍ آخر) لا يرفض العميل — يُهمل التكرار الآمن فقط
  clientRef: z.string().uuid().nullish().catch(null),
  clientCreatedAt: looseText,
});

/** «الرقم المرجعي من عندهم» (أمر المالك ٩ نوفمبر ٢٠٢٦): code أو ref أو reference أو externalRef/externalId أو erpRef/odooRef/odooId */
const CUSTOMER_REF_KEYS = ['code', 'ref', 'reference', 'externalRef', 'externalId', 'erpRef', 'odooRef', 'odooId', 'refCode'] as const;
function customerRefOf(body: unknown): string | null {
  const b = (body ?? {}) as Record<string, unknown>;
  for (const k of CUSTOMER_REF_KEYS) {
    const v = b[k];
    if (v != null && typeof v !== 'object' && String(v).trim() !== '') return String(v).trim().slice(0, 100);
  }
  return null;
}
/** عميل الشركة بهذا الرقم المرجعي (بلا تفريق أحرف) — غير المستثنى */
function customerByRef(tid: string, ref: string, exceptId?: string) {
  return prisma.customer.findFirst({
    where: { tenantId: tid, code: { equals: ref, mode: 'insensitive' }, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true },
  });
}

/** الاسم الفارغ لا يرفض العميل: اسم المنشأة، ثم الجوال، ثم «عميل» */
function customerNameFallback(d: { name?: string | null; businessName?: string | null; phone?: string | null }): string {
  return (d.name ?? '').trim() || (d.businessName ?? '').trim() || (d.phone ?? '').trim() || 'عميل';
}

/**
 * «أنواع الأسعار»: نوع العميل من الشركة نفسها — أو بلا نوع. المفتاح الأجنبي لا يعرف الشركة، فبلا الفحص يُربط عميلٌ بنوع شركةٍ
 * أخرى فتُقرأ أسعارها في فواتيره (نظير categoryOwned في الأصناف)
 */
async function priceListOwned(tid: string, priceListId: string | null | undefined): Promise<boolean> {
  if (!priceListId) return true;
  return (await prisma.priceList.count({ where: { id: priceListId, tenantId: tid } })) > 0;
}
const priceListInvalid = (res: Response) =>
  res.status(400).json({ success: false, code: 'PRICE_LIST_INVALID', message: PRICE_LIST_MESSAGES.PRICE_LIST_INVALID });

/**
 * R6 (تدقيق «هدف الشهر»، F7): لحظة إضافة عميلٍ أنشأه المندوب دون اتصال. «عملاء جدد» يعدّ العميل بـcreatedAt في نافذة الشهر، وكان
 * يُكتب بلحظة المزامنة: عميلٌ أُضيف وبيع له ٢٢:٠٠ آخر يوم ورُفع صباح الغد يسقط من شهره وفاتورتُه فيه (D11). فإعادة رفع صندوق المندوب
 * (X-FS-Replay، لا مفتاح API) تُؤرَّخ بلحظة إضافته على الجهاز (clientCreatedAt) بحصر فاتورته حرفياً — offlineInvoiceDate: مصحَّحةً
 * بانحراف ساعته عبر X-FS-Device-Now، لا مستقبل ولا أقدم من سبعة أيام. **وبمرحلة الشركة الثانية كالفاتورة**: العميل ليس مستنداً
 * ضريبياً، لكنّ العدّ يشترط له بيعاً مؤكَّداً حتى نهاية الشهر، وفاتورته الأولى بعد التفعيل تؤرَّخ بلحظة ختمها على الخادم — فلو أُرّخ هو
 * بلحظة جهازه وقع في شهرٍ وفاتورته في التالي فسقط من الشهرين. فالعميل وفاتورته الأولى يتّحدان تأريخاً دائماً.
 * وإلا null ⇒ ساعة الخادم كما كان: الإنشاء المتصل (ساعة جهازٍ منحرفة لا تنقل عميلاً أُنشئ متصلاً)، والإدارة ومفتاح API.
 * وclientCreatedAt يُخزَّن كما أُرسل في كل الأحوال. ولا استعلام إلا لإعادة رفع مندوبٍ بلحظة جهاز
 */
export async function replayCustomerCreatedAt(req: AuthRequest, tid: string, clientCreatedAt: string | null | undefined): Promise<Date | null> {
  const replay = String(req.headers['x-fs-replay'] || '') === '1';
  if (!replay || req.user?.role !== 'SALES_REP' || req.user?.apiKeyId) return null;
  if (typeof clientCreatedAt !== 'string' || clientCreatedAt.trim() === '') return null;
  const company = await prisma.companySettings.findUnique({ where: { tenantId: tid }, select: { zatcaPhase2StartedAt: true } });
  return offlineInvoiceDate({
    replay, role: req.user!.role, viaApiKey: false, bodyInvoiceDate: null, clientCreatedAt,
    deviceNow: headerText(req.headers[DEVICE_NOW_HEADER]), phase2StartedAt: company?.zatcaPhase2StartedAt ?? null, now: new Date(),
  });
}
/**
 * نوعٌ حُذف بين priceListOwned والكتابة: حذفه يقفل صفّه (routes/priceLists.ts) فيفشل مفتاح العميل الأجنبي بعده (P2003) — رفضٌ
 * مفهوم لا عطل 500. وP2003 على مفتاحٍ آخر يبقى كما كان
 */
const isPriceListFkFail = (err: unknown): boolean => {
  const e = err as { code?: unknown; meta?: { field_name?: unknown } } | null;
  return e?.code === 'P2003' && String(e.meta?.field_name ?? '').includes('priceListId');
};

router.get('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const search = req.query.search as string | undefined;
    const status = req.query.status as string | undefined;
    const channel = req.query.channel as string | undefined;

    const where = {
      tenantId: tid,
      // عزل العملاء: المندوب لا يرى إلا المُسنَدين له (عند تفعيل الشركة للميزة)
      ...(await customerScope(req, tid)),
      ...(search && {
        OR: [
          { name: { contains: search, mode: 'insensitive' as const } },
          { businessName: { contains: search, mode: 'insensitive' as const } },
          { phone: { contains: search } },
          { code: { contains: search, mode: 'insensitive' as const } },
        ],
      }),
      // «جميع الحالات» تعني الأحياء جميعاً لا المحذوفين — والحالة المطلوبة
      // تُقيَّد بها إن أُرسلت (وDELETED ليست خياراً في الواجهة)
      ...(status ? { status: status as 'ACTIVE' | 'INACTIVE' | 'BLOCKED' } : NOT_DELETED),
      ...(channel && { channel }),
    };

    const [total, customers] = await Promise.all([
      prisma.customer.count({ where }),
      prisma.customer.findMany({
        where,
        ...paginate(page, limit),
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    res.json({ success: true, data: customers, pagination: paginationMeta(total, page, limit) });
  } catch (err) { next(err); }
});

// مواقع العملاء على الخريطة (للإدارة) — من لديهم إحداثيات فقط
router.get('/locations', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const customers = await prisma.customer.findMany({
      where: { tenantId: tid, ...NOT_DELETED, lat: { not: null }, lng: { not: null }, ...(await customerScope(req, tid)) },
      select: { id: true, name: true, businessName: true, phone: true, city: true, district: true, address: true, lat: true, lng: true },
      take: 5000,
    });
    res.json({ success: true, data: customers });
  } catch (err) { next(err); }
});

// قائمة بيانات الفوترة + «اعتماد التصنيف المقترح» + نقطة الفوترة الضيّقة للمندوب (Q3) — قبل /:id وإلا التُقطت كمعرّف عميل
router.use(createCustomerBuyerDataRouter(buyerDataDeps));
// «استديو العميل» (طلب المالك ١٣ نوفمبر ٢٠٢٦): وثائقه وصور زياراته ومرفقات سنداته — لمستخدمي الشركة وحدهم (routes/customerStudio.ts)
router.use(customerStudioRouter);

router.get('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const customer = await prisma.customer.findFirst({
      where: { id: req.params.id, tenantId: tid, ...(await customerScope(req, tid)) },
      // أسعار أصناف الشركة وحدها — صفٌّ قديم رُبط بصنف شركةٍ أخرى لا يكشفه.
      // والسعر الخاص **لوحدة الأساس** (DESIGN §٤)، فتُرفق وحدات الصنف ليعرض العارض سعر الكرتون = السعر × معامله
      include: {
        customerPrices: {
          where: { product: { tenantId: tid } },
          include: { product: { include: { units: { orderBy: [{ sortOrder: 'asc' }, { factor: 'asc' }] } } } },
        },
      },
    });
    if (!customer) { res.status(404).json({ success: false, message: 'العميل غير موجود' }); return; }
    res.json({ success: true, data: customer });
  } catch (err) { next(err); }
});

router.post('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    // المندوب يحتاج صلاحية "إضافة عميل"؛ الإدارة مسموح لها دائماً
    if (req.user?.role === 'SALES_REP') {
      const rep = await prisma.salesRep.findUnique({ where: { id: req.user.id }, select: { canAddCustomer: true } });
      if (!rep?.canAddCustomer) {
        res.status(403).json({ success: false, message: 'ليس لديك صلاحية إضافة عملاء' });
        return;
      }
    }
    const data = customerSchema.parse(req.body);
    data.name = customerNameFallback(data);
    const ref = customerRefOf(req.body);
    if (ref) data.code = ref; else delete data.code;
    // «استديو العميل»: صور الوثائق مع الإنشاء نفسه (ذرّياً مع العميل — والصفّ دون اتصال يحملها معه). ما لا يصلح يُسقط بتحذير ولا يرفض العميل
    const docsIn = parseCustomerDocs(req.body?.documents);
    const docsWarning = droppedDocsWarning(docsIn.dropped);
    const docsRef = typeof data.clientRef === 'string' && data.clientRef ? docsBatchRef(data.clientRef) : null;
    const docsCreate = docsIn.docs.length > 0 ? { documents: { create: docCreateRows(tid, docsIn.docs, req, docsRef) } } : {};

    // المندوب الذي ينشئ العميل (إن كان الطالب مندوباً) — يُوثَّق ويُسنَد له العميل تلقائياً
    const creatorRepId = req.user?.role === 'SALES_REP' ? req.user.id : null;
    // «أنواع الأسعار»: نوع سعر العميل قرار الإدارة — المندوب لا يضعه لعميلٍ يفتحه (وإلا سعّر بأرخص نوعٍ بلا «تبديل نوع السعر»)
    if (creatorRepId) delete data.priceListId;
    else if (!(await priceListOwned(tid, data.priceListId))) data.priceListId = null; // نوعٌ غريب يُهمل لا يرفض العميل

    // idempotency: عميل سبق رفعه (نفس clientRef) يُعاد بدل إنشاء مكرّر
    if (data.clientRef) {
      const existing = await prisma.customer.findFirst({
        where: { tenantId: tid, clientRef: data.clientRef },
      });
      if (existing) {
        // حارس تصعيد صلاحية: إعادة الرفع بـclientRef لعميل أنشأه مندوب آخر يجب ألا
        // تمنح المُرسِل إسناداً ولا تكشف بيانات العميل. الإسناد يُضمن لمنشئه فقط.
        const isMine = !!creatorRepId && existing.createdBySalesRepId === creatorRepId;
        if (creatorRepId && !isMine && !(await canAccessCustomer(req, tid, existing.id))) {
          res.status(403).json({ success: false, message: 'هذا العميل غير مسند لك' });
          return;
        }
        if (isMine) await ensureAssignment(tid, existing.id, creatorRepId!);
        res.status(200).json({ success: true, data: existing, idempotent: true });
        return;
      }
    }

    // فوترة ZATCA (Z5.1a): حقول المشتري للشركة الجامعة وحدها (البوابة لا تُقرأ إلا إن حمل الجسم حقلاً منها أو الرقم الضريبي/السجل).
    // إنشاء بـclientRef (الرفع المؤجَّل من الصفّ) لا يُرفض أبداً: تُسقط حقول المرحلة الثانية الخاطئة ويعود warnings.
    // إلا طلب مفتاح API: clientRef حقلٌ في الجسم يكتبه المُرسِل كما يشاء، والمفتاح عميلٌ حيّ لا صندوق إرسال — فلو اشتُقّ
    // التسامح منه لتجاوز أيُّ مكامِلٍ رفض 400 CUSTOMER_ZATCA_INVALID بإضافة سطرٍ واحد (والدليل يوصيه بـclientRef لمنع التكرار)،
    // فحُفظ رقمٌ ضريبي وسجلٌّ بلا فحص. هويةُ المصادقة لا يزوّرها الجسم؛ والحارس نفسه يكرّر الشرط (applyBuyerGateToWrite)
    const buyerGate = await applyBuyerGateToWrite(buyerDataDeps, req, tid, data as Record<string, unknown>, { customerId: null, replay: !!data.clientRef && !req.user?.apiKeyId });
    if (!buyerGate.ok) { res.status(buyerGate.status).json(buyerGate.body); return; }

    // المندوب الذكي: معرّف مكان Google يُربط فقط لمندوب مفعّلة له الميزة، ولمحلٍّ ليس عميلاً للشركة أصلاً.
    // عميل قائم بالمعرّف نفسه ⇒ 409 برسالة محايدة (لا تسمّي المندوب المالك — عزل العملاء)؛ وعند إعادة الرفع من صفّ
    // الإرسال دون اتصال لا يُرفض الإنشاء (القاعدة: مستند الصفّ لا يُعدَم) بل يُسقط الربط وحده.
    if (data.aiPlaceId) {
      // الترويسة تُمحى من طلب المفتاح في المصادقة (middleware/auth.ts)؛ والشرط هنا يكرّر ذلك عند نقطة القرار نفسها كي لا يعلّق
      // أمن المسار على ترتيب الوسائط: المفتاح يعود 409 دائماً
      const replay = String(req.headers['x-fs-replay'] || '') === '1' && !req.user?.apiKeyId;
      const allowedForRep = !creatorRepId || (await aiRepForRep(tid, creatorRepId));
      const taken = allowedForRep ? await prisma.customer.findFirst({ where: { tenantId: tid, aiPlaceId: data.aiPlaceId }, select: { id: true } }) : null;
      if (taken && !replay) {
        res.status(409).json({ success: false, code: 'AI_PLACE_ALREADY_CUSTOMER', message: 'هذا المحل مسجّل عميلاً في الشركة مسبقاً — راجع الإدارة بدل إضافته مرة ثانية' });
        return;
      }
      if (!allowedForRep || taken) data.aiPlaceId = null;
    }
    const { clientCreatedAt, locationUrl, ...rest } = data;
    // «الرقم المرجعي من عندهم»: عميلٌ قائم بالرقم نفسه ⇒ يُحدَّث هو (لا عميل مكرّر في كل مزامنة) — للإدارة ومفتاح API؛
    // والمندوب لا يعدّل عميل غيره: رقمٌ مأخوذ يُترك ويُنشأ عميله بكودٍ تلقائي مع تحذير
    let refWarning: object | null = null;
    if (ref) {
      const byRef = await customerByRef(tid, ref);
      if (byRef && !creatorRepId) {
        const { clientRef: _c, aiPlaceId: _a, ...upd } = rest;
        void _c; void _a;
        const updated = await prisma.customer.update({
          where: { id: byRef.id },
          data: {
            ...upd, phone: upd.phone === undefined ? undefined : (upd.phone ?? ''), email: upd.email === undefined ? undefined : (upd.email || null),
            channel: upd.channel === undefined ? undefined : (upd.channel || null), outletType: upd.outletType === undefined ? undefined : (upd.outletType || null),
            ...(upd.priceListId !== undefined && { priceListId: upd.priceListId || null }),
          } as any,
        });
        // عميلٌ قائم بالرقم المرجعي (مزامنة نظامٍ خارجي): الوثائق لا تُضاف هنا — كل مزامنة كانت ستكرّرها بلا سقف ولا نطاق.
        // تُرفع من «استديو العميل» (بقفل الصفّ وسقف العميل)
        const ignoredDocs = docsIn.docs.length + docsIn.dropped;
        const updWarnings = [...(buyerGate.warnings ?? []), ...(ignoredDocs > 0 ? [{ code: 'CUSTOMER_DOCS_IGNORED', ignored: ignoredDocs, message: 'العميل قائم بالرقم المرجعي فلم تُضف صور الوثائق — ارفعها من استديو العميل' }] : [])];
        res.status(200).json({ success: true, data: updated, existing: true, updated: true, ...(updWarnings.length > 0 && { warnings: updWarnings }) });
        return;
      }
      if (byRef) {
        delete (rest as Record<string, unknown>).code;
        refWarning = { code: 'CUSTOMER_REF_TAKEN', message: 'الرقم المرجعي لعميلٍ آخر فأُنشئ العميل بكودٍ تلقائي', ref };
      }
    }
    // رابط موقع مُرسَل ⇒ يُحلّ إلى إحداثيات (مباشر/مختصر/اسم مكان) — يُتجاهل عند الفشل؛ لا يجلب الخادم إلا روابط Google (SSRF).
    // ومع lat وlng صريحين معاً (التقاط GPS عند الباب) تُقدَّم الصريحة ولا يُحلّ الرابط (PIN-3 — services/customerPinSource.ts)
    if (locationUrl && !explicitPinWins(rest)) {
      const geo = await resolveLocationUrl(locationUrl, { googleOnly: true });
      if (geo) { rest.lat = geo.lat; rest.lng = geo.lng; }
    }
    // جوال العميل حرٌّ: فكّ المالك قيد تكراره داخل الشركة (١٤ نوفمبر ٢٠٢٦ — كان 27d8ce1)، فعميلان بجوالٍ واحد مقبولان.
    // ويبقى «منع تكرار الموقع داخل الشركة» (طلب المالك ١٣ نوفمبر ٢٠٢٦): عميلٌ آخر ضمن ٣٠ متراً ⇒ 409 CUSTOMER_LOCATION_EXISTS —
    // إلا مفتاح API وإعادة رفع صندوق المندوب (services/customerPhoneDup.ts phoneDupExempt)
    if (!phoneDupExempt(req)) {
      const near = await findLocationDuplicate(tid, rest.lat, rest.lng);
      if (near) { res.status(409).json(locationDupBody(near, await canAccessCustomer(req, tid, near.id))); return; }
    }
    // R6: عميل صندوق المندوب بلحظة إضافته على الجهاز (replayCustomerCreatedAt) — وغيره ساعة الخادم كما كان
    const addedAt = await replayCustomerCreatedAt(req, tid, clientCreatedAt);
    // idempotency على مستوى التطبيق (لا قيد فريد على clientRef في customers — انظر المخطّط).
    // المزامنة متسلسلة على جهاز واحد فلا تكرار متزامن؛ والفحص أعلاه يمنع إعادة الرفع.
    const customer = await prisma.customer.create({
      data: {
        // الجوال اختياريّ والعمود NOT NULL ⇒ '' حين يغيب (أمر المالك ٧ نوفمبر)
        ...rest, phone: rest.phone ?? '', email: data.email || null, channel: data.channel || null, outletType: data.outletType || null, aiPlaceId: data.aiPlaceId || null, tenantId: tid,
        ...(data.priceListId !== undefined && { priceListId: data.priceListId || null }),
        clientCreatedAt: clientCreatedAt && !Number.isNaN(new Date(clientCreatedAt).getTime()) ? new Date(clientCreatedAt) : undefined, // تاريخ الجهاز التالف يُهمل لا 500
        ...(addedAt && { createdAt: addedAt }),
        ...(creatorRepId && { createdBySalesRepId: creatorRepId }),
        ...docsCreate,
      } as any,
    });
    // العميل الذي يفتحه المندوب يظهر له فوراً (سجلّ إسناد تلقائي؛ للإدارة نزعه لاحقاً)
    if (creatorRepId) await ensureAssignment(tid, customer.id, creatorRepId);
    // المندوب الذكي: محلٌّ مقترح صار عميلاً ⇒ يُعلَّم في سجلّ الشركة وتُحفظ لقطة توقّعه (لا يُسقط الإنشاء إن فشل)
    if (customer.outletType) invalidateEstimateData(tid);
    if (customer.aiPlaceId) {
      try {
        await linkConvertedCustomer(tid, customer, creatorRepId);
        if (creatorRepId) patchSessionOutlet(tid, creatorRepId, customer.aiPlaceId, { relation: 'CUSTOMER', customerId: customer.id, lastOutcome: 'CONVERTED' });
      }
      catch (e) { console.error('[ai-rep] ربط التحويل تعذّر:', (e as Error)?.message); }
    }
    const postWarnings = [...(buyerGate.warnings ?? []), ...(refWarning ? [refWarning] : [])];
    if (docsWarning) postWarnings.push(docsWarning); // صور وثائق أُسقطت — العميل نفسه حُفظ
    res.status(201).json({ success: true, data: customer, ...(postWarnings.length > 0 && { warnings: postWarnings }) });
  } catch (err) {
    if (isPriceListFkFail(err)) { priceListInvalid(res); return; }
    next(err);
  }
});

/**
 * معرّفٌ يُنشأ به العميل كما أرسله النظام الخارجي: يُعاد في الروابط (/api/customers/<id>) كما هو، فلا مسافة ولا محرف تحكّم
 * ولا / \ ? # % ولا نقاطٌ وحدها (تطبّعها الروابط)، وحتى ١٢٨ محرفاً، وليس اسم مسارٍ ثابت في هذا الموجّه. غيره ⇒ معرّفٌ جديد مع تحذير
 */
const CUSTOMER_STATIC_PATHS = new Set(['locations', 'zatca-buyer-data']);
function keepableCustomerId(id: string): boolean {
  return /^(?!\.+$)[^\s/\\?#%\u0000-\u001F\u007F]{1,128}$/u.test(id) && !CUSTOMER_STATIC_PATHS.has(id);
}

/** تصادم المفتاح الأساسي (P2002 على id): طلبٌ موازٍ أنشأ العميل بالمعرّف نفسه بين السؤال والكتابة */
const isIdConflict = (err: unknown): boolean => {
  const e = err as { code?: unknown; meta?: { target?: unknown } } | null;
  if (e?.code !== 'P2002') return false;
  const t = e.meta?.target;
  return Array.isArray(t) ? t.includes('id') : String(t ?? '').includes('pkey');
};

/**
 * PUT /:id لمعرّفٍ لا يجده الطالب في شركته (upsert بالمعرّف — أمر المالك ٩ نوفمبر ٢٠٢٦: «لا يُرفض أبداً — حُذف من قبل أو لم
 * يُحذف»). موصل ERP يحتفظ بمعرّفات عملاء قديمة (حُذفوا، أو أُنشئوا في حساب آخر) فكان الـ404 يُضيّع بياناتهم:
 *  • المعرّف لعميلٍ في الشركة نفسها خارج نطاق الطالب (عزل المناديب/نطاق المستخدم) ⇒ كما كان: 403 بلا «تعديل العميل» وإلا 404 — لا إنشاء ولا كشف.
 *  • غير مستعمل في أي شركة ⇒ يُنشأ العميل **بالمعرّف نفسه** في شركة الطالب بقواعد POST حرفياً (الاسم البديل، الجوال '' حين يغيب،
 *    بوابة المشتري بـcustomerId: null، نوع السعر الغريب يُهمل، والمندوب يحتاج «إضافة عميل» ويُوثَّق منشئاً ويُسنَد له).
 *  • مستعمل في شركة أخرى (أو غير صالح رابطاً) ⇒ يُنشأ بمعرّف جديد مع تحذير CUSTOMER_ID_REASSIGNED (العزل: لا يُمسّ عميل الأخرى).
 * الردّ 201 { success, data, created: true, warnings? }. ويعيد 'RACED' بلا ردّ إن سبقه طلبٌ موازٍ بالمعرّف نفسه فيُعاد البحث.
 * ومعرّف مكان Google (aiPlaceId) لا يُربط هنا — كالتعديل؛ ربطه لإنشاء المندوب الذكي عبر POST وحده
 */
async function createMissingOnPut(
  req: AuthRequest, res: Response, tid: string, perms: { canAdd: boolean; canEdit: boolean },
): Promise<'DONE' | 'RACED'> {
  const requestedId = String(req.params.id);
  const holder = await prisma.customer.findUnique({ where: { id: requestedId }, select: { tenantId: true } });
  if (holder?.tenantId === tid) {
    if (!perms.canEdit) res.status(403).json({ success: false, message: 'ليس لديك صلاحية تعديل العملاء' });
    else res.status(404).json({ success: false, message: 'العميل غير موجود' });
    return 'DONE';
  }
  // «الرقم المرجعي من عندهم»: عميلٌ قائم بالرقم نفسه ⇒ يُعدَّل هو (المستدعي يعيد البحث بالمعرّف الجديد) — لا إنشاء مكرّر
  const ref = customerRefOf(req.body);
  if (ref && perms.canEdit) {
    const byRef = await customerByRef(tid, ref);
    if (byRef) { req.params.id = byRef.id; return 'RACED'; }
  }
  if (!perms.canAdd) { res.status(403).json({ success: false, message: 'ليس لديك صلاحية إضافة عملاء' }); return 'DONE'; }
  const keepId = !holder && keepableCustomerId(requestedId);

  const data = customerSchema.parse(req.body ?? {});
  data.name = customerNameFallback(data);
  if (ref && !(await customerByRef(tid, ref))) data.code = ref; else delete data.code;
  const creatorRepId = req.user?.role === 'SALES_REP' ? req.user.id : null;
  if (creatorRepId) delete data.priceListId;
  else if (!(await priceListOwned(tid, data.priceListId))) data.priceListId = null;
  // مفتاح التكرار يتبع عميلاً واحداً في الشركة (POST يبحث به): مرجعٌ يحمله عميلٌ آخر لا يُنسخ إلى هذا
  if (data.clientRef && (await prisma.customer.findFirst({ where: { tenantId: tid, clientRef: data.clientRef }, select: { id: true } }))) data.clientRef = null;

  const buyerGate = await applyBuyerGateToWrite(buyerDataDeps, req, tid, data as Record<string, unknown>, { customerId: null, replay: !!data.clientRef && !req.user?.apiKeyId });
  if (!buyerGate.ok) { res.status(buyerGate.status).json(buyerGate.body); return 'DONE'; }

  const { clientCreatedAt, locationUrl, aiPlaceId: _ap, ...rest } = data;
  void _ap;
  if (locationUrl && !explicitPinWins(rest)) {
    const geo = await resolveLocationUrl(locationUrl, { googleOnly: true });
    if (geo) { rest.lat = geo.lat; rest.lng = geo.lng; }
  }
  // لحظة الإنشاء على الجهاز: تاريخٌ لا يُقرأ يُهمل لا يُسقط العميل
  const createdAtDevice = clientCreatedAt ? new Date(clientCreatedAt) : null;
  // R6: وإنشاءٌ هنا من صندوق المندوب يُؤرَّخ كـPOST حرفياً (replayCustomerCreatedAt) — وغيره ساعة الخادم
  const addedAt = await replayCustomerCreatedAt(req, tid, clientCreatedAt);
  const customer = await prisma.customer.create({
    data: {
      ...(keepId && { id: requestedId }),
      ...rest, phone: rest.phone ?? '', email: rest.email || null, channel: rest.channel || null, outletType: rest.outletType || null, tenantId: tid,
      ...(rest.priceListId !== undefined && { priceListId: rest.priceListId || null }),
      clientCreatedAt: createdAtDevice && !Number.isNaN(createdAtDevice.getTime()) ? createdAtDevice : undefined,
      ...(addedAt && { createdAt: addedAt }),
      ...(creatorRepId && { createdBySalesRepId: creatorRepId }),
    } as any,
  }).catch((err: unknown) => {
    if (keepId && isIdConflict(err)) return null;
    throw err;
  });
  if (!customer) return 'RACED';
  if (creatorRepId) await ensureAssignment(tid, customer.id, creatorRepId);
  if (customer.outletType) invalidateEstimateData(tid);

  const warnings: object[] = [...(buyerGate.warnings ?? [])];
  if (!keepId) {
    warnings.push({
      code: 'CUSTOMER_ID_REASSIGNED', requestedId,
      message: holder ? 'المعرّف مستخدم في شركة أخرى فأُنشئ العميل بمعرّف جديد' : 'المعرّف لا يصلح في الروابط فأُنشئ العميل بمعرّف جديد',
    });
  }
  res.status(201).json({ success: true, data: customer, created: true, ...(warnings.length > 0 && { warnings }) });
  return 'DONE';
}

router.put('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    // المندوب يحتاج صلاحية "تعديل العميل" للتعديل، و"إضافة عميل" لإنشاء معرّفٍ لا يجده (upsert)؛ الإدارة مسموح لها دائماً
    const isRep = req.user?.role === 'SALES_REP';
    const rep = isRep
      ? await prisma.salesRep.findUnique({ where: { id: req.user!.id }, select: { canEditCustomer: true, canAddCustomer: true, requireCustomerProximity: true } })
      : null;
    // بلا الصلاحيتين معاً: الرفض كما كان قبل أي سؤال عن العميل
    if (isRep && !rep?.canEditCustomer && !rep?.canAddCustomer) {
      res.status(403).json({ success: false, message: 'ليس لديك صلاحية تعديل العملاء' });
      return;
    }
    // التحقق أن العميل يخص شركة المستخدم (ومُسنَد للمندوب عند تفعيل العزل) قبل التعديل
    const scope = await customerScope(req, tid);
    const findExisting = () => prisma.customer.findFirst({
      where: { id: req.params.id, tenantId: tid, ...scope },
      select: { id: true, phone: true },
    });
    let exists = await findExisting();
    // لا يجده ⇒ يُنشأ (createMissingOnPut)؛ وسباقٌ أنشأه بالمعرّف نفسه في الأثناء ⇒ يُعاد البحث فيُعدَّل كأيّ عميل
    for (let attempt = 0; !exists && attempt < 2; attempt++) {
      const outcome = await createMissingOnPut(req, res, tid, { canAdd: !isRep || rep?.canAddCustomer === true, canEdit: !isRep || rep?.canEditCustomer === true });
      if (outcome === 'DONE') return;
      exists = await findExisting();
    }
    if (!exists) { res.status(404).json({ success: false, message: 'العميل غير موجود' }); return; }
    let repPinsLocked = false;
    if (isRep) {
      if (!rep?.canEditCustomer) {
        res.status(403).json({ success: false, message: 'ليس لديك صلاحية تعديل العملاء' });
        return;
      }
      // المقيَّد بـ«البيع داخل نطاق العميل» لا يحرّك نقطة العميل ولا يمسحها: البوّابة
      // تقيس المسافة إلى هذه النقطة، فمن يملك تعديلها يفتح البوّابة على نفسه من أي مكان.
      repPinsLocked = rep.requireCustomerProximity === true;
    }
    // جوالٌ محفوظ أطول من السقف (سبق القيد: مفتاح API أو استيراد) يعود مع نموذج التعديل كما هو ⇒ يُترك كما هو بلا رفض،
    // وإلا تعذّر تعديل اسم العميل أو عنوانه بسبب جواله القائم. والجديد الأطول يُرفض 400 كالإنشاء
    const sentPhone = (req.body as { phone?: unknown } | null | undefined)?.phone;
    const keepStoredPhone = typeof sentPhone === 'string' && sentPhone.trim().length > CUSTOMER_PHONE_MAX
      && sentPhone.trim() === (exists.phone ?? '').trim();
    // نستبعد الحقول الداخلية (locationUrl يُحلّ منفصلاً؛ clientRef/clientCreatedAt لا تُحرَّر)
    const { locationUrl, clientRef: _cr, clientCreatedAt: _cc, aiPlaceId: _ap, ...data } = customerSchema.partial().parse(keepStoredPhone ? { ...req.body, phone: undefined } : req.body);
    if ('name' in data && !(data.name ?? '').trim()) delete data.name; // الاسم الفارغ لا يمحو الاسم المحفوظ ولا يرفض التعديل
    // «الرقم المرجعي من عندهم»: يُكتب كوداً للعميل — ما لم يكن لعميلٍ آخر (يُترك بتحذير لا رفض)
    let refWarning: object | null = null;
    {
      const ref = customerRefOf(req.body);
      delete data.code;
      if (ref) {
        if (await customerByRef(tid, ref, req.params.id)) refWarning = { code: 'CUSTOMER_REF_TAKEN', message: 'الرقم المرجعي لعميلٍ آخر فبقي كود العميل كما هو', ref };
        else data.code = ref;
      }
    }
    void _cr; void _cc; void _ap; // معرّف مكان Google يُربط عند الإنشاء وحده
    // جوال العميل حرٌّ في التعديل كذلك: لا فحص تكرار (فكّ المالك القيد ١٤ نوفمبر ٢٠٢٦)
    // «تعديل بيانات العميل» للمندوب يشمل البيانات الوصفية لا الشروط المالية: الحدّ الائتمانيّ
    // وفترة السداد وحالة العميل قرارُ الإدارة — وإلا رفع المندوب حدّ عميله ليتجاوز ضابط الائتمان
    if (req.user?.role === 'SALES_REP') {
      delete data.creditLimit; delete data.paymentDays; delete data.status;
      // «أنواع الأسعار»: ونوع سعره كذلك — نقلُ عميلٍ إلى نوعٍ أرخص يمرّر سعره من حارس الفاتورة
      delete data.priceListId;
    } else if (!(await priceListOwned(tid, data.priceListId))) delete data.priceListId; // نوعٌ غريب يُهمل لا يرفض التعديل
    if (repPinsLocked && (data.lat !== undefined || data.lng !== undefined || locationUrl)) {
      res.status(403).json({ success: false, code: 'PIN_LOCKED', message: 'لا يمكنك تعديل موقع العميل اطلب من الادارة ضبطه' });
      return;
    }
    // فوترة ZATCA (Z5.1a): حقول المشتري للشركة الجامعة وحدها — فحص المتغيّر فقط، والمندوب لا يحوّل منشأة إلى فرد (نقد الخطة 21)
    const buyerGate = await applyBuyerGateToWrite(buyerDataDeps, req, tid, data as Record<string, unknown>, { customerId: req.params.id, replay: false });
    if (!buyerGate.ok) { res.status(buyerGate.status).json(buyerGate.body); return; }
    // رابط موقع مُرسَل ⇒ يُحلّ إلى إحداثيات (مباشر/مختصر/اسم مكان) — يُتجاهل عند الفشل؛ لا يجلب الخادم إلا روابط Google (SSRF).
    // في التعديل يبقى الرابط مقدَّماً كما كان (PIN-3 للإنشاء وحده): لا عميلَ لنا يرسل الاثنين معاً هنا إلا نموذج الإدارة يعيد
    // إحداثيات صفّه مع الرابط الجديد — وصفٌّ قديم (أعاد المندوب الالتقاط بعد تحميل القائمة) كان سيُسقط الرابط ويكتب القديم.
    // وتعديلٌ بلا حقول موقع لا يكتب lat/lng أصلاً — فلا يتحرّك الدبّوس بتعديل الاسم أو العنوان
    if (locationUrl) {
      const geo = await resolveLocationUrl(locationUrl, { googleOnly: true });
      if (geo) { data.lat = geo.lat; data.lng = geo.lng; }
    }
    // «منع تكرار الموقع داخل الشركة»: موقعٌ تحرّك إلى ٣٠ متراً من عميلٍ آخر ⇒ 409 — والموقع نفسه بلا تغيير (صدى النموذج) لا يُمنع:
    // findLocationDuplicate يقرأ صفّ العميل نفسه في الاستعلام ذاته فيعرف أنه لم يتحرّك (تكرارٌ قديم لا يمنع تعديلاً)
    if (validPoint(data.lat, data.lng) && !phoneDupExempt(req)) {
      const near = await findLocationDuplicate(tid, data.lat, data.lng, req.params.id);
      if (near) { res.status(409).json(locationDupBody(near, await canAccessCustomer(req, tid, near.id))); return; }
    }
    let customer = await prisma.customer.update({
      where: { id: req.params.id },
      // البريد والقناة يُكتبان فقط إن أُرسلا: تعديلٌ جزئيّ (كتطبيق المندوب) لا يمحو بريد العميل.
      // والجوال كذلك، ومسحه (null أو الفارغ) يُكتب '' لأن العمود NOT NULL (أمر المالك ٧ نوفمبر: الجوال اختياريّ)
      data: { ...data, name: data.name ?? undefined, code: data.code ?? undefined, phone: data.phone === undefined ? undefined : (data.phone ?? ''), ...(data.email !== undefined && { email: data.email || null }), ...(data.channel !== undefined && { channel: data.channel || null }), ...(data.outletType !== undefined && { outletType: data.outletType || null }), ...(data.priceListId !== undefined && { priceListId: data.priceListId || null }) },
    });
    // «حُذف من قبل أو لم يُحذف يُقبل» (٩ نوفمبر ٢٠٢٦): عميلٌ مؤرشف قديم (status DELETED) يعود نشطاً حين يصله تعديل بلا حالة صريحة
    if (data.status === undefined && customer.status === 'DELETED') customer = await prisma.customer.update({ where: { id: req.params.id }, data: { status: 'ACTIVE' } });
    // نوع المنفذ أو الموقع تغيّر ⇒ توقّعات المحلات المشابهة تُعاد من القاعدة
    if (data.outletType !== undefined || data.lat !== undefined || data.lng !== undefined) invalidateEstimateData(tid);
    const putWarnings = [...(buyerGate.warnings ?? []), ...(refWarning ? [refWarning] : [])];
    res.json({ success: true, data: customer, ...(putWarnings.length > 0 && { warnings: putWarnings }) });
  } catch (err) {
    if (isPriceListFkFail(err)) { priceListInvalid(res); return; }
    next(err);
  }
});

router.get('/:id/statement', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const { from, to } = req.query;
    if (req.user?.role === 'SALES_REP') {
      const rep = await prisma.salesRep.findFirst({ where: { id: req.user.id, tenantId: tid }, select: { canViewStatement: true } });
      if (!rep?.canViewStatement) { res.status(403).json({ success: false, message: 'لا تملك صلاحية عرض كشف الحساب' }); return; }
    }
    // العزل: كشف حساب عميل خارج النطاق يُرفض (يُعامَل كغير موجود).
    // نمرّ عبر canAccessCustomer لا بفحص مفتاح بعينه: النطاق صار مفتاحين
    // (المندوب/الإداري) وفحصُ أحدهما يفتح الباب للآخر. وهي ترجع true بلا
    // استعلام حين لا قيد، فالإدارة غير المقيّدة لا تدفع ثمناً.
    if (!(await canAccessCustomer(req, tid, req.params.id))) {
      res.status(404).json({ success: false, message: 'العميل غير موجود' }); return;
    }

    // البند 22: حدود الفترة بأيام الشركة لا بمنتصف ليل UTC — الحركة المستوردة بتاريخ 1 يناير تُخزَّن بأول لحظة
    // من يومها المحلي (21:00Z في الرياض)، فالفلتر بـUTC كان يُسقطها من يناير ويُدخلها في المرحَّل وكشف ديسمبر.
    // ولا يُفترض توقيت الرياض لشركة لم تضبط توقيتها أصلاً (الدفاتر اختيارية ومطفأة): explicitTimezone تعيد null
    // فيبقى فلتر كشفها كما كان بالضبط، وإلا أزحنا فواتير شركة مصرية أو تركية بين الشهور بدعوى إصلاح الاستيراد.
    const gl = await prisma.glSettings.findUnique({ where: { tenantId: tid }, select: { activatedAt: true, timezone: true, setupDraft: true } });
    const timezone = explicitTimezone(gl);
    const range = statementEntryDateFilter(
      typeof from === 'string' ? from : undefined, typeof to === 'string' ? to : undefined, timezone,
    );
    // «الفرق» (قرار المالك ١٧ أكتوبر ٢٠٢٦): مشرف الفريق يرى كشف فريقه وحده — قيود فواتير فرقه، وسندات القبض بحصّتها منها
    // (teamReceiptShare: ما وُزّع على فواتير فرقه، وما لم يُوزَّع إن كان السند لفرقه — السند يُوسم بفريق المحصِّل والتوزيع
    // يعبر الفرق). القيد بلا مستند (افتتاح، تسوية يدوية) وقيود الفرق الأخرى لا تظهر له، والرصيد الجاري يُشتقّ من المعروض
    // فيبقى متّسقاً، وملخّص العميل في الردّ لفريقه لا للشركة. وغيره: الكشف كاملاً كما كان
    const sup = await teamSupervisorIdOf(req);
    const supTeam = { supervisors: { some: { adminId: sup ?? '' } } };
    const teamEntries = sup ? { OR: [
      { invoice: { team: supTeam } },
      { receipt: { team: supTeam } },
      { receipt: { invoiceItems: { some: { invoice: { team: supTeam } } } } },
    ] } : {};
    // واسم كل فريق من الاستعلام نفسه (علاقةٌ في الصفّ ذاته، بلا ذهابٍ ثانٍ إلى القاعدة): الكشف يُعنوَن «كشف فريقك»
    // (teamScoped) وتسمّي الواجهة الفرق — تدقيق دقّة التقارير ١٣ نوفمبر ٢٠٢٦: رصيدان مختلفان للعميل نفسه بلا تفسير
    const supTeams = sup
      ? await prisma.teamSupervisor.findMany({ where: { tenantId: tid, adminId: sup }, select: { teamId: true, team: { select: { name: true } } } })
      : null;
    const supTeamIds = supTeams ? new Set(supTeams.map((t) => t.teamId)) : null;
    /** حصّة فرق المشرف من كل سندٍ في القيود — استعلامٌ واحد بتوزيع السندات، وللمشرف وحده */
    const sharesOf = async (rs: { receiptId: string | null }[]): Promise<Map<string, number>> => {
      const ids = [...new Set(rs.map((r) => r.receiptId).filter((x): x is string => !!x))];
      if (!supTeamIds || !ids.length) return new Map();
      const splits = await prisma.receipt.findMany({
        where: { id: { in: ids }, tenantId: tid },
        select: { id: true, amount: true, teamId: true, invoiceItems: { select: { amount: true, invoice: { select: { teamId: true } } } } },
      });
      return new Map(splits.map((r) => [r.id, teamReceiptShare(r, supTeamIds)]));
    };
    const forTeam = async <T extends { debit: number; credit: number; receiptId: string | null }>(rs: T[]): Promise<T[]> =>
      (supTeamIds ? scaleTeamRows(rs, await sharesOf(rs)) : rs);
    const where = {
      customerId: req.params.id,
      tenantId: tid,
      // طرفٌ واحد يكفي؛ و«إلى» تشمل يومها كاملاً — وإلا سقطت حركات آخر يوم بصمت
      ...(range.entryDate && { entryDate: range.entryDate }),
      ...teamEntries,
    };
    const rows = await forTeam(await prisma.accountEntry.findMany({
      where,
      include: {
        // نُضمّن بنود الفاتورة (الأصناف وكمياتها) لتظهر في كشف الحساب. البند يحمل لقطة وحدته (unitName/unitFactor/baseQty)
        // فيُعرض «qty unitName» — و`product.unit` (وحدة الأساس اليوم) لبندٍ سبق الميزة بلا لقطة. الأرصدة من القيود بالمبالغ فلا تمسّها الوحدة
        // و`primaryUnitId` (عرضٌ فقط): لصنفٍ له وحدة رئيسية يُلحق اسم الوحدة دائماً فلا يُقرأ «×5» كراتين (فخّ «×5»)
        invoice: { include: { items: { include: { product: { select: { name: true, unit: true, primaryUnitId: true } } } } } },
        receipt: true,
      },
      // فاصل تعادل حاسم: الفاتورة النقدية تكتب قيديها بنفس `entryDate` **وبنفس
      // `createdAt`** (دالة `now()` في بوستجرس ثابتة طوال المعاملة)، فبلا فاصلٍ
      // ثالث يبقى ترتيبهما بيد القاعدة — وقد يظهر التحصيل قبل فاتورته فيقرأ
      // العميل رصيداً يرتفع بعد سداده. `debit desc` يضع الفاتورة قبل سدادها،
      // و`id asc` يحسم ما بقي فيثبت الترتيب بين كل نداءَين.
      orderBy: [{ entryDate: 'asc' }, { createdAt: 'asc' }, { debit: 'desc' }, { id: 'asc' }],
    }));
    const customer = await prisma.customer.findFirst({ where: { id: req.params.id, tenantId: tid } });
    if (!customer) { res.status(404).json({ success: false, message: 'العميل غير موجود' }); return; }
    // الصنف المحذوف حذفاً حقيقياً: بنود فواتير الكشف باسمه من لقطة البند (services/deletedProduct.ts)
    for (const r of rows as unknown as Array<{ invoice?: { items?: Array<Record<string, unknown>> } | null }>) {
      if (r.invoice?.items) r.invoice.items = r.invoice.items.map((x) => withDeletedProductName(x));
    }

    // ── الرصيد الجاري يُشتقّ في ترتيب العرض، ولا يُعرض المخزَّن ──
    // القيمة المخزّنة في `balance` لقطةٌ لحظةَ الكتابة: قيدٌ بأثر رجعي يحمل رصيد
    // زمنٍ لاحق له، وقيدٌ حُذف قبله يترك من بعده أرصدةً معلّقة. فيظهر عمودٌ لا
    // تُنتج فيه أيّ خطوة الخطوةَ التالية — والعميل يقرأه رقماً يطالَب به.
    // الاشتقاق يجعل كل سطر ناتجَ سابقه بالضرورة، مهما كان أصل البيانات.
    // رصيد ما قبل الفترة (مُرحَّل) — بدونه يبدأ الكشف المُصفّى من صفرٍ كاذب
    let openingBalance = 0;
    if (range.openingBefore && supTeamIds) {
      // المشرف: المرحَّل بحصّة فرقه من كل سند — لا يُجمع بـaggregate (النسبة لكل سند)
      const prior = await forTeam(await prisma.accountEntry.findMany({
        where: { customerId: req.params.id, tenantId: tid, entryDate: { lt: range.openingBefore }, ...teamEntries },
        select: { debit: true, credit: true, receiptId: true },
      }));
      openingBalance = clean(prior.reduce((s, r) => s + Number(r.debit) - Number(r.credit), 0));
    } else if (range.openingBefore) {
      const prior = await prisma.accountEntry.aggregate({
        where: { customerId: req.params.id, tenantId: tid, entryDate: { lt: range.openingBefore }, ...teamEntries },
        _sum: { debit: true, credit: true },
      });
      openingBalance = clean(Number(prior._sum.debit ?? 0) - Number(prior._sum.credit ?? 0));
    }
    const entries = deriveRunningBalances(rows, openingBalance);
    const closingBalance = entries.length ? entries[entries.length - 1].balance : openingBalance;

    // المشرف: إجماليات العميل وأرصدته في الردّ لفريقه (كل الزمن كإجماليات العميل) — أرقام الشركة لا تخرج له، والمستند
    // المطبوع وشاشة الجوال يقرآنها من هنا
    let customerOut = customer;
    if (supTeamIds) {
      const all = range.entryDate
        ? await forTeam(await prisma.accountEntry.findMany({
          where: { customerId: req.params.id, tenantId: tid, ...teamEntries },
          select: { type: true, debit: true, credit: true, receiptId: true },
        }))
        : rows;
      const t = teamStatementTotals(all);
      customerOut = { ...customer, totalSales: t.totalSales, totalCollected: t.totalCollected, balance: t.balance };
    }

    // teamScoped: الردّ مقصورٌ على فرق المشرف (القيود والإجماليات أعلاه)، فتعنون الواجهة الرصيد والمبيعات والتحصيل «لفريقك»
    // وتنبّه أنه قد يخالف رصيد العميل الكامل في قائمة العملاء — ما يراه المشرف لم يتغيّر، العنوان وحده. وteamNames أسماء
    // فرقه مرتّبةً (للمشرف وحده؛ غيره بلا المفتاح كما كان الردّ حرفاً)
    const teamNames = supTeams?.map((t) => t.team.name).sort((a, b) => a.localeCompare(b, 'ar'));
    res.json({ success: true, data: { customer: customerOut, entries, ...(teamNames && { teamNames }), openingBalance, closingBalance, timezone, teamScoped: sup !== null } });
  } catch (err) { next(err); }
});

router.get('/:id/invoices', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    // العزل: فواتير عميل خارج النطاق لا تُعرض (المفتاحان معاً — راجع /statement)
    if (!(await canAccessCustomer(req, tid, req.params.id))) {
      res.status(404).json({ success: false, message: 'العميل غير موجود' }); return;
    }
    const invoices = await prisma.invoice.findMany({
      // قيد المندوب أيضاً: عميلٌ مرئيّ لا يُبرّر كشف اسم مندوب خارج النطاق
      where: { customerId: req.params.id, tenantId: tid, ...(await scopedRecordWhere(req, SHAPE_INVOICE_RECEIPT)) },
      include: { salesRep: { select: { name: true } }, items: { include: { product: true } } },
      orderBy: { createdAt: 'desc' },
    });
    // الصنف المحذوف حذفاً حقيقياً: اسمه من لقطة البند
    res.json({ success: true, data: invoices.map((inv) => ({ ...inv, items: inv.items.map((x) => withDeletedProductName(x)) })) });
  } catch (err) { next(err); }
});

// السعر الخاص **لوحدة الأساس** (الحبة) — سعر الكرتون للعميل = السعر × معامل الكرتون، ويحرسه مسار الإصدار
// بالمعامل نفسه (routes/invoices.ts). وتحويل وحدة الأساس يقسمه على المعامل فيبقى سعر الكرتون كما هو.
const pricesSchema = z.object({
  prices: z.array(z.object({
    productId: z.string().min(1).max(64), price: z.coerce.number().finite().nonnegative(),
    /**
     * «الوحدة الرئيسية» §2.10: اسم وحدة الأساس التي كُتب لها السعر كما رآها العميل. يختلف عن الصنف الآن ⇒ 400 UNIT_INVALID
     * (سعر الكرتون لا يُخزَّن سعرَ قارورة). يُقصّ إلى ٦٤ حرفاً كبقية الحقول نفسها (baseNameKey) فلا يُرفض اسمٌ قائم أطول
     */
    baseUnitName: z.string().transform(v => v.slice(0, 64)).nullish(),
  })).max(5000),
});

/**
 * I10: المعاملة تفاعلية بعد قفل الأصناف — upsert متتابعٌ صفاً صفاً لا تسبقه مهلة Prisma الافتراضية (٥ ثوانٍ). والمصفوفة القديمة
 * كانت بلا مهلة: ٣٠ ثانية حدٌّ أدنى، وتكبر بـ١٢ms لكل صفّ (٥٠٠٠ صفّ ⇒ ٦٠ ثانية) فلا يصير حفظ قائمةٍ كبيرة 500 كان ينجح
 */
const PRICES_TX = { maxWait: 10_000, timeout: 30_000 } as const;

router.put('/:id/prices', requireAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const exists = await prisma.customer.findFirst({ where: { id: req.params.id, tenantId: tid }, select: { id: true } });
    if (!exists) { res.status(404).json({ success: false, message: 'العميل غير موجود' }); return; }
    const { prices } = pricesSchema.parse(req.body);
    // الصنف من الشركة نفسها: بلا هذا يُربط سعرٌ بصنف شركةٍ أخرى ثم يُقرأ صفّه كاملاً مع العميل.
    // ومعه أساسه (§2.10) في الاستعلام نفسه: الكلفة استعلامٌ واحد كما كانت
    const productIds = [...new Set(prices.map(p => p.productId))];
    const owned = await prisma.product.findMany({ where: { id: { in: productIds }, tenantId: tid }, select: { id: true, name: true, unit: true, baseConvertedAt: true } });
    if (owned.length !== productIds.length) { res.status(400).json({ success: false, message: 'صنف غير موجود في الشركة' }); return; }
    // D19-ب: مفتاح API وصنفٌ حُوِّلت وحداته وصفٌّ بلا baseUnitName ⇒ رفضٌ ظاهر لا سعر كرتون يُقرأ سعرَ قارورة
    const apiMissing = missingBaseForApi(!!req.user?.apiKeyId, prices, new Map(owned.map(p => [p.id, { name: p.name, baseConvertedAt: p.baseConvertedAt }])));
    if (apiMissing) {
      res.status(400).json({ success: false, code: 'BASE_UNIT_REQUIRED', message: `حُوِّلت وحدات «${apiMissing}» — أرسل baseUnitName (اسم وحدته الصغرى الحالية) مع كل صفّ سعرٍ له` });
      return;
    }
    const expected: ExpectedBases = new Map(owned.map(p => [p.id, { name: p.name, unit: p.unit }]));
    const stale = staleClientBase(prices, expected, new Map(owned.map(p => [p.id, p.baseConvertedAt])));
    if (stale) throw new UnitInvalidError(`تغيّرت وحدات «${stale}» — حدّث قائمة الأصناف ثم أعد الحفظ`);
    // تحت قفل صفّ الصنف (FOR KEY SHARE): تحويلٌ التزم بعد القراءة أعلاه ⇒ 409 PRODUCT_UNITS_CHANGED بلا أي upsert
    await prisma.$transaction(async (tx) => {
      await lockBases(tx, tid, expected);
      for (const p of prices) {
        await tx.customerPrice.upsert({
          where: { customerId_productId: { customerId: req.params.id, productId: p.productId } },
          create: { customerId: req.params.id, productId: p.productId, price: p.price },
          update: { price: p.price },
        });
      }
    }, { ...PRICES_TX, timeout: Math.max(PRICES_TX.timeout, prices.length * 12) }); // المهلة حرفياً في الاستدعاء: يراها فحص I10 الثابت
    res.json({ success: true });
  } catch (err) {
    // صنفا خطأ الحارس وحدهما (لا انتظار قفلٍ خام من غير الحارس)
    const guard = err instanceof ProductUnitsChangedError || err instanceof ProductUnitsBusyError ? baseGuardReply(err, false) : null;
    if (guard) { res.status(guard.status).json(guard.body); return; }
    next(err);
  }
});

/**
 * حذف عميل — للإدارة وحدها.
 *
 * فمساران بحسب ما له من أثر ماليّ (أمر المالك ٥ نوفمبر ٢٠٢٦: حذفٌ حقيقيّ بلا نسخة مخفية):
 *  • بلا أثر ⇒ حذفٌ فعليّ من القاعدة.
 *  • بأثر (فواتير أو سندات أو قيود) ⇒ **رفض** 409 CUSTOMER_HAS_DOCUMENTS: لا تبقى فاتورة بلا عميل، ولا صفٌّ مخفيّ
 *    تعيده المزامنة. يوقفه المدير بدل حذفه، أو يحذفه مالك المنصة مع مستنداته بالحذف النهائي.
 *    (العملاء المؤرشفون قبل اليوم بـstatus = 'DELETED' يبقون كما هم.)
 *
 * ومن ثمّ لا مسار «استرجاع» في الواجهة: الحذف نهائيّ كما وُعد المستخدم.
 */
router.delete('/:id', requireAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const customer = await prisma.customer.findFirst({ where: { id: req.params.id, tenantId: tid }, select: { id: true, name: true } });
    if (!customer) { res.status(404).json({ success: false, message: 'العميل غير موجود' }); return; }

    // أمر المالك (٥ نوفمبر ٢٠٢٦): «الحذف… حذف فعلي و حقيقي بدون نسخة ثانية» — لا أرشفة بعد اليوم (status DELETED كان يُبقي
    // صفّاً مخفياً تعيده المزامنة فيظنّه الربط البرمجي موجوداً). وقراره: العميل الذي له فواتير أو سندات أو قيود لا يحذفه مدير
    // الشركة (لا تبقى فاتورة بلا عميل) — يوقفه بدل حذفه، ومالك المنصة يحذفه مع مستنداته بالحذف النهائي (routes/ownerPurge.ts).
    // العدّ والحذف في معاملة واحدة بعد قفل صفّ العميل FOR UPDATE (الفاتورة والسند يقفلانه قبل الكتابة: lockCustomerRow) — فلا
    // تُحذف فاتورةٌ تُكتب في الأثناء مع عميلها. وبلا أثرٍ ماليّ يُحذف بالمحرّك نفسه مع كل ما يتبعه (إسناداته ومحطّاته وأسعاره
    // وزياراته الميدانية…)، وإشعاراته معه كما كان
    const refused = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM customers WHERE id = ${customer.id} FOR UPDATE`;
      const [invoices, receipts, entries] = await Promise.all([
        tx.invoice.count({ where: { customerId: customer.id } }),
        tx.receipt.count({ where: { customerId: customer.id } }),
        tx.accountEntry.count({ where: { customerId: customer.id } }),
      ]);
      if (invoices > 0 || receipts > 0 || entries > 0) return { invoices, receipts, entries };
      await tx.notification.deleteMany({ where: { customerId: customer.id } });
      await purgeInTx(tx, tid, 'Customer', [customer.id]);
      return null;
    }, { maxWait: 10_000, timeout: 60_000 });
    if (refused) {
      res.status(409).json({
        success: false, code: 'CUSTOMER_HAS_DOCUMENTS',
        message: `لا يمكن حذف «${customer.name}» لأن له فواتير أو سندات في الدفاتر — أوقف العميل بدل حذفه`,
        data: refused,
      });
      return;
    }
    res.json({ success: true, data: { archived: false } });
  } catch (err) { next(err); }
});

export default router;


