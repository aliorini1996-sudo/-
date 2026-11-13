// ============================================================================
// سجلّ الموردين — /api/suppliers («ربط الدفاتر» L1، طلب المالك ١٣ نوفمبر ٢٠٢٦)
// ----------------------------------------------------------------------------
// المورّد صفٌّ في gl_vendors (سجلّ موردي الدفاتر صار سجلّ الموردين التشغيلي): القائمة والبطاقة والإنشاء والتعديل والأرشفة والحذف،
// وكشف الحساب والفواتير المفتوحة وأعمار الذمم الدائنة. الحساب كله في services/suppliers (core.ts صرفة، statement.ts قراءات بعدد
// استعلامات ثابت) — هنا التحقّق والحرّاس والعزل وتحويل JSON وحدها.
//   • الحرّاس حرّاس المستودع نفسها (routes/warehouse.ts): المندوب مرفوض صراحةً، ثم canManageVanStock، ثم «النظام المحاسبي»
//     (false الصريحة تمنع) ثم «مخزون الشركة» (لا يمرّ إلا بتفعيل صريح). مفتاح «قراءة فقط» يُرفض في الكتابة من authenticate.
//     ومسار السندات (routes/supplierPayments.ts) يركّبها من هنا (useSupplierGuards) فلا يفترق الحارسان أبداً.
//   • الكتابة الوحيدة في gl_* هي سجلّ الموردين نفسه (gl_vendors) — لا قيد ولا حساب ولا شيء آخر من الدفاتر (شرط قبول L1).
//   • التفرّد (الرمز والرقم الضريبي لكل شركة) في التطبيق لا بقيدٍ فريد (الجدول مأهول من M2): قفلٌ استشاري لكل شركة في معاملة
//     الكتابة ثم الفحص ثم الكتابة — فلا يُنشئ طلبان متزامنان رمزاً مكرّراً.
//   • BigInt لا يمرّ في res.json: كل ملّي يُحوَّل بـmilliToNumber إلى رقمٍ بوحدة العملة.
// ============================================================================
import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import prisma from '../config/database';
import { authenticate, requireAdminPermission, tenantId } from '../middleware/auth';
import { AuthRequest } from '../types';
import { companyTimeZone, localDateIn } from '../services/erpPayload';
import { milliToNumber, parseDay } from '../services/suppliers/core';
import {
  agingJson, loadAging, loadOpenBills, loadSupplierBalances, loadSupplierStatement, openBillJson, statementJson, utcDay,
  type SupplierBalanceInfo, type SupplierLedgerRow, type SupplierVendorRow,
} from '../services/suppliers/statement';
import { SupplierError, isSupplierError, supplierErrorBody, supplierPaymentDisplayNumber } from '../services/suppliers/payments';

// ═══ الحرّاس المشتركة (والسندات تركّبها من هنا) ═══

/**
 * المورّدون وسنداتهم للوحة الشركة وحدها: `requireAdminPermission` يمرّر SALES_REP بلا فحص (مقصودٌ للمسارات المشتركة)، وهذه
 * تحمل ذمم الشركة الدائنة وتكلفة مشترياتها — ولا شيء في تطبيق المندوب يستدعيها. فالمنع صريحٌ كما في المستودع.
 */
function refuseSalesRep(req: AuthRequest, res: Response, next: NextFunction): void {
  if (req.user?.role === 'SALES_REP') {
    res.status(403).json({ success: false, message: 'غير مسموح' });
    return;
  }
  next();
}

/**
 * حارس التفعيل بعَلَمين في استعلام واحد كالمستودع: «النظام المحاسبي» يعلو (افتراضه true فيمنع false الصريحة وحدها)، و«مخزون
 * الشركة» مطفأ افتراضياً فلا يمرّ إلا مفعَّلاً صراحةً — الموردون جزءٌ من المشتريات، والمشتريات وارد المستودع.
 */
