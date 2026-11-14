import { Router, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import prisma from '../config/database';
import { authenticate, requireAdmin, requireAdminPermission, tenantId, actorOf } from '../middleware/auth';
import { auditActorName } from '../services/attendanceEdit';
import { REP_COLLECTED_CASH_SALE } from '../services/repCashCollection';
// «الدفع من عهدة مندوب» (ربط الدفاتر L1): سندات صرف الموردين من عهدته تُنقصها (services/suppliers/repCustody.ts)
import { custodyIncludesTeamless, repCustodySupplierNet } from '../services/suppliers/repCustody';
import { adminRepFilter, adminCustomerFilter, scopedRecordWhere, SHAPE_INVOICE_RECEIPT, teamSupervisorIdOf, composeTeamCustodyWhere } from '../services/adminScope';
import { settlementTeamOf, teamMembershipSelectFor } from '../services/teams';
import { noStaffCredentials, refuseStaffCredentials } from '../services/platformAccess';
import { AuthRequest } from '../types';
import { paginate, paginationMeta } from '../utils/helpers';
import { clean } from '../services/accounting';
import { netSales } from '../services/netSales';
import { lockCustody, CustodyBlocked } from '../services/userCustody';
// «ربط الدفاتر» L5 (OD5، D6): حارس حذف الاستلام بالطيّ نفسه (النقد والشيكات)، وحمولة المربوطة بالمستلِم
import { userCustodyInputs } from '../services/userCustody';
import { foldUserCustody, receivedRemovalKeepsCustodySane } from '../services/userCustodyCore';
import { isLedgerError } from '../services/gl/types';
import { assertRepDeletable, settlementTombstonesWithReceiver } from '../services/gl/sync/tombstone';
// «ربط الدفاتر» (قرار المالك OD1): لا حذف لمستندٍ مرحَّل في شركةٍ دفاترها مربوطة — الحكم من المصدر الوحيد لوضع الدفاتر
import { LINKED_NO_DELETE_CODE, LINKED_NO_DELETE_MESSAGE, tenantBooksLinked } from '../services/booksMode';
import { BASE_PRICE_TYPE, PRICE_LIST_MESSAGES, allowedPriceTypesOf } from '../services/priceLists';

const router = Router();
router.use(authenticate, requireAdmin, requireAdminPermission('canManageSalesReps'));

const emailSchema = z.preprocess(value => value === null ? '' : value, z.string().email().optional().or(z.literal('')));

export const RADIUS_MIN_M = 10;
export const RADIUS_MAX_M = 5000;
/** وقت الدوام "HH:MM" بنظام ٢٤ ساعة */
export const SHIFT_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const repSchema = z.object({
  name: z.string().min(1),
  // جوال المندوب بأي صيغة دولية (طلب المالك ٨ نوفمبر ٢٠٢٦: فك قيد الرقم السعودي) — أرقام دول كثيرة ٧ أو ٨ خانات
  phone: z.string().trim().min(6).max(30),
  email: emailSchema,
  username: z.string().min(4),
  password: z.string().optional(), // طول كلمة المرور يُفحص في المعالج لرسالة أوضح
  isActive: z.boolean().optional(),
  canCreateInvoice: z.boolean().optional(),
  canSellOnCredit: z.boolean().optional(),
  canSellOnInstallment: z.boolean().optional(),
  canSellInCash: z.boolean().optional(),
  canEditInvoice: z.boolean().optional(),
  canDeleteInvoice: z.boolean().optional(),
  canCancelInvoice: z.boolean().optional(),
  canChangePrice: z.boolean().optional(),
  maxDiscountPct: z.number().min(0).max(100).optional(),
  canSellBelowPrice: z.boolean().optional(),
  // «تبديل نوع السعر» (أنواع الأسعار): يسعّر فاتورته بنوعٍ غير نوع العميل — يحرسه POST /api/invoices
  canChangePriceList: z.boolean().optional(),
  // «أنواع الأسعار على مستوى المندوب» (طلب المالك ٢ نوفمبر ٢٠٢٦): نوعه الافتراضي لعميلٍ بلا نوع (null أو الفارغ = السعر الأساسي)،
  // والأنواع التي يبدّل بينها بـcanChangePriceList (null أو [] = كلها كاليوم؛ وإلا 'base' ومعرّفات أنواع الشركة) — للإدارة وحدها
  // (الموجّه كله requireAdmin)، ويفحصهما priceTypeWrite وpriceListsLocked أدناه
  defaultPriceListId: z.string().max(64).nullable().optional(),
  allowedPriceTypes: z.array(z.string().max(64)).max(500).nullable().optional(),
  canCreateReceipt: z.boolean().optional(),
  canEditReceipt: z.boolean().optional(),
  canCancelReceipt: z.boolean().optional(),
  canManageVanStock: z.boolean().optional(),
  canAddCustomer: z.boolean().optional(),
  canEditCustomer: z.boolean().optional(),
  canViewStatement: z.boolean().optional(),
  showCollectionBalance: z.boolean().optional(),
  // «البيع النقدي تحصيلٌ لدى المندوب»: فاتورته النقدية تُحسب مبلغاً محصَّلاً لديه بلا سند قبض (يسري على ما يصدر بعده)
  cashSaleCollected: z.boolean().optional(),
  requireCustomerProximity: z.boolean().optional(),
  requireLocationOn: z.boolean().optional(),
  requirePunchAtCustomer: z.boolean().optional(),
  // مسافتا القيدين بالأمتار — عددٌ صحيح بين ١٠ و٥٠٠٠ (أضيق من ١٠ يمنع صادقاً بهامش الـGPS، وأوسع لا يقيّد شيئاً)
  proximityRadiusM: z.number().int().min(RADIUS_MIN_M).max(RADIUS_MAX_M).optional(),
  punchRadiusM: z.number().int().min(RADIUS_MIN_M).max(RADIUS_MAX_M).optional(),
  // البصمة خارج النطاق: REJECT تُردّ، FLAG تُقبل بوسم «خارج النطاق» (tracking.ts)
  punchOutsideAction: z.enum(['REJECT', 'FLAG']).optional(),
  // «ربط البصمة بجهاز واحد» — الجهاز نفسه يُربط من أول بصمة، ويُفكّ من POST /:id/unbind-device لا من هنا
  requireBoundDevice: z.boolean().optional(),
  // «التحقق العشوائي من التواجد» (services/presenceChecks.ts)
  requirePresenceCheck: z.boolean().optional(),
  // «عرض خط السير على الخريطة» (routes/tracking.ts — /route)
  showRouteOnMap: z.boolean().optional(),
  // موعد الدوام للتنبيهات (services/attendanceAlerts.ts): "HH:MM" أو فارغ، وأيام العمل بتات الأحد=1 … السبت=64
  shiftStart: z.string().regex(SHIFT_TIME_RE).nullable().optional(),
  shiftEnd: z.string().regex(SHIFT_TIME_RE).nullable().optional(),
  shiftDays: z.number().int().min(0).max(127).optional(),
});

const repSelect = {
  id: true, name: true, phone: true, email: true, username: true, isActive: true,
  canCreateInvoice: true, canSellOnCredit: true, canSellOnInstallment: true, canSellInCash: true,
  canEditInvoice: true, canDeleteInvoice: true, canCancelInvoice: true,
  canChangePrice: true, maxDiscountPct: true, canSellBelowPrice: true, canChangePriceList: true,
  // «أنواع الأسعار على مستوى المندوب»: الافتراضي (null = السعر الأساسي) والمسموح (null = كلها) — نافذة التعديل وفاتورة الإدارة
  defaultPriceListId: true, allowedPriceTypes: true,
  canCreateReceipt: true, canEditReceipt: true, canCancelReceipt: true,
  canManageVanStock: true,
  canAddCustomer: true, canEditCustomer: true, canViewStatement: true,
  showCollectionBalance: true,
  cashSaleCollected: true,
  requireCustomerProximity: true,
  requireLocationOn: true,
  requirePunchAtCustomer: true,
  proximityRadiusM: true,
  punchRadiusM: true,
  punchOutsideAction: true,
  requireBoundDevice: true, boundDeviceName: true, boundDeviceAt: true,
  requirePresenceCheck: true,
  showRouteOnMap: true,
  shiftStart: true, shiftEnd: true, shiftDays: true,
  // «لوكيشن»: موقع المندوب الحاليّ للقراءة وحدها — من يقرأ المناديب (ومنهم مفتاح API) يعرف موقع كلٍّ منهم بلا صفحة لوكيشن
  // المحجوبة بعَلَمها. الإسناد نفسه من PUT /api/locations/reps/:salesRepId وحده (repSchema لا يقبله فلا يُكتب من هنا)
  locationId: true,
  createdAt: true,
} as const;

// ═══ «أنواع الأسعار على مستوى المندوب» — القواعد الصرفة في services/priceLists.ts (نسخةٌ مطابقة في الويب) ═══

type PriceTypeCode = 'PRICE_LIST_INVALID' | 'PRICE_TYPE_DEFAULT_NOT_ALLOWED';
const refusePriceType = (res: Response, code: PriceTypeCode): void => {
  res.status(400).json({ success: false, code, message: PRICE_LIST_MESSAGES[code] });
};
type PriceTypeBody = { defaultPriceListId?: string | null; allowedPriceTypes?: string[] | null };
type PriceTypeData = { defaultPriceListId?: string | null; allowedPriceTypes?: string[] | typeof Prisma.DbNull };

/**
 * حقلا نوع السعر من الجسم إلى صفّ المندوب — غيابهما معاً ⇒ لا شيء ولا استعلام (مسار اليوم حرفياً):
 * - الافتراضي: معرّف نوع، والفارغ و'base' ⇒ null (السعر الأساسي).
 * - المسموح: بلا تكرار بترتيبه، و'base' فيه رمزاً كما يُخزَّن؛ والفارغ أو null ⇒ عمودٌ فارغ (DbNull) = بلا قيد كاليوم.
 * - والافتراضي (المرسل وإلا المحفوظ) داخل المسموح (المرسل وإلا المحفوظ) حين يُقيَّد ⇒ وإلا PRICE_TYPE_DEFAULT_NOT_ALLOWED.
 * `lockIds` معرّفات الأنواع المرسلة: شركتها تُفحص تحت القفل في معاملة الكتابة (priceListsLocked)
 */
function priceTypeWrite(
  body: PriceTypeBody, current?: { defaultPriceListId: string | null; allowedPriceTypes: unknown },
): { error: PriceTypeCode } | { data: PriceTypeData; lockIds: string[] } {
  const sentDefault = body.defaultPriceListId !== undefined;
  const sentAllowed = body.allowedPriceTypes !== undefined;
  if (!sentDefault && !sentAllowed) return { data: {}, lockIds: [] };
  const raw = body.defaultPriceListId;
  const def = sentDefault ? (raw && raw !== BASE_PRICE_TYPE ? raw : null) : (current?.defaultPriceListId ?? null);
  const parsed = allowedPriceTypesOf(sentAllowed ? body.allowedPriceTypes : current?.allowedPriceTypes);
  const allowed = parsed?.length ? parsed : null;
  if (allowed && !allowed.includes(def)) return { error: 'PRICE_TYPE_DEFAULT_NOT_ALLOWED' };
  const data: PriceTypeData = {};
  if (sentDefault) data.defaultPriceListId = def;
  if (sentAllowed) data.allowedPriceTypes = allowed ? allowed.map((t) => t ?? BASE_PRICE_TYPE) : Prisma.DbNull;
  const ids = [...(sentDefault && def ? [def] : []), ...(sentAllowed && allowed ? allowed.filter((t): t is string => t !== null) : [])];
  return { data, lockIds: [...new Set(ids)] };
}

/**
 * أنواع المندوب المرسلة كلها من الشركة؟ في معاملة كتابته وبقفل FOR KEY SHARE على صفوفها حتى الالتزام: حذف النوع يقفل صفّه
 * FOR UPDATE ثم يعدّ مناديبه (routes/priceLists.ts) — فإمّا انتظر هذه الكتابة فعدّها (409)، وإمّا سبقها فلا يعود صفّه هنا (400).
 * فلا يبقى في allowedPriceTypes (JSON بلا مفتاح أجنبي) معرّفٌ محذوف، ولا يسقط الافتراضي إلى الأساس بصمت (SetNull)
 */
async function priceListsLocked(tx: Prisma.TransactionClient, tid: string, ids: string[]): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM price_lists WHERE "tenantId" = ${tid} AND id IN (${Prisma.join(ids)}) FOR KEY SHARE`;
  return (rows ?? []).length === ids.length;
}

/**
 * حقلا نوع السعر المحفوظان للمندوب تحت قفل صفّه (FOR UPDATE) في معاملة التعديل: الفحص الأوّل على صفٍّ قُرئ قبل المعاملة،
 * فتعديلان جزئيان متزامنان (المسموح وحده ثم الافتراضي وحده) يمرّ كلٌّ منهما على المحفوظ القديم من الآخر فيُخزَّن افتراضيٌّ خارج
 * المسموح — وتردّ بعده كلُّ حفظةٍ لنافذته 400 PRICE_TYPE_DEFAULT_NOT_ALLOWED. فالثاني ينتظر الأوّل هنا ثم يُفحص على ما التزم.
 * null = لم يعد الصفّ (حُذف المندوب بين القراءتين)
 */
async function lockedRepPriceTypes(
  tx: Prisma.TransactionClient, tid: string, id: string,
): Promise<{ defaultPriceListId: string | null; allowedPriceTypes: unknown } | null> {
  const rows = await tx.$queryRaw<Array<{ defaultPriceListId: string | null; allowedPriceTypes: unknown }>>`
    SELECT "defaultPriceListId", "allowedPriceTypes" FROM sales_reps WHERE id = ${id} AND "tenantId" = ${tid} FOR UPDATE`;
  return rows?.[0] ?? null;
}

/** مهلة معاملة الأنواع: القفل قد ينتظر حذف نوعٍ يفرّغ ختم آلاف الفواتير (مهلته ٣٠ ثانية في routes/priceLists.ts) لا خمس ثوانٍ */
const PRICE_TYPES_TX = { maxWait: 10_000, timeout: 30_000 };

/** مفتاح الافتراضي الأجنبي (P2003) — نوعٌ حُذف قبل الكتابة: رفضٌ مفهوم لا عطل 500 (كـisPriceListFkFail في routes/customers.ts) */
const isRepDefaultFkFail = (err: unknown): boolean => {
  const e = err as { code?: unknown; meta?: { field_name?: unknown } } | null;
  return e?.code === 'P2003' && String(e.meta?.field_name ?? '').includes('defaultPriceListId');
};

router.get('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const search = req.query.search as string | undefined;

    const where = {
      tenantId: tid,
      // نطاق المستخدم: مستخدم الشركة مقيّد النطاق لا يرى إلا مناديبه المُسنَدين
      ...(await adminRepFilter(req)),
      ...(search && { OR: [{ name: { contains: search } }, { phone: { contains: search } }, { username: { contains: search } }] }),
    };

    const [total, reps] = await Promise.all([
      prisma.salesRep.count({ where }),
      prisma.salesRep.findMany({ where, ...paginate(page, limit), orderBy: { name: 'asc' }, select: repSelect }),
    ]);

    res.json({ success: true, data: reps, pagination: paginationMeta(total, page, limit) });
  } catch (err) { next(err); }
});

router.get('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const rep = await prisma.salesRep.findFirst({ where: { id: req.params.id, tenantId: tid, ...(await adminRepFilter(req)) }, select: repSelect });
    if (!rep) { res.status(404).json({ success: false, message: 'المندوب غير موجود' }); return; }
    res.json({ success: true, data: rep });
  } catch (err) { next(err); }
});

// جلسة «دخول» موظف المنصة لا تُنشئ مندوباً بكلمة مرور يختارها — حسابٌ يبقى بعد تعطيله (services/platformAccess.ts)
router.post('/', noStaffCredentials, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const { password, defaultPriceListId, allowedPriceTypes, ...rest } = repSchema.parse(req.body);
    if (!password) { res.status(400).json({ success: false, message: 'كلمة المرور مطلوبة' }); return; }
    if (password.length < 8) { res.status(400).json({ success: false, message: 'كلمة المرور 8 أحرف على الأقل' }); return; }
    const priced = priceTypeWrite({ defaultPriceListId, allowedPriceTypes });
    if ('error' in priced) { refusePriceType(res, priced.error); return; }

    // فرض الحد الأقصى لعدد المناديب المسموح للشركة (إن وُجد)
    const tenant = await prisma.tenant.findUnique({ where: { id: tid }, select: { maxSalesReps: true } });
    if (tenant?.maxSalesReps != null) {
      const current = await prisma.salesRep.count({ where: { tenantId: tid } });
      if (current >= tenant.maxSalesReps) {
        res.status(403).json({ success: false, message: `بلغت الشركة الحد الأقصى المسموح للمناديب (${tenant.maxSalesReps}) تواصل مع مزود الخدمة لرفع الحد` });
        return;
      }
    }

    const dup = await checkRepDuplicates(tid, rest.username, rest.phone, rest.email);
    if (dup) { res.status(409).json({ success: false, message: dup }); return; }

    const passwordHash = await bcrypt.hash(password, 10);
    const created = {
      data: { ...rest, ...priced.data, passwordHash, email: rest.email || null, tenantId: tid } as any,
      select: { id: true, name: true, phone: true, username: true, isActive: true },
    };
    // بأنواع أسعارٍ مرسلة: فحص شركتها وقفلها والإنشاء في معاملةٍ واحدة (priceListsLocked)، وإلا كتابةٌ واحدة كما كانت
    const rep = priced.lockIds.length
      ? await prisma.$transaction(async (tx) => ((await priceListsLocked(tx, tid, priced.lockIds)) ? tx.salesRep.create(created) : null), PRICE_TYPES_TX)
      : await prisma.salesRep.create(created);
    if (!rep) { refusePriceType(res, 'PRICE_LIST_INVALID'); return; }
    res.status(201).json({ success: true, data: rep });
  } catch (err) {
    if (isRepDefaultFkFail(err)) { refusePriceType(res, 'PRICE_LIST_INVALID'); return; }
    next(err);
  }
});

// تفرّد اسم المستخدم عالمي (للدخول)، والجوال/البريد ضمن الشركة
async function checkRepDuplicates(tid: string, username: string, phone: string, email?: string, excludeId?: string): Promise<string | null> {
  const notSelf = excludeId ? { id: { not: excludeId } } : {};
  if (await prisma.salesRep.findFirst({ where: { username, ...notSelf } })) return 'اسم المستخدم مستخدم مسبقا اختر اسما آخر';
  if (await prisma.salesRep.findFirst({ where: { tenantId: tid, phone, ...notSelf } })) return 'رقم الجوال مستخدم مسبقا لمندوب آخر';
  if (email && await prisma.salesRep.findFirst({ where: { tenantId: tid, email, ...notSelf } })) return 'البريد الإلكتروني مستخدم مسبقا';
  return null;
}

router.put('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const current = await prisma.salesRep.findFirst({ where: { id: req.params.id, tenantId: tid, ...(await adminRepFilter(req)) } });
    if (!current) { res.status(404).json({ success: false, message: 'المندوب غير موجود' }); return; }

    const { password, defaultPriceListId, allowedPriceTypes, ...rest } = repSchema.partial().parse(req.body);
    // ولا تضع كلمة مرور مندوبٍ قائم
    if (refuseStaffCredentials(req, res, !!password)) return;
    if (password && password.length < 8) { res.status(400).json({ success: false, message: 'كلمة المرور 8 أحرف على الأقل' }); return; }
    // «أنواع الأسعار على مستوى المندوب»: المرسل منهما يُفحص مع المحفوظ من الآخر (الافتراضي داخل المسموح)
    const priced = priceTypeWrite({ defaultPriceListId, allowedPriceTypes }, current);
    if ('error' in priced) { refusePriceType(res, priced.error); return; }
    if (rest.username || rest.phone || rest.email) {
      const dup = await checkRepDuplicates(
        tid,
        rest.username ?? current.username,
        rest.phone ?? current.phone,
        rest.email ?? current.email ?? undefined,
        req.params.id
      );
      if (dup) { res.status(409).json({ success: false, message: dup }); return; }
    }
    const updateData: Record<string, unknown> = { ...rest, email: rest.email || null };
    Object.assign(updateData, priced.data);
    if (password) updateData.passwordHash = await bcrypt.hash(password, 10);
    // إطفاء «ربط البصمة بجهاز واحد» يفكّ الجهاز المربوط: ربطٌ نائم يبقى بعد الإطفاء يتيح ربط الجوال نفسه بمندوبٍ آخر،
    // فإذا أُعيد القيد بصم الجوال الواحد لاثنين. وإعادة القيد تربط من جديد أوّل جهازٍ يبصم
    const unbind = rest.requireBoundDevice === false && current.boundDeviceId != null;
    if (unbind) Object.assign(updateData, { boundDeviceId: null, boundDeviceName: null, boundDeviceAt: null });
    const select = { id: true, name: true, phone: true, username: true, isActive: true } as const;
    const unbindAudit = {
      data: {
        tenantId: tid, salesRepId: current.id, action: 'UNBIND_DEVICE', reason: 'أُطفئ قيد ربط البصمة بجهاز واحد',
        before: { deviceName: current.boundDeviceName, boundAt: current.boundDeviceAt?.toISOString() ?? null },
        actorId: actorOf(req), actorName: auditActorName(req),
      },
    };
    // بأيٍّ من حقلي الأنواع مرسلاً: قفل صفّ المندوب وإعادة فحص الافتراضي داخل المسموح على المحفوظ تحته (lockedRepPriceTypes)،
    // ثم فحص شركة الأنواع وقفلها (priceListsLocked)، فالتعديل وسطر فكّ الجهاز إن وُجد — كلها في معاملةٍ واحدة
    const sentPriceTypes = Object.keys(priced.data).length > 0;
    const rep = sentPriceTypes
      ? await prisma.$transaction(async (tx) => {
        const stored = await lockedRepPriceTypes(tx, tid, current.id);
        if (!stored) return 'REP_GONE' as const;
        const fresh = priceTypeWrite({ defaultPriceListId, allowedPriceTypes }, stored);
        if ('error' in fresh) return fresh.error;
        if (fresh.lockIds.length && !(await priceListsLocked(tx, tid, fresh.lockIds))) return 'PRICE_LIST_INVALID' as const;
        const row = await tx.salesRep.update({ where: { id: current.id }, data: { ...updateData, ...fresh.data }, select });
        if (unbind) await tx.attendanceAudit.create(unbindAudit);
        return row;
      }, PRICE_TYPES_TX)
      : unbind
        ? (await prisma.$transaction([
          prisma.salesRep.update({ where: { id: current.id }, data: updateData, select }),
          prisma.attendanceAudit.create(unbindAudit),
        ]))[0]
        : await prisma.salesRep.update({ where: { id: req.params.id }, data: updateData, select });
    if (rep === 'REP_GONE') { res.status(404).json({ success: false, message: 'المندوب غير موجود' }); return; }
    if (typeof rep === 'string') { refusePriceType(res, rep); return; }
    res.json({ success: true, data: rep });
  } catch (err) {
    if (isRepDefaultFkFail(err)) { refusePriceType(res, 'PRICE_LIST_INVALID'); return; }
    next(err);
  }
});

/**
 * فكّ ربط جهاز البصمة (طلب المالك، ٢١ أكتوبر ٢٠٢٦): المندوب غيّر جواله أو مسح بيانات التطبيق — أول بصمةٍ بعد الفكّ
 * تربط جهازها الجديد. يُدوَّن في سجلّ تدقيق الحضور: مَن فكّ ومتى، والجهاز الذي كان مربوطاً.
 */
router.post('/:id/unbind-device', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const rep = await prisma.salesRep.findFirst({
      where: { id: req.params.id, tenantId: tid, ...(await adminRepFilter(req)) },
      select: { id: true, boundDeviceId: true, boundDeviceName: true, boundDeviceAt: true },
    });
    if (!rep) { res.status(404).json({ success: false, message: 'المندوب غير موجود' }); return; }
    if (!rep.boundDeviceId) { res.json({ success: true, data: { unbound: false } }); return; }
    await prisma.$transaction([
      prisma.salesRep.update({ where: { id: rep.id }, data: { boundDeviceId: null, boundDeviceName: null, boundDeviceAt: null } }),
      prisma.attendanceAudit.create({
        data: {
          tenantId: tid, salesRepId: rep.id, action: 'UNBIND_DEVICE',
          before: { deviceName: rep.boundDeviceName, boundAt: rep.boundDeviceAt?.toISOString() ?? null },
          actorId: actorOf(req), actorName: auditActorName(req),
        },
      }),
    ]);
    res.json({ success: true, data: { unbound: true } });
  } catch (err) { next(err); }
});

router.get('/:id/stats', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const { from, to } = req.query;
    // طرفٌ واحد يكفي؛ و«إلى» تشمل يومها كاملاً (لا حتى منتصف ليله)
    const dateFilter = (from || to) ? {
      ...(from ? { gte: new Date(from as string) } : {}),
      ...(to ? { lte: new Date(new Date(to as string).setHours(23, 59, 59, 999)) } : {}),
    } : undefined;

    // نطاق المستخدم: مندوبٌ خارج نطاقه 404 كبقية مسارات المندوب، والمجاميع بنطاق المستند (مشرف الفرق: ما وُسم بفرقه)
    if (!(await prisma.salesRep.findFirst({ where: { id: req.params.id, tenantId: tid, ...(await adminRepFilter(req)) }, select: { id: true } }))) {
      res.status(404).json({ success: false, message: 'المندوب غير موجود' }); return;
    }
    const docScope = await scopedRecordWhere(req, SHAPE_INVOICE_RECEIPT);
    // «إجمالي المبيعات» صافٍ (طلب المالك ٢٩ أكتوبر ٢٠٢٦): كان المجموع بلا شرط نوعٍ فيُضيف المرتجع إلى مبيعات المندوب —
    // صار البيع وحده ثم يُطرح منه المرتجع (services/netSales.ts)، والعدد عدد فواتير البيع
    const [invoices, returns, receipts] = await Promise.all([
      prisma.invoice.aggregate({
        where: { tenantId: tid, salesRepId: req.params.id, status: 'CONFIRMED', type: { not: 'RETURN' }, ...(dateFilter && { invoiceDate: dateFilter }), ...docScope },
        _count: { id: true }, _sum: { total: true },
      }),
      prisma.invoice.aggregate({
        where: { tenantId: tid, salesRepId: req.params.id, status: 'CONFIRMED', type: 'RETURN', ...(dateFilter && { invoiceDate: dateFilter }), ...docScope },
        _sum: { total: true },
      }),
      prisma.receipt.aggregate({
        where: { tenantId: tid, salesRepId: req.params.id, status: 'ACTIVE', ...(dateFilter && { receiptDate: dateFilter }), ...docScope },
        _count: { id: true }, _sum: { amount: true },
      }),
    ]);

    res.json({
      success: true,
      data: {
        invoicesCount: invoices._count.id,
        salesTotal: netSales(invoices._sum.total, returns._sum.total),
        receiptsCount: receipts._count.id,
        collectionsTotal: receipts._sum.amount ?? 0,
      },
    });
  } catch (err) { next(err); }
});

/**
  * حذف مندوب — لمن يملك إدارة المناديب، مهما ارتبط بأيّ شيء.
  *
  * الفواتير والسندات والإقرارات اليومية (سجلّات مالية) وتحميلات السيارة (حركات
  * مخزون) تبقى ويُفرَّغ مرجع المندوب منها، وبياناته التشغيلية (مواقع، زيارات،
  * إسنادات) تُحذف.
  *
  * وكان مقصوراً على مدير الشركة فقط، فيفشل حذفُ المشرف بـ403 ولا يفهم سبباً.
  * والراوتر كلّه محروسٌ بـ`canManageSalesReps` — صلاحيةٌ يمنحها مدير الشركة
  * عمداً — فمن ائتُمن على إنشاء المناديب وتعديل صلاحياتهم يُؤتمن على حذفهم.
  * (حذفُ **استلام تحصيل** بعينه يبقى للمدير الرئيسي: ذاك مبلغٌ بذاته.)
 */
router.delete('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const rep = await prisma.salesRep.findFirst({ where: { id: req.params.id, tenantId: tid, ...(await adminRepFilter(req)) }, select: { id: true, name: true } });
    if (!rep) { res.status(404).json({ success: false, message: 'المندوب غير موجود' }); return; }

    // معاملة واحدة: تفريغ مرجع المندوب من السجلّات ثم حذف بياناته التشغيلية فالمندوب.
    // أولها حارس الدفاتر §5.3 (409 LEDGER_HISTORY_LOCKED، قفل المندوب FOR UPDATE) — التفصيل في assertRepDeletable.
    await prisma.$transaction(async tx => {
      await assertRepDeletable(tx, tid, req.params.id);
      /* قفل صفّ المندوب FOR UPDATE لكل شركة قبل أي تفريغ («ربط الدفاتر» L1، C18): الحارس أعلاه يقفله حين تُفعَّل الدفاتر وحدها،
       * وأغلب الشركات بلا دفاتر — فسندٌ يُرفع أثناء حذفٍ طويل (مواقع GPS لأشهر) كان يأخذ FOR KEY SHARE بلا انتظار ويلتزم بعد تفريغ
       * السندات، ثم يفرّغ ON DELETE SetNull مندوبَه بصمت ويبقى deletedSalesRepId فارغاً: يضيع أثر من قبض المال. مع القفل ينتظر
       * الإدراج المتزامن التزامَ الحذف ثم يفشل صريحاً (P2003)، والجاري قبله يُنتظَر فيراه التفريغ أدناه (قفلٌ مكرَّر في المعاملة نفسها
       * للشركة المفعّلة بلا أثر). الفحص الفعلي للتزامن خطوة يدوية على قاعدة حقيقية */
      await tx.$queryRaw`SELECT id FROM sales_reps WHERE id = ${req.params.id} AND "tenantId" = ${tid} FOR UPDATE`;
      await tx.invoice.updateMany({ where: { tenantId: tid, salesRepId: req.params.id }, data: { salesRepId: null } });
      /* «ربط الدفاتر» L1 (C18): السند يبقى بمرجعٍ مفرَّغ ومعرّفُ مندوبه في deletedSalesRepId — في الكتابة نفسها التي تفرّغ salesRepId
       * (كتحميلات السيارة واستلامات التحصيل أدناه). كان التفريغ يمحو أثر من قبض المال بلا رجعة، فلا تُعاد عهدة المندوب المحذوف
       * (١١١٠٠٣ لكل مندوب) حين تُبنى الدفاتر المربوطة رجعياً من بداية السنة */
      await tx.receipt.updateMany({ where: { tenantId: tid, salesRepId: req.params.id }, data: { salesRepId: null, deletedSalesRepId: req.params.id } });
      /* الإقرار اليوميّ سجلٌّ كالفاتورة: وُقِّع عليه وصدرت به حصائل. وكان يُمحى
       * تعاقبياً بحذف المندوب بلا سطرٍ هنا يقول ذلك — فتختفي تقارير شهورٍ
       * وتبقى حصائلها تُعلن أرقاماً لا مصدر لها. */
      await tx.dailyReport.updateMany({ where: { tenantId: tid, salesRepId: req.params.id }, data: { salesRepId: null } });
      // توجيه العقد لهذا المندوب تهيئةٌ لا سجلّ — يُحذف
      await tx.dailyReportOwnerRep.deleteMany({ where: { tenantId: tid, salesRepId: req.params.id } });
      await tx.notification.deleteMany({ where: { tenantId: tid, salesRepId: req.params.id } });
      /* التحميل والتنزيل حركتا مخزون لا بيانات تشغيل: رصيد المستودع يُحسب من كل
       * تحميلات الشركة، فمحوها (كما كان) يُعيد إليه كل ما حمّله المندوب وباعه —
       * حادثة ٢ أكتوبر ٢٠٢٦. تبقى بمرجعٍ مفرَّغ، ومعرّفه في deletedSalesRepId كي
       * تبقى «سيارته» مكدّساً مستقلاً في تقييم المستودع. والحذف يمضي دائماً (قرار المالك). */
      await tx.vanLoad.updateMany({ where: { tenantId: tid, salesRepId: req.params.id }, data: { salesRepId: null, deletedSalesRepId: req.params.id } });
      /* عهدة الأدوات (مراجعة المخزون D9) كتحميلات السيارة: SetNull وحده كان يُخفي ما في يده من عربات وسلال عن كل شاشة فتضيع
       * المطالبة بها. تبقى بمرجعٍ مفرَّغ ومعرّفه في deletedSalesRepId، فتظهر «مندوب محذوف» وتُستلم منه (routes/vanStock.ts) */
      await tx.vanToolMove.updateMany({ where: { tenantId: tid, salesRepId: req.params.id }, data: { salesRepId: null, deletedSalesRepId: req.params.id } });
      await tx.repLocation.deleteMany({ where: { salesRepId: req.params.id } });
      await tx.repVisit.deleteMany({ where: { salesRepId: req.params.id } }); // صورها تُحذف تعاقبياً
      /* استلام التحصيل سجلٌّ مالي لا بيانات تشغيل: هو «المستلَم» في عهدة مستخدم الشركة الذي استلم (userCustody).
       * محوُه (كما كان) يُصفّر عهدة مالٍ ما زال في يده أو يجعلها سالبة بعد توريده — ويتجاوز حارسَي حذف الاستلام الواحد
       * (المدير الرئيسي، وألّا تصير العهدة سالبة). يبقى بمرجعٍ مفرَّغ ومعرّفه في deletedSalesRepId كتحميلات السيارة. */
      await tx.repSettlement.updateMany({ where: { tenantId: tid, salesRepId: req.params.id }, data: { salesRepId: null, deletedSalesRepId: req.params.id } });
      await tx.customerAssignment.deleteMany({ where: { salesRepId: req.params.id } }); // إسنادات العملاء
      // «مناديب محدّدون» للمندوب الذكي: قائمة معرّفات بلا مفتاح أجنبي — مندوبٌ محذوف يبقى فيها فيرفض كل حفظٍ لاحق للإعدادات
      const ai = await tx.aiRepSettings.findUnique({ where: { tenantId: tid }, select: { repIds: true } });
      if (ai?.repIds.includes(req.params.id)) {
        await tx.aiRepSettings.update({ where: { tenantId: tid }, data: { repIds: ai.repIds.filter(x => x !== req.params.id) } });
      }
      await tx.salesRep.delete({ where: { id: req.params.id } });
    }, { maxWait: 10_000, timeout: 120_000 }); // مصفوفة المعاملة لم تكن بمهلة 5 ثوانٍ؛ مواقع GPS لشهور قد تطول
    res.json({ success: true });
  } catch (err) {
    if (isLedgerError(err, 'LEDGER_HISTORY_LOCKED')) {
      res.status(409).json({ success: false, code: err.code, message: err.message, ...err.details });
      return;
    }
    next(err);
  }
});

// ===== إسناد العملاء للمندوب (عزل العملاء) =====

// حالة مفتاح «عزل عملاء المناديب» للشركة. مسار من مقطعين فلا يتعارض مع /:id
router.get('/settings/isolation', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const s = await prisma.companySettings.findUnique({
      where: { tenantId: tid }, select: { customerIsolationEnabled: true },
    });
    res.json({ success: true, data: { enabled: s?.customerIsolationEnabled === true } });
  } catch (err) { next(err); }
});

// تشغيل/إيقاف العزل للشركة — عند الإيقاف يعود كل المناديب لرؤية كل العملاء (الإسنادات تبقى محفوظة)
router.patch('/settings/isolation', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    await prisma.companySettings.update({
      where: { tenantId: tid },
      data: { customerIsolationEnabled: enabled },
    });
    res.json({ success: true, data: { enabled } });
  } catch (err) { next(err); }
});

// العملاء المُسنَدون لمندوب — تملأ نافذة «إسناد العملاء» في صفحة المناديب
router.get('/:id/customers', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const rep = await prisma.salesRep.findFirst({ where: { id: req.params.id, tenantId: tid, ...(await adminRepFilter(req)) }, select: { id: true } });
    if (!rep) { res.status(404).json({ success: false, message: 'المندوب غير موجود' }); return; }
    // نُرفق بيانات العميل كي تعرض النافذة المُسنَدين دون تحميل كل عملاء الشركة
    const rows = await prisma.customerAssignment.findMany({
      where: { tenantId: tid, salesRepId: req.params.id },
      select: {
        customerId: true, source: true,
        customer: { select: { id: true, name: true, businessName: true, phone: true, code: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json({
      success: true,
      data: {
        customerIds: rows.map(r => r.customerId),
        // AUTO = فتحه المندوب بنفسه، MANUAL = أسندته الإدارة (لتمييزها في الواجهة)
        autoIds: rows.filter(r => r.source === 'AUTO').map(r => r.customerId),
        customers: rows.map(r => r.customer).filter(Boolean),
      },
    });
  } catch (err) { next(err); }
});

// تعديل عملاء المندوب بالفروقات فقط — {add, remove}.
// عمداً ليست «استبدالاً كاملاً»: الواجهة لا تحمّل كل العملاء دفعةً واحدة، فإرسال قائمة
// كاملة كان سيحذف صامتاً إسنادَ كل عميل لم يظهر في نافذة الإدارة. الفروقات تجعل ذلك مستحيلاً.
router.put('/:id/customers', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const repId = req.params.id;
    const rep = await prisma.salesRep.findFirst({ where: { id: repId, tenantId: tid, ...(await adminRepFilter(req)) }, select: { id: true } });
    if (!rep) { res.status(404).json({ success: false, message: 'المندوب غير موجود' }); return; }

    const body = z.object({
      add: z.array(z.string()).max(50000).optional(),
      remove: z.array(z.string()).max(50000).optional(),
    }).parse(req.body);

    const toRemove = [...new Set(body.remove ?? [])];
    const wantAdd = [...new Set(body.add ?? [])].filter(id => !toRemove.includes(id));

    // لا يُسنَد إلا عميل من نفس الشركة (حارس ضد تسريب بين الشركات)، **وضمن نطاق
    // المستخدم**: مستخدم مقيّد لا يُسنِد عميلاً لا يراه. بلا هذا القيد يستطيع
    // تمرير معرّفات مباشرةً فيتجاوز عزله من حيث لا تراه الواجهة.
    const valid = wantAdd.length
      ? await prisma.customer.findMany({
          where: { tenantId: tid, id: { in: wantAdd }, ...(await adminCustomerFilter(req)) },
          select: { id: true },
        })
      : [];
    const toAdd = valid.map(c => c.id);

    await prisma.$transaction([
      ...(toRemove.length ? [prisma.customerAssignment.deleteMany({
        where: { tenantId: tid, salesRepId: repId, customerId: { in: toRemove } },
      })] : []),
      ...(toAdd.length ? [prisma.customerAssignment.createMany({
        data: toAdd.map(customerId => ({ tenantId: tid, salesRepId: repId, customerId, source: 'MANUAL' })),
        skipDuplicates: true,
      })] : []),
    ]);

    const total = await prisma.customerAssignment.count({ where: { tenantId: tid, salesRepId: repId } });
    res.json({ success: true, data: { added: toAdd.length, removed: toRemove.length, total } });
  } catch (err) { next(err); }
});

// رصيد التحصيل لدى المندوب = مجموع سنداته النشطة + فواتيره النقدية المحسوبة تحصيلاً (services/repCashCollection.ts)
// − مجموع ما استلمه الأدمن منه − صافي ما صُرف من عهدته للموردين («الدفع من عهدة مندوب»، services/suppliers/repCustody.ts).
// «الفرق»: `teamWhere` (composeTeamCustodyWhere) على الأطراف الثلاثة معاً — رصيد الفريق = سنداته ونقديّه الموسومة − استلاماته الموسومة.
// وسند صرف المورّد بلا فريق: يدخل العرض الإجمالي ودلو «بلا فريق» وحدهما (custodyIncludesTeamless)
async function repCollection(tid: string, repId: string, teamWhere: Record<string, unknown> = {}) {
  const [collected, cashSales, settled, spent] = await Promise.all([
    prisma.receipt.aggregate({ where: { tenantId: tid, salesRepId: repId, status: 'ACTIVE', ...teamWhere }, _sum: { amount: true } }),
    prisma.invoice.aggregate({ where: { tenantId: tid, salesRepId: repId, AND: [REP_COLLECTED_CASH_SALE, teamWhere] }, _sum: { paidAmt: true } }),
    prisma.repSettlement.aggregate({ where: { tenantId: tid, salesRepId: repId, ...teamWhere }, _sum: { amount: true } }),
    // المال خرج من يد المندوب إلى المورّد — بلاه يسلّم المندوب الباقي فيبقى عليه ثمن الشراء «عجزاً» دائماً
    custodyIncludesTeamless(teamWhere) ? repCustodySupplierNet(prisma, tid, repId) : Promise.resolve(0),
  ]);
  const cash = cashSales._sum.paidAmt ?? 0;
  const c = (collected._sum.amount ?? 0) + cash;
  const s = settled._sum.amount ?? 0;
  // collected يشمل النقدية المحسوبة، وcashSales جزؤها منه للعرض؛ وpaidToSuppliers حين وُجد وحده (الردّ لغيره كما كان)
  return { collected: clean(c), cashSales: clean(cash), settled: clean(s), ...(spent !== 0 && { paidToSuppliers: clean(spent) }), outstanding: clean(c - s - spent) };
}

/** الفريق المطلوب لعرض العهدة (`?teamId=`) — نصٌّ غير فارغ وإلا لا طلب */
const requestedTeam = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 64) : null);

/**
 * فرقٌ تحمل عهدةً موسومة لهذا المندوب لم تُستلم (سنداته النشطة بوسمها − استلاماته بوسمها ≠ ٠) — ولو تركها المندوب أو
 * أُطفئت الميزة: عهدتها تبقى حتى تُستلم عليها، وإلا لم يبقَ إلا تسجيلها على فريقٍ آخر أو بلا فريق فتختلّ العهدتان معاً.
 * وللمشرف فرقه منها وحدها.
 */
async function custodyTeamsOf(tid: string, repId: string, sup: string | null): Promise<{ id: string; name: string; isActive: boolean }[]> {
  const [r, cs, s] = await Promise.all([
    prisma.receipt.groupBy({ by: ['teamId'], where: { tenantId: tid, salesRepId: repId, status: 'ACTIVE', teamId: { not: null } }, _sum: { amount: true } }),
    // «البيع النقدي تحصيلٌ لدى المندوب»: نقديّه المحسوب عهدةٌ لفريقه كسنداته
    prisma.invoice.groupBy({ by: ['teamId'], where: { tenantId: tid, salesRepId: repId, teamId: { not: null }, AND: [REP_COLLECTED_CASH_SALE] }, _sum: { paidAmt: true } }),
    prisma.repSettlement.groupBy({ by: ['teamId'], where: { tenantId: tid, salesRepId: repId, teamId: { not: null } }, _sum: { amount: true } }),
  ]);
  const bal = new Map<string, number>();
  for (const x of r) if (x.teamId) bal.set(x.teamId, (bal.get(x.teamId) ?? 0) + Number(x._sum.amount ?? 0));
  for (const x of cs) if (x.teamId) bal.set(x.teamId, (bal.get(x.teamId) ?? 0) + Number(x._sum.paidAmt ?? 0));
  for (const x of s) if (x.teamId) bal.set(x.teamId, (bal.get(x.teamId) ?? 0) - Number(x._sum.amount ?? 0));
  const ids = [...bal].filter(([, v]) => clean(v) !== 0).map(([id]) => id);
  if (!ids.length) return [];
  return prisma.team.findMany({
    where: { tenantId: tid, id: { in: ids }, ...(sup && { supervisors: { some: { adminId: sup } } }) },
    select: { id: true, name: true, isActive: true },
  });
}

// ملخّص رصيد التحصيل لمندوب (للإدارة). «الفرق» (قرار المالك ١٧ أكتوبر ٢٠٢٦): مشرف الفريق يرى عهدة فرقه وحدها، والمدير غير
// المقيَّد يرى الجميع وله أن يختار فريقاً (أو 'none'). `teams` = فرق المندوب المرئية للطالب لاختيار فريق الاستلام — والمؤرشف
// منها أيضاً (archived): عهدته تبقى حتى تُستلم. وللمشرف فرقه منها وحدها ولو أُطفئت الميزة (عهدته تُحسب بوسم فرقه)
router.get('/:id/collection', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const sup = await teamSupervisorIdOf(req);
    const rep = await prisma.salesRep.findFirst({
      where: { id: req.params.id, tenantId: tid, ...(await adminRepFilter(req)) },
      select: {
        id: true,
        tenant: { select: { settings: { select: { teamsEnabled: true } } } },
        teamMemberships: { select: { team: { select: { id: true, name: true, isActive: true, ...(sup && { supervisors: { where: { adminId: sup }, select: { adminId: true } } }) } } } },
      },
    });
    if (!rep) { res.status(404).json({ success: false, message: 'المندوب غير موجود' }); return; }
    const memberTeams = rep.tenant?.settings?.teamsEnabled === true || sup
      ? rep.teamMemberships.map((m) => m.team as { id: string; name: string; isActive: boolean; supervisors?: unknown[] })
        .filter((t) => !sup || (t.supervisors?.length ?? 0) > 0).map((t) => ({ id: t.id, name: t.name, archived: !t.isActive }))
      : [];
    // وفرق العهدة القائمة التي ليست في القائمة (تركها المندوب، أو أُطفئت الميزة) — former: ليس عضواً فيها الآن
    const custody = (await custodyTeamsOf(tid, rep.id, sup)).filter((t) => !memberTeams.some((m) => m.id === t.id));
    const teams = [...memberTeams, ...custody.map((t) => ({
      id: t.id, name: t.name, archived: !t.isActive, former: !rep.teamMemberships.some((m) => m.team.id === t.id),
    }))];
    const requested = requestedTeam(req.query.teamId);
    const summary = await repCollection(tid, req.params.id, composeTeamCustodyWhere(sup, requested));
    // لغير المشرف حين يعرض فريقاً: الرصيد الإجمالي أيضاً — سقفٌ للتعبئة (استلامٌ سابق «بلا فريق» قد غطّى جزءاً من عهدة
    // الفريق فيبدو منتفخاً). والمشرف لا يُعطاه: الإجمالي يكشف عهدة الفرق الأخرى
    const totalOutstanding = !sup && requested ? (await repCollection(tid, req.params.id)).outstanding : undefined;
    res.json({ success: true, data: {
      ...summary, teams, teamScoped: sup !== null, teamsEnabled: rep.tenant?.settings?.teamsEnabled === true,
      ...(totalOutstanding !== undefined && { totalOutstanding }),
    } });
  } catch (err) { next(err); }
});

// استلام تحصيل من المندوب — يُسجّل المبلغ المستلم فينقص الرصيد المتراكم
router.post('/:id/settlements', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    // «الفرق»: مشرفٌ بوضع TEAMS وحده (لا كل مستخدمٍ بقيت له صفوف إشراف) — بالإشارة نفسها التي يُعرض بها العرض والسجلّ
    const sup = await teamSupervisorIdOf(req);
    const rep = await prisma.salesRep.findFirst({
      where: { id: req.params.id, tenantId: tid, ...(await adminRepFilter(req)) },
      select: {
        id: true,
        tenant: { select: { settings: { select: { teamsEnabled: true } } } },
        teamMemberships: { select: teamMembershipSelectFor(sup) },
      },
    });
    if (!rep) { res.status(404).json({ success: false, message: 'المندوب غير موجود' }); return; }
    // فريق الاستلام صريحٌ لا مُخمَّن (settlementTeamOf): المشرف بفريقه، وغيره بما اختاره أو بلا فريق
    const requested = requestedTeam(req.body?.teamId);
    const pick = settlementTeamOf(rep, sup !== null, requested, (await custodyTeamsOf(tid, rep.id, sup)).map((t) => t.id));
    if ('error' in pick) { res.status(400).json({ success: false, code: 'TEAM_REQUIRED', message: pick.error }); return; }
    const teamId = pick.teamId;
    const amount = Number(req.body?.amount);
    if (!Number.isFinite(amount) || amount <= 0) { res.status(400).json({ success: false, message: 'أدخل مبلغا صحيحا أكبر من صفر' }); return; }
    const note = typeof req.body?.note === 'string' ? req.body.note.slice(0, 300) : undefined;

    /* نوع الاستلام — قاموسٌ مغلق لا نصّ حرّ: عمودٌ يقبل أيّ كلمة يصير بعد شهور
     * خليطاً من «نقدا» و«كاش» و«CASH» لا يُجمَّع في تقرير. وأيّ قيمة خارجه تُردّ
     * إلى النقديّ بدل رفض الاستلام — المبلغ أهمّ من وسمه. */
    const METHODS = ['CASH', 'BANK_TRANSFER', 'POS', 'CHEQUE'];
    const method = METHODS.includes(String(req.body?.method)) ? String(req.body.method) : 'CASH';

    // المرفقات بحدود مرفقات سند القبض نفسها — جسم الطلب محدودٌ بـ10mb
    const rawPhotos = Array.isArray(req.body?.photos) ? req.body.photos : [];
    const photos: string[] = rawPhotos
      .filter((p: unknown): p is string => typeof p === 'string' && p.length <= 2_500_000)
      .slice(0, 4);
    const by = req.user; // AuthPayload كاملاً — تضييقه يُسقط `impersonated`
    /* من يستلم المبلغ تدخل قيمته عهدته، والدور مضمونٌ بـrequireAdmin أعلى الملف.
     * الاستثناء جلسةُ انتحال المالك: توكنها موقَّعٌ بمعرّف **أقدم مديرٍ نشط** في
     * الشركة لا بمعرّف المالك، فلولا هذا الفحص لقُيّدت العهدة على مديرٍ لم يقبض
     * ريالاً ولا يملك إغلاقها إلا بتوريد نقدٍ ليس لديه. */
    const receivedByUserId = by?.impersonated === true ? undefined : by?.id;
    await prisma.repSettlement.create({
      data: {
        tenantId: tid, salesRepId: req.params.id, amount, method, note, teamId,
        createdBy: `${by?.name || by?.id || 'الادمن'}${by?.impersonated ? ' (الدعم الفني)' : ''}`, receivedByUserId,
        // في نفس الكتابة: استلامٌ بلا إيصاله ليس أفضل من لا استلام
        ...(photos.length && { photos: { create: photos.map((data) => ({ data })) } }),
      },
    });
    res.status(201).json({ success: true, data: await repCollection(tid, req.params.id, composeTeamCustodyWhere(sup, requested)) });
  } catch (err) { next(err); }
});

// سجلّ استلامات التحصيل لمندوب
//
// نطاق المستخدم المقيَّد يُفرض هنا كما يُفرض على شقيقيه (collection/settle):
// جدول التسويات لا يحمل علاقة عميل تُقيَّد بها، فالقيد يكون على المندوب نفسه.
// وبدونه كان مستخدمٌ مقيَّد يُعدّد استلامات مندوبٍ خارج نطاقه بتمرير معرّفه.
router.get('/:id/settlements', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const rep = await prisma.salesRep.findFirst({
      where: { id: req.params.id, tenantId: tid, ...(await adminRepFilter(req)) },
      select: { id: true },
    });
    if (!rep) { res.status(404).json({ success: false, message: 'المندوب غير موجود' }); return; }
    /* التصفية على الخادم لا في المتصفّح: السقف ١٠٠ صفّ، فتصفيةٌ محليّة تبحث
     * داخل آخر مئة وحدها — ومندوبٌ تجاوزها يرى «لا استلامات» لشهرٍ قديم بينما
     * صفوفه محفوظة. والمدى هنا يُضيّق الاستعلام نفسه فيبلغ ما وراء المئة. */
    const from = typeof req.query.from === 'string' ? req.query.from : '';
    const to = typeof req.query.to === 'string' ? req.query.to : '';
    const gte = from ? new Date(from) : null;
    // نهاية اليوم لا بدايته: `lte` على منتصف ليل «إلى» يُسقط استلامات اليوم نفسه
    const lte = to ? new Date(new Date(to).setHours(23, 59, 59, 999)) : null;
    const ranged = (gte && !Number.isNaN(gte.getTime())) || (lte && !Number.isNaN(lte.getTime()));

    const items = await prisma.repSettlement.findMany({
      where: {
        tenantId: tid,
        salesRepId: rep.id,
        // «الفرق»: المشرف استلامات فرقه وحدها، وغيره الفريق المختار إن اختار
        ...composeTeamCustodyWhere(await teamSupervisorIdOf(req), requestedTeam(req.query.teamId)),
        ...(ranged && {
          settledAt: {
            ...(gte && !Number.isNaN(gte.getTime()) ? { gte } : {}),
            ...(lte && !Number.isNaN(lte.getTime()) ? { lte } : {}),
          },
        }),
      },
      orderBy: { settledAt: 'desc' },
      take: 100,
      include: { photos: { select: { id: true, data: true }, orderBy: { createdAt: 'asc' } }, team: { select: { name: true } } },
    });
    res.json({ success: true, data: items });
  } catch (err) { next(err); }
});

/**
 * الأدمن الرئيسي للشركة — الدور من القاعدة لا من التوكن.
 *
 * التوكن يحمل الدور لحظة إصداره، فمن خُفّض من ADMIN إلى MANAGER يبقى توكنه
 * القديم يقول ADMIN حتى ينتهي أجله. لا يصحّ أن يُفتح بتوكنٍ فائتٍ بابُ عمليةٍ
 * ماليّة لا رجعة فيها، فنقرأ الدور الحيّ. (والشركة تُطابَق أيضاً كي لا يُسقِط
 * توكنُ شركةٍ حارساً على أخرى.)
 */
async function isPrimaryAdmin(req: AuthRequest): Promise<boolean> {
  const id = req.user?.id;
  if (!id) return false;
  // جلسة مالك المنصة: مديرٌ رئيسيّ ضمناً (أمر المالك ٢٩ سبتمبر ٢٠٢٦ «صلاحية تعديل كل شيء بلا استثناء») — والشركة من توكنها
  if (req.user?.impersonated === true) return true;
  const admin = await prisma.admin.findUnique({ where: { id }, select: { role: true, tenantId: true, isActive: true } });
  return !!admin && admin.isActive && admin.role === 'ADMIN' && admin.tenantId === tenantId(req);
}

/** رفض حذف مستندٍ مرحَّل في شركةٍ دفاترها مربوطة — يُرمى داخل المعاملة فلا تمضي كتابة، ويُحوَّل 409 في المعالج */
class BooksLinkedNoDelete extends Error {
  constructor() { super(LINKED_NO_DELETE_MESSAGE); this.name = 'BooksLinkedNoDelete'; }
}
/** جسم الرفض الموحّد (409) — بالرمز والرسالة من services/booksMode */
export const BOOKS_LINKED_NO_DELETE_BODY = Object.freeze({ success: false, code: LINKED_NO_DELETE_CODE, message: LINKED_NO_DELETE_MESSAGE });

/**
 * حذف استلام تحصيل من سجلّ المندوب — للأدمن الرئيسي وحده.
 *
 * لماذا يُسمح بالحذف أصلاً: تسجيل الاستلام خطوة يدويّة، مبلغٌ يُكتب بلوحة
 * مفاتيح. وخطؤها يقلب رصيد المندوب فيظهر مسدِّداً وهو لم يسدّد، أو تُسجَّل
 * الدفعة مرّتين. فالتصحيح حاجةٌ تشغيليّة لا ترف.
 *
 * ولماذا للأدمن الرئيسي وحده: الحذف **يرفع** الرصيد المتبقّي على المندوب — أي
 * يعيد مطالبته بمالٍ سلّمه فعلاً. قرارٌ ماليّ لا يُترك لمشرفٍ ولا لمحاسب،
 * مطابقةً لحذف المندوب وحذف مستخدم الشركة.
 *
 * ولا يمضي الحذف صامتاً: يُقيَّد في الإشعارات بمبلغه ومن حذفه، ومعه نسخةٌ
 * كاملة من الصفّ في `data` — فمن حذف خطأً يعيد تسجيله كما كان بلا تخمين.
 *
 * والشركة ذات الدفاتر المربوطة (قرار المالك OD1): لا حذف — 409 BOOKS_LINKED_NO_DELETE.
 */
router.delete('/:id/settlements/:settlementId', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    if (!(await isPrimaryAdmin(req))) {
      res.status(403).json({ success: false, message: 'حذف استلام التحصيل متاح للأدمن الرئيسي فقط' });
      return;
    }
    const rep = await prisma.salesRep.findFirst({
      where: { id: req.params.id, tenantId: tid, ...(await adminRepFilter(req)) },
      select: { id: true, name: true },
    });
    if (!rep) { res.status(404).json({ success: false, message: 'المندوب غير موجود' }); return; }

    // الشروط الثلاثة معاً: لا يُحذف صفّ شركةٍ أخرى ولا صفّ مندوبٍ آخر بمعرّفٍ منقول — ومدير مقيَّدٌ بفرقه لا يحذف استلام غيرها
    const sup = await teamSupervisorIdOf(req);
    const row = await prisma.repSettlement.findFirst({
      where: { id: req.params.settlementId, tenantId: tid, salesRepId: rep.id, ...composeTeamCustodyWhere(sup) },
      include: { team: { select: { name: true } } },
    });
    if (!row) { res.status(404).json({ success: false, message: 'سجل الاستلام غير موجود' }); return; }

    const by = req.user;
    // من نفّذ الحذف — وجلسة تصفّح المالك تُوسَم كي لا يُنسب فعله لأدمن الشركة
    const actor = `${by?.name || 'الادمن'}${by?.impersonated ? ' (الدعم الفني)' : ''}`;
    // صاحب العهدة التي دخلها هذا المبلغ — للرسالة، وللحارس داخل المعاملة
    const holder = row.receivedByUserId
      ? await prisma.admin.findFirst({ where: { id: row.receivedByUserId, tenantId: tid }, select: { id: true, name: true } })
      : null;
    const when = new Date(row.settledAt).toISOString().slice(0, 10);

    await prisma.$transaction(async tx => {
      /* «ربط الدفاتر» (قرار المالك OD1): في شركةٍ دفاترها مربوطة (isLinked وحدها) الاستلام مستندٌ مرحَّل — قيد نقل العهدة من
       * المندوب إلى المستلم — فلا يُمحى صفّه؛ التصحيح بعكسٍ لا بحذف (409 BOOKS_LINKED_NO_DELETE). يُقرأ داخل المعاملة وقبل
       * قفل العهدة وأيّ كتابة. والدفاتر اليدوية (CLEAN) وغير المفعّلة والقديمة: الحذف كما كان حرفاً بحرف */
      if (await tenantBooksLinked(tx, tid)) throw new BooksLinkedNoDelete();
      /* حارس العهدة قبل أيّ كتابة.
       *
       * هذا المبلغ دخل عهدة مستخدمٍ حين استُلم. فإن كان قد ورّده — كلّه أو
       * بعضه — صار «ورّد» أكبر من «استلم»: عهدةٌ سالبة تختفي من الشاشة (شرط
       * العرض موجب) وتمنع كلّ توريدٍ لاحق لأنّ سقفه صار سالباً، ولا يصلحها
       * إلّا تدخّلٌ في القاعدة. فيُحذف التوريد أوّلاً من صفحة مستخدمي الشركة.
       * والقفل هنا يمنع توريداً متزامناً يمرّ بين الفحص والحذف. */
      if (holder) {
        await lockCustody(tx, tid, holder.id);
        /* «ربط الدفاتر» OD5: العهدة نقدٌ وشيكات، والتحويل ونقطة البيع «وعاءٌ» يمرّ منه التوريد غير النقدي. فالحارس بالطيّ نفسه
         * بلا الصفّ: لا عهدة سالبة (للاستلام النقدي هو الفحص القديم حرفاً: outstanding − amount)، والاستلام غير النقدي لا يُقارن
         * بعهدةٍ نقدية لا يدخلها. والمربوطة أيضاً: لا يتغيّر تقسيم توريدٍ مرّ منه — الدفاتر تُبقي التقسيم المخزَّن فينحرف 111004 */
        const eps = 5n; // نصف هللة بالملّي — هامش CUSTODY_EPS نفسه في removalKeepsCustodySane
        const inputs = await userCustodyInputs(tx, tid, holder.id);
        const outstanding = Number(foldUserCustody(inputs).outstandingMilli) / 1000;
        const sane = (await tenantBooksLinked(tx, tid))
          ? receivedRemovalKeepsCustodySane(inputs, row.id, eps)
          : foldUserCustody({ ...inputs, received: inputs.received.filter((r) => r.id !== row.id) }).outstandingMilli >= -eps;
        if (!sane) {
          throw new CustodyBlocked(
            `هذا المبلغ في عهدة ${holder.name} وقد ورد منه ما يمنع حذفه`
            + ` — احذف توريده من صفحة مستخدمي الشركة أولا (المتبقي في عهدته ${clean(outstanding)})`,
          );
        }
      }
      // خطاف الدفاتر (§5.3): قبل الحذف وفي معاملته، SETTLEMENT:<id>:POST وSETTLEMENT:<id>:REVERSE معاً بلقطة
      // كاملة للصف — لا شيء حين لم تُفعَّل الدفاتر يوماً (activatedAt فارغ). والمربوطة بحمولتها (receivedByUserId واسمه) كي يُعكس
      // P7 المشمول بالافتتاح على 111004 لا على حساب الطريقة؛ وغيرها كـsettlementTombstones حرفاً
      const glTombstones = await settlementTombstonesWithReceiver(tx, tid, { ...row, salesRepId: rep.id }, { salesRepName: rep.name, receivedByName: holder?.name ?? null });
      if (glTombstones.length > 0) {
        await tx.glSourceEvent.createMany({ data: glTombstones as Prisma.GlSourceEventCreateManyInput[], skipDuplicates: true });
      }
      await tx.repSettlement.delete({ where: { id: row.id } });
      await tx.notification.create({
        data: {
          tenantId: tid,
          type: 'REP_SETTLEMENT_DELETED',
          title: 'حذف استلام تحصيل',
          // النصّ يحمل كل ما يلزم لإعادة التسجيل يدوياً: المبلغ وتاريخه ومن
          // استلمه ومن حذفه. حقل data نسخةٌ للآلة، وهذا السطر نسخةٌ للإنسان —
          // ولا شاشة في المنتج تعرض data، فلو اكتُفي به لضاع الأثر عملياً.
          body: `حذف ${actor} استلام تحصيل بمبلغ ${clean(row.amount)} كان مسجلا بتاريخ ${when}`
            + ` باسم ${row.createdBy || 'غير معروف'} من المندوب ${rep.name}${row.team ? ` لفريق ${row.team.name}` : ''}`
            + ` — عاد المبلغ رصيدا مطلوبا من المندوب`,
          salesRepId: rep.id,
          data: JSON.stringify({
            settlementId: row.id, amount: row.amount, note: row.note, method: row.method, teamId: row.teamId,
            createdBy: row.createdBy, settledAt: row.settledAt,
            deletedBy: actor, deletedById: by?.id,
          }),
        },
      });
    });

    // الرصيد بعد الحذف — لتُحدّث الواجهة بطاقاتها من مصدرٍ واحد لا من حسابٍ محلّي
    res.json({ success: true, data: await repCollection(tid, rep.id, composeTeamCustodyWhere(sup)) });
  } catch (err) {
    if (err instanceof BooksLinkedNoDelete) { res.status(409).json(BOOKS_LINKED_NO_DELETE_BODY); return; }
    if (err instanceof CustodyBlocked) { res.status(400).json({ success: false, message: err.message }); return; }
    next(err);
  }
});

export default router;