async function requireWarehouseFeature(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const t = await prisma.tenant.findUnique({ where: { id: tenantId(req) }, select: { warehouseEnabled: true, accountingEnabled: true } });
    if (t?.accountingEnabled === false) {
      res.status(403).json({ success: false, code: 'ACCOUNTING_NOT_ALLOWED', message: 'النظام المحاسبي غير مفعّل لهذه الشركة تواصل مع مزود الخدمة' });
      return;
    }
    if (!t?.warehouseEnabled) {
      res.status(403).json({ success: false, code: 'WAREHOUSE_NOT_ENABLED', message: 'ميزة مخزون الشركة غير مفعلة لهذه الشركة' });
      return;
    }
    next();
  } catch (err) { next(err); }
}

/** يركّب حرّاس الموردين بترتيب المستودع: المصادقة ⇒ رفض المندوب ⇒ canManageVanStock ⇒ العَلَمان */
export function useSupplierGuards(r: Router): void {
  r.use(authenticate);
  r.use(refuseSalesRep);
  r.use(requireAdminPermission('canManageVanStock'));
  r.use(requireWarehouseFeature);
}

// ═══ أدوات مشتركة ═══

/** مهلة معاملات الكتابة: انتظار اتصالٍ ١٠ ثوانٍ والتنفيذ حتى ٢٠ (قفلٌ استشاري وبضع قراءات) */
export const SUPPLIER_TX = Object.freeze({ maxWait: 10_000, timeout: 20_000 });

/** فشل التحقق بشكل الأخطاء المعتاد (errors لكل حقل) مع رمزٍ ثابت تعرفه الواجهة والربط البرمجي */
export function zodFail(res: Response, err: z.ZodError, code: string): void {
  const fieldErrors = err.flatten().fieldErrors;
  const fields = Object.keys(fieldErrors);
  res.status(400).json({
    success: false,
    code,
    message: fields.length ? `بيانات غير صحيحة ${fields.join('، ')}` : 'بيانات غير صحيحة',
    errors: fieldErrors,
  });
}

/** خطأ الموردين ⇒ ردّه برمزه وحالته؛ وغيره إلى errorHandler العام */
export function supplierFail(err: unknown, res: Response, next: NextFunction): void {
  if (isSupplierError(err)) { res.status(err.status).json(supplierErrorBody(err)); return; }
  next(err);
}

/** معامل استعلام نصّي واحد: qs قد يجعله مصفوفة أو كائناً — غير النصّ يُهمل */
export function queryText(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t ? t : undefined;
}

/** الصفحة والحدّ: الصفحة ≥ ١ والحدّ ١..٢٠٠ (الافتراضي ٥٠) — غير الرقمي يعود للافتراضي لا خطأ */
export function pageOf(q: Record<string, unknown>): { page: number; limit: number; skip: number } {
  const p = Number.parseInt(String(queryText(q.page) ?? ''), 10);
  const l = Number.parseInt(String(queryText(q.limit) ?? ''), 10);
  const page = Number.isFinite(p) && p >= 1 ? p : 1;
  const limit = Number.isFinite(l) && l >= 1 ? Math.min(l, 200) : 50;
  return { page, limit, skip: (page - 1) * limit };
}

/** تاريخ يومٍ اختياري من الاستعلام: غائب ⇒ null، وصالح ⇒ يوم UTC، وغير صالح ⇒ undefined (المسار يردّ 400) */
export function queryDay(v: unknown): Date | null | undefined {
  const s = queryText(v);
  if (!s) return null;
  return parseDay(s) ?? undefined;
}

/**
 * يوم الشركة الآن بأسبقية المنطقة نفسها في المشروع (منطقة الدفاتر ثم دولة الشركة ثم الرياض) — «اليوم» لأيام التأخّر وأعمار الذمم.
 * يوم UTC لا يكفي: بعد منتصف الليل بتوقيت الرياض يبقى UTC في الأمس فتتأخّر الفاتورة يوماً عن حقيقتها.
 */
export async function companyToday(tid: string): Promise<Date> {
  const [gl, company] = await Promise.all([
    prisma.glSettings.findUnique({ where: { tenantId: tid }, select: { timezone: true } }),
    prisma.companySettings.findUnique({ where: { tenantId: tid }, select: { countryCode: true } }),
  ]);
  return parseDay(localDateIn(new Date(), companyTimeZone(gl?.timezone, company?.countryCode))) ?? utcDay(new Date());
}

/**
 * نصٌّ اختياري: يُقصّ والفارغ null، وundefined = لم يُرسَل (لا تغيير في التعديل) — فلا يُحفظ «  » ولا يُمسح حقلٌ لم يُذكر.
 */
export const optionalText = (max: number) => z.union([z.string(), z.null()]).optional()
  .transform((v) => (v == null ? v : v.trim() || null))
  .refine((v) => v == null || v.length <= max, { message: `الحد الأقصى ${max} حرفاً` });

// ═══ المخطّطات ═══

const name = z.string({ required_error: 'اسم المورّد مطلوب', invalid_type_error: 'اسم المورّد نصّ' })
  .transform((s) => s.trim())
  .refine((s) => s.length > 0, { message: 'اسم المورّد مطلوب' })
  .refine((s) => s.length <= 120, { message: 'الحد الأقصى 120 حرفاً' });

/** الرقم الضريبي بلا مسافات (يُقارَن بها التكرار) — حروف وأرقام وشرطات فقط (أرقام دولٍ أخرى تحمل بادئة حروف) */
const vatNumber = optionalText(30)
  .transform((v) => (v == null ? v : v.replace(/\s+/g, '').toUpperCase()))
  .refine((v) => v == null || /^[A-Z0-9-]+$/.test(v), { message: 'الرقم الضريبي حروف لاتينية وأرقام فقط' });

/** الآيبان بلا مسافات ولا شرطات وبحروف كبيرة: رمز دولة ورقما تحقّق ثم ١٠..٣٠ حرفاً ورقماً (أقصره ١٥ وأطوله ٣٤) */
const iban = optionalText(42)
  .transform((v) => (v == null ? v : v.replace(/[\s-]+/g, '').toUpperCase()))
  .refine((v) => v == null || /^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(v), { message: 'رقم الآيبان غير صالح' });

const email = optionalText(120)
  .refine((v) => v == null || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), { message: 'البريد الإلكتروني غير صالح' });

/** رمز دولة المورّد ISO alpha-2 (إضافةٌ اختيارية على العقد — الغائب في الإنشاء يأخذ دولة الشركة) */
const countryCode = z.string().trim().regex(/^[A-Za-z]{2}$/, 'رمز الدولة حرفان (ISO)').transform((s) => s.toUpperCase()).optional();

/** مدة السداد بالأيام ٠..٣٦٥ (null = بلا مدة ⇒ الآجل مستحقّ يوم فاتورته) — نصّ رقمي يُقبل، والفارغ null */
const paymentDays = z.preprocess(
  (v) => (v === '' ? null : typeof v === 'string' && /^\s*\d+\s*$/.test(v) ? Number(v) : v),
  z.union([z.number().int('مدة السداد أيام صحيحة').min(0, 'مدة السداد من 0 إلى 365').max(365, 'مدة السداد من 0 إلى 365'), z.null()]).optional(),
);

const supplierFields = {
  nameEn: optionalText(120),
  code: optionalText(40),
  vatNumber,
  crNumber: optionalText(40),
  phone: optionalText(30),
  email,
  address: optionalText(300),
  city: optionalText(80),
  countryCode,
  iban,
  bankName: optionalText(120),
  paymentDays,
  notes: optionalText(1000),
};

const createSchema = z.object({ name, ...supplierFields });
const updateSchema = z.object({ name: name.optional(), ...supplierFields, isActive: z.boolean({ invalid_type_error: 'isActive قيمة منطقية' }).optional() });

// ═══ القراءة والتحويل ═══

/** أعمدة المورّد في الردّ — شكل SupplierVendorRow نفسه (services/suppliers/statement.ts) */
const VENDOR_SELECT = {
  id: true, name: true, nameEn: true, code: true, vatNumber: true, crNumber: true, phone: true, email: true, address: true,
  city: true, countryCode: true, iban: true, bankName: true, paymentDays: true, isActive: true, notes: true, createdAt: true,
} as const;

const NO_BALANCE: SupplierBalanceInfo = Object.freeze({ balanceMilli: 0n, openBillsCount: 0, openBillsMilli: 0n });

/** المورّد بشكل العقد: balance موجب = مستحقّ للمورّد، وسالبٌ = دفعة مقدّمة له؛ openBillsCount فواتيره الآجلة المفتوحة */
export function supplierJson(v: SupplierVendorRow, b: SupplierBalanceInfo = NO_BALANCE) {
  return {
    id: v.id,
    name: v.name,
    nameEn: v.nameEn,
    code: v.code,
    vatNumber: v.vatNumber,
    crNumber: v.crNumber,
    phone: v.phone,
    email: v.email,
    address: v.address,
    city: v.city,
    countryCode: v.countryCode,
    iban: v.iban,
    bankName: v.bankName,
    paymentDays: v.paymentDays,
    isActive: v.isActive,
    notes: v.notes,
    createdAt: v.createdAt.toISOString(),
    balance: milliToNumber(b.balanceMilli),
    openBillsCount: b.openBillsCount,
  };
}

// ═══ وصف سطر الكشف ═══

const METHOD_LABEL: Readonly<Record<string, string>> = Object.freeze({
  CASH: 'نقداً من الصندوق',
  BANK_TRANSFER: 'تحويل بنكي',
  CHEQUE: 'شيك',
  REP_CUSTODY: 'من عهدة مندوب',
});

export interface StatementDescribeContext {
  /** السندات المذكورة في الكشف: طريقتها ورقمها وهل هي آلية لشراءٍ نقدي */
  payments: ReadonlyMap<string, { method: string; number: number; autoForEntryId: string | null }>;
  /** الحركات المذكورة في الكشف: رقم فاتورة المورّد ونوع الشراء */
  entries: ReadonlyMap<string, { supplierRef: string | null; paymentMode: string | null }>;
}

/**
 * وصفٌ عربي واضح لكل نوع قيد — يقرؤه المحاسب بلا معرفة بالرموز: «فاتورة مورّد INV-7 — شراء نقدي»، «سند صرف SP-000012 — تحويل
 * بنكي»، «مرتجع للمورّد …»، «إلغاء سند صرف …». الملاحظة (ومنها سبب الإلغاء) تُلحق بعد شرطة. نوعٌ مجهول يُعرض برمزه لا يُخفى.
 */
export function describeStatementLine(row: Pick<SupplierLedgerRow, 'kind' | 'ref' | 'note' | 'warehouseEntryId' | 'supplierPaymentId'>, ctx: StatementDescribeContext): string {
  const entry = row.warehouseEntryId ? ctx.entries.get(row.warehouseEntryId) : undefined;
  const pay = row.supplierPaymentId ? ctx.payments.get(row.supplierPaymentId) : undefined;
  const billRef = row.ref ?? entry?.supplierRef ?? null;
  const payRef = row.ref ?? (pay ? supplierPaymentDisplayNumber(pay.number) : null);
  const withRef = (label: string, ref: string | null) => (ref ? `${label} ${ref}` : label);
  let base: string;
  switch (row.kind) {
    case 'BILL':
      base = withRef('فاتورة مورّد', billRef) + (entry?.paymentMode === 'CASH' ? ' — شراء نقدي' : '');
      break;
    case 'BILL_REV':
      base = withRef('إلغاء فاتورة مورّد', billRef);
      break;
    case 'PAYMENT': {
      const method = pay ? METHOD_LABEL[pay.method] : undefined;
      base = withRef('سند صرف', payRef) + (method ? ` — ${method}` : '') + (pay?.autoForEntryId ? ' (آلي لشراء نقدي)' : '');
      break;
    }
    case 'PAYMENT_REV':
      base = withRef('إلغاء سند صرف', payRef);
      break;
    case 'RETURN':
      base = withRef('مرتجع للمورّد', billRef);
      break;
    case 'REFUND_IN':
      base = withRef('استرداد نقدي من المورّد', billRef);
      break;
    case 'OPENING':
      base = 'رصيد افتتاحي';
      break;
    default:
      base = withRef(row.kind, row.ref);
  }
  const note = row.note?.trim();
  return note ? `${base} — ${note}` : base;
}

/** سياق الأوصاف باستعلامين ثابتين مهما طال الكشف (السندات والحركات المذكورة فيه) — كلاهما بـtenantId */
async function describeContextOf(tid: string, rows: readonly SupplierLedgerRow[]): Promise<StatementDescribeContext> {
  const payIds = [...new Set(rows.map((r) => r.supplierPaymentId).filter((x): x is string => !!x))];
  const entryIds = [...new Set(rows.map((r) => r.warehouseEntryId).filter((x): x is string => !!x))];
  const [pays, entries] = await Promise.all([
    payIds.length
      ? prisma.supplierPayment.findMany({ where: { tenantId: tid, id: { in: payIds } }, select: { id: true, method: true, number: true, autoForEntryId: true } })
      : Promise.resolve([]),
    entryIds.length
      ? prisma.warehouseEntry.findMany({ where: { tenantId: tid, id: { in: entryIds } }, select: { id: true, supplierRef: true, paymentMode: true } })
      : Promise.resolve([]),
  ]);
  return {
    payments: new Map(pays.map((p) => [p.id, { method: p.method, number: p.number, autoForEntryId: p.autoForEntryId }])),
    entries: new Map(entries.map((e) => [e.id, { supplierRef: e.supplierRef, paymentMode: e.paymentMode }])),
  };
}

// ═══ التفرّد ═══

export const SUPPLIER_MASTER_LOCK_PREFIX = 'supplier-master:';

/** قفل سجلّ موردي الشركة (قفل معاملة) — أول كل كتابة: يجعل «افحص التفرّد ثم اكتب» بلا سباق */
async function lockSupplierMaster(tx: Prisma.TransactionClient, tid: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${SUPPLIER_MASTER_LOCK_PREFIX + tid}::text))`;
}

/**
 * الرمز والرقم الضريبي فريدان في الشركة (والمؤرشف يحجزهما: قد يُستعاد). الرمز بلا حساسية لحالة الأحرف. selfId يستثني المورّد
 * نفسه في التعديل. يُستدعى تحت قفل السجلّ.
 */
async function assertUniqueKeys(
  tx: Prisma.TransactionClient,
  tid: string,
  keys: { code?: string | null; vatNumber?: string | null },
  selfId?: string,
): Promise<void> {
  const notSelf = selfId ? { id: { not: selfId } } : {};
  if (keys.code) {
    const dup = await tx.glVendor.findFirst({
      where: { tenantId: tid, code: { equals: keys.code, mode: 'insensitive' }, ...notSelf },
      select: { id: true, name: true },
    });
    if (dup) throw new SupplierError('SUPPLIER_CODE_EXISTS', `رمز المورّد «${keys.code}» مستعمل للمورّد «${dup.name}»`, 409, { supplierId: dup.id });
  }
  if (keys.vatNumber) {
    const dup = await tx.glVendor.findFirst({
      where: { tenantId: tid, vatNumber: { equals: keys.vatNumber, mode: 'insensitive' }, ...notSelf },
      select: { id: true, name: true },
    });
    if (dup) throw new SupplierError('SUPPLIER_VAT_EXISTS', `الرقم الضريبي ${keys.vatNumber} مسجّل للمورّد «${dup.name}»`, 409, { supplierId: dup.id });
  }
}

/** تغيّرت القيمة فعلاً (بلا حساسية لحالة الأحرف)؟ — التكرار القديم بين موردين (من M2) لا يمنع تعديل غيره من الحقول */
const changedKey = (next: string | null | undefined, cur: string | null): string | null =>
  next && next.toLowerCase() !== (cur ?? '').toLowerCase() ? next : null;

const notFound = () => new SupplierError('SUPPLIER_NOT_FOUND', 'المورّد غير موجود', 404);

// ═══ المسارات ═══

const router = Router();
useSupplierGuards(router);

// قائمة الموردين: البحث بالاسم والرمز والرقم الضريبي والجوال بلا حساسية للأحرف، والحالة active (الافتراضي) | archived | all.
// الرصيد وعدد الفواتير المفتوحة للصفحة كلها بتجميعٍ واحد (groupBy) وتسويةٍ واحدة — لا استعلام لكل مورّد
router.get('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const status = queryText(req.query.status)?.toLowerCase() ?? 'active';
    if (!['active', 'archived', 'all'].includes(status)) {
      res.status(400).json({ success: false, code: 'SUPPLIER_INVALID', message: 'الحالة active أو archived أو all' });
      return;
    }
    const search = queryText(req.query.search)?.slice(0, 100);
    const { page, limit, skip } = pageOf(req.query);
    const where: Prisma.GlVendorWhereInput = {
      tenantId: tid,
      ...(status === 'active' && { isActive: true }),
      ...(status === 'archived' && { isActive: false }),
      ...(search && {
        OR: [
          { name: { contains: search, mode: 'insensitive' } },
          { nameEn: { contains: search, mode: 'insensitive' } },
          { code: { contains: search, mode: 'insensitive' } },
          { vatNumber: { contains: search.replace(/\s+/g, ''), mode: 'insensitive' } },
          { phone: { contains: search, mode: 'insensitive' } },
        ],
      }),
    };
    const [total, rows] = await Promise.all([
      prisma.glVendor.count({ where }),
      prisma.glVendor.findMany({ where, orderBy: [{ name: 'asc' }, { id: 'asc' }], skip, take: limit, select: VENDOR_SELECT }),
    ]);
    const balances = await loadSupplierBalances(prisma, tid, rows.map((r) => r.id));
    res.json({ success: true, data: { items: rows.map((r) => supplierJson(r, balances.get(r.id))), total, page, limit } });
  } catch (err) { next(err); }
});

// أعمار الذمم الدائنة حتى asOf (الافتراضي يوم الشركة): شرائح agingBucketOf على استحقاق الفواتير المفتوحة يومها — قبل /:id
router.get('/aging', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const asOf = queryDay(req.query.asOf);
    if (asOf === undefined) {
      res.status(400).json({ success: false, code: 'SUPPLIER_INVALID', message: 'تاريخ asOf غير صالح (YYYY-MM-DD)' });
      return;
    }
    const aging = await loadAging(prisma, tid, asOf ?? (await companyToday(tid)));
    res.json({ success: true, data: agingJson(aging) });
  } catch (err) { next(err); }
});

// بطاقة المورّد برصيده وعدد فواتيره المفتوحة — مورّد شركةٍ أخرى 404 كغير الموجود
router.get('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const id = String(req.params.id);
    const v = await prisma.glVendor.findFirst({ where: { id, tenantId: tid }, select: VENDOR_SELECT });
    if (!v) throw notFound();
    const balances = await loadSupplierBalances(prisma, tid, [id]);
    res.json({ success: true, data: supplierJson(v, balances.get(id)) });
  } catch (err) { supplierFail(err, res, next); }
});

// إنشاء مورّد: الاسم وحده مطلوب، والرمز والرقم الضريبي فريدان في الشركة (409)، ودولته دولة الشركة ما لم تُرسَل
router.post('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const parsed = createSchema.safeParse(req.body ?? {});
    if (!parsed.success) { zodFail(res, parsed.error, 'SUPPLIER_INVALID'); return; }
    const d = parsed.data;
    const country = d.countryCode
      ?? (await prisma.companySettings.findUnique({ where: { tenantId: tid }, select: { countryCode: true } }))?.countryCode
      ?? 'SA';
    const row = await prisma.$transaction(async (tx) => {
      await lockSupplierMaster(tx, tid);
      await assertUniqueKeys(tx, tid, { code: d.code, vatNumber: d.vatNumber });
      return tx.glVendor.create({
        data: {
          tenantId: tid,
          name: d.name,
          nameEn: d.nameEn ?? null,
          code: d.code ?? null,
          vatNumber: d.vatNumber ?? null,
          crNumber: d.crNumber ?? null,
          phone: d.phone ?? null,
          email: d.email ?? null,
          address: d.address ?? null,
          city: d.city ?? null,
          countryCode: country,
          iban: d.iban ?? null,
          bankName: d.bankName ?? null,
          paymentDays: d.paymentDays ?? null,
          notes: d.notes ?? null,
        },
        select: VENDOR_SELECT,
      });
    }, SUPPLIER_TX);
    res.status(201).json({ success: true, data: supplierJson(row) });
  } catch (err) { supplierFail(err, res, next); }
});

// تعديل المورّد: الحقول المرسَلة وحدها (null أو "" يمسح الاختياري)، وisActive للأرشفة والاستعادة. تغيير مدة السداد لا يمسّ
// استحقاق فواتير سابقة (مخزَّن على كل فاتورة)
router.put('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const id = String(req.params.id);
    const parsed = updateSchema.safeParse(req.body ?? {});
    if (!parsed.success) { zodFail(res, parsed.error, 'SUPPLIER_INVALID'); return; }
    const d = parsed.data;
    const data: Prisma.GlVendorUpdateManyMutationInput = {};
    for (const [k, v] of Object.entries(d)) if (v !== undefined) (data as Record<string, unknown>)[k] = v;
    const row = await prisma.$transaction(async (tx) => {
      await lockSupplierMaster(tx, tid);
      const cur = await tx.glVendor.findFirst({ where: { id, tenantId: tid }, select: { id: true, code: true, vatNumber: true } });
      if (!cur) throw notFound();
      await assertUniqueKeys(tx, tid, { code: changedKey(d.code, cur.code), vatNumber: changedKey(d.vatNumber, cur.vatNumber) }, id);
      if (Object.keys(data).length) await tx.glVendor.updateMany({ where: { id, tenantId: tid }, data });
      return tx.glVendor.findFirst({ where: { id, tenantId: tid }, select: VENDOR_SELECT });
    }, SUPPLIER_TX);
    if (!row) throw notFound();
    const balances = await loadSupplierBalances(prisma, tid, [id]);
    res.json({ success: true, data: supplierJson(row, balances.get(id)) });
  } catch (err) { supplierFail(err, res, next); }
});

// حذف حقيقي لمورّدٍ بلا أثر: لا حركة مستودع ولا قيد كشف ولا سند ولا سطر قيد في الدفاتر يحمله — وإلا 409 SUPPLIER_HAS_HISTORY
// (الأرشفة بدلاً منه). صفّ المورّد يُقفل FOR UPDATE قبل الفحص: كل إدراجٍ يشير إليه بمفتاحه الأجنبي (حركة/قيد/سند) يأخذ
// FOR KEY SHARE فينتظر قرارنا، وما التزم قبله يراه الفحص. وقيود الدفاتر (gl_moves/gl_move_lines) بلا مفتاح أجنبي فتُفحص صراحةً.
router.delete('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const id = String(req.params.id);
    await prisma.$transaction(async (tx) => {
      await lockSupplierMaster(tx, tid);
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM gl_vendors WHERE id = ${id} AND "tenantId" = ${tid} FOR UPDATE`;
      if (!locked.length) throw notFound();
      // متتابعةٌ لا Promise.all: معاملة Prisma التفاعلية اتصالٌ واحد، وكلٌّ منها «أول صفّ» بفهرس (tenantId, vendorId…)
      const where = { tenantId: tid, vendorId: id };
      const entry = await tx.warehouseEntry.findFirst({ where, select: { id: true } });
      const ledger = await tx.supplierLedgerEntry.findFirst({ where, select: { id: true } });
      const payment = await tx.supplierPayment.findFirst({ where, select: { id: true } });
      const move = await tx.glMove.findFirst({ where, select: { id: true } });
      const moveLine = await tx.glMoveLine.findFirst({ where, select: { id: true } });
      if (entry || ledger || payment || move || moveLine) {
        throw new SupplierError('SUPPLIER_HAS_HISTORY', 'للمورّد حركات أو قيود أو دفعات فلا يُحذف — أرشِفه بدلاً من الحذف', 409, {
          warehouseEntries: !!entry, ledgerEntries: !!ledger, payments: !!payment, journalEntries: !!(move || moveLine),
        });
      }
      await tx.glVendor.deleteMany({ where: { id, tenantId: tid } });
    }, SUPPLIER_TX);
    res.json({ success: true, data: { id, deleted: true } });
  } catch (err) {
    // شبكة أمان: مرجعٌ بمفتاحٍ أجنبي سبق الفحص بطريقٍ ما ⇒ القاعدة ترفض الحذف (P2003) — الردّ نفسه لا 500
    if ((err as { code?: unknown })?.code === 'P2003') {
      res.status(409).json({ success: false, code: 'SUPPLIER_HAS_HISTORY', message: 'للمورّد حركات أو قيود أو دفعات فلا يُحذف — أرشِفه بدلاً من الحذف' });
      return;
    }
    supplierFail(err, res, next);
  }
});

// كشف حساب المورّد لفترة [from, to] (كلاهما اختياري): الافتتاحي والسطور بالرصيد الجاري ووصفٍ عربي لكل سطر وعدد مرفقات حركته
router.get('/:id/statement', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const id = String(req.params.id);
    const from = queryDay(req.query.from);
    const to = queryDay(req.query.to);
    if (from === undefined || to === undefined) {
      res.status(400).json({ success: false, code: 'SUPPLIER_INVALID', message: 'التاريخ غير صالح (YYYY-MM-DD)' });
      return;
    }
    if (from && to && from.getTime() > to.getTime()) {
      res.status(400).json({ success: false, code: 'SUPPLIER_INVALID', message: 'بداية الفترة بعد نهايتها' });
      return;
    }
    const data = await loadSupplierStatement(prisma, tid, id, from, to);
    if (!data) throw notFound();
    const [balances, company, ctx] = await Promise.all([
      loadSupplierBalances(prisma, tid, [id]),
      prisma.companySettings.findUnique({ where: { tenantId: tid }, select: { currency: true } }),
      describeContextOf(tid, data.lines.map((l) => l.row)),
    ]);
    const body = statementJson(data);
    res.json({
      success: true,
      data: {
        supplier: supplierJson(data.vendor, balances.get(id)),
        currency: company?.currency ?? 'SAR',
        ...body,
        lines: body.lines.map((l, i) => ({ ...l, description: describeStatementLine(data.lines[i].row, ctx) })),
      },
    });
  } catch (err) { supplierFail(err, res, next); }
});

// فواتير المورّد الآجلة غير الملغاة ذات المتبقّي — الأقدم استحقاقاً أولاً، وأيام التأخّر حتى يوم الشركة (شاشة سند الصرف)
router.get('/:id/open-bills', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const id = String(req.params.id);
    const v = await prisma.glVendor.findFirst({ where: { id, tenantId: tid }, select: { id: true } });
    if (!v) throw notFound();
    const rows = await loadOpenBills(prisma, tid, id, await companyToday(tid));
    res.json({ success: true, data: rows.map(openBillJson) });
  } catch (err) { supplierFail(err, res, next); }
});

export default router;
