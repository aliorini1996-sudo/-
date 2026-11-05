import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import prisma from '../config/database';
import { authenticate, requireAccounting, requireAdmin, requireAdminPermission, tenantId } from '../middleware/auth';
import { AuthRequest } from '../types';
import { customerScope } from '../services/customerScope';
import {
  PRICE_LIST_IN_USE_BY, PRICE_LIST_MESSAGES, PRICE_LIST_NAME_MAX, listBasePriceOf, priceListName, type PriceListCode,
} from '../services/priceLists';
import { PRICE_RULE_LIMITS, priceRuleProblem } from '../services/priceRules';
import { BASE_GUARD_TX, ProductUnitsChangedError, baseGuardReply, lockBases, type ExpectedBases } from '../services/baseGuard';
import { QTY_EPS, primaryPriceOf, primaryUnitOf, type UnitDef } from '../services/units';
import { companyZoneOf } from '../services/invoiceExpiry';
import { roundHalfUp } from '../lib/money';
import { paginationMeta } from '../utils/helpers';

/**
 * «قوائم الأسعار» (طلب المالك، ١ نوفمبر ٢٠٢٦؛ «أنواع الأسعار» حتى ٥ نوفمبر) — /api/price-lists: أسعارٌ مسمّاة تحدّدها الشركة
 * («سعر الجملة»، «سعر التجزئة»…)، لكل عميل قائمته فتُسعَّر فواتيره بها، ولا يبدّلها المندوب على فاتورةٍ إلا بصلاحية «تبديل قائمة
 * الأسعار». القواعد الصرفة في services/priceLists.ts، وحلّ قواعد القائمة في services/priceRules.ts.
 *
 * - **القراءة** لكل مستخدم شركة ومندوب (الأسماء ليست سرّاً): نموذج العميل والفاتورة وتطبيق المندوب تحتاجها.
 * - **الكتابة** (القوائم واسم زرّ الأساس وأسعار القائمة وقواعدها) لمدير الأصناف: requireAdmin + صلاحية الأصناف، كبقيّة كتابات الأسعار.
 * - **أسعار القوائم وقواعدها** (/prices و/rules وجدول القائمة) أسعار أصناف: بحارس صلاحية الأصناف، والمندوب بلا «تبديل قائمة
 *   الأسعار» لا يرى إلا قوائم عملائه وقائمته الافتراضية (لا قائمة جملةٍ كاملة في كاش جواله).
 * - **القائمة التي عليها عملاء لا تُحذف** (409 PRICE_LIST_IN_USE): الحذف يفرّغ قائمتهم (SetNull) فيسقط سعرهم إلى الأساس بصمت.
 *   ولا التي هي افتراضيّة مندوبٍ أو ضمن قوائمه المسموحة (طلب المالك ٢ نوفمبر ٢٠٢٦، repsCount في الردّ).
 *   وأسعارها وقواعدها تُحذف معها (Cascade)، والفواتير المختومة بها يُفرَّغ ختمها.
 *
 * ═══ قواعد القائمة وجدول أسعارها (طلب المالك ٥ نوفمبر ٢٠٢٦ — على نسق Odoo) ═══
 * - **سعر الصنف الثابت** (PriceListItem) يُدخل بالوحدة الرئيسية صافياً ويُخزَّن لوحدة الأساس بستّ منازل (listBasePriceOf) تحت حارس
 *   الأساس: الأساس الذي رآه المحرّر (expectedBaseName) يُقارن تحت قفل الصنف FOR KEY SHARE (lockBases)، والرئيسية كما رآها
 *   (expectedPrimary) تحت القفل نفسه — تحويلٌ أو رئيسيةٌ تغيّرت بينهما ⇒ 409 لا سعر كرتونٍ يُقرأ سعرَ حبّة.
 * - **القاعدة** (PriceListRule) على صنف أو فئة أو كل الأصناف: السعر الثابت لصنفٍ لوحدة الأساس بالحارس نفسه (basePrice)، ولفئةٍ
 *   للوحدة الرئيسية لكل صنفٍ فيها بأربع منازل (primaryPrice، لا يمسّه التحويل)، والنسبة موجبةً خصمٌ وسالبةً زيادة. التحقق
 *   priceRuleProblem نفسه في الواجهة، والحدّ PRICE_RULE_LIMITS.perList قاعدةً للقائمة.
 * - كل كتابةٍ تمسّ أسعار صنفٍ بعينه تحرّك طابع تعديله (كـtouchProduct في routes/products.ts) فتراها مزامنة ERP و/api/v1/sync.
 *   والأصناف تُقفل FOR KEY SHARE بترتيب المعرّف قبل أي كتابة ثم تُلمس بالترتيب نفسه: لا انتظارٌ متقاطع مع التحويل ولا بين كاتبين.
 * - شركةٌ بلا قوائم: لا استعلام زائد في القراءة (GET / بلا groupBy، و/prices و/rules باستعلامٍ واحد).
 */
const router = Router();
router.use(authenticate);
router.use(requireAccounting); // عزل «النظام المحاسبي» كالأصناف

/** كتابة القوائم: مستخدم شركة بصلاحية الأصناف (جلسة المالك تمرّ) */
const manage = [requireAdmin, requireAdminPermission('canManageProducts')];
/** قراءة أسعار القوائم وقواعدها: حارس الأصناف (المندوب يمرّ ويقيّده نطاقه — repVisibleListIds) */
const readPrices = requireAdminPermission('canManageProducts');

const refuse = (res: Response, status: number, code: PriceListCode, extra: Record<string, unknown> = {}) => {
  res.status(status).json({ success: false, code, message: PRICE_LIST_MESSAGES[code], ...extra });
};
const isUniqueClash = (e: unknown) => (e as { code?: string })?.code === 'P2002';

/** رفضٌ يُرمى من داخل المعاملة (فتُلغى كتاباتها) ويُردّ برمزه ورسالته */
class ListRefusal extends Error {
  constructor(readonly status: number, readonly code: PriceListCode, message?: string) {
    super(message ?? PRICE_LIST_MESSAGES[code]);
  }
}

/** مفتاحٌ أجنبيّ فشل في كتابة سعرٍ أو قاعدة (قائمةٌ أو صنفٌ أو فئةٌ حُذفت بين الفحص والكتابة) ⇒ رفضه لا عطل 500 */
function fkRefusalOf(err: unknown): ListRefusal | null {
  const e = err as { code?: unknown; meta?: { field_name?: unknown } } | null;
  if (e?.code !== 'P2003') return null;
  const field = String(e.meta?.field_name ?? '');
  if (field.includes('categoryId')) return new ListRefusal(400, 'CATEGORY_NOT_FOUND');
  if (field.includes('productId')) return new ListRefusal(400, 'PRODUCT_NOT_FOUND');
  if (field.includes('priceListId')) return new ListRefusal(404, 'PRICE_LIST_INVALID');
  return null;
}

/**
 * أخطاء كتّاب الأسعار والقواعد: الرفض برمزه، وأساسٌ تغيّر تحت القفل ⇒ 409 BASE_UNIT_CHANGED، وانتظار قفلٍ طويل خلف تحويلٍ
 * (55P03/40P01/P2028) ⇒ 503 PRODUCT_UNITS_BUSY، ومفتاحٌ أجنبيّ فشل ⇒ رفضه. وإلا false (يمرّ للمعالج العام)
 */
function replyWriteError(res: Response, err: unknown): boolean {
  const refusal = err instanceof ListRefusal ? err : fkRefusalOf(err);
  if (refusal) { res.status(refusal.status).json({ success: false, code: refusal.code, message: refusal.message }); return true; }
  if (err instanceof ProductUnitsChangedError) { refuse(res, 409, 'BASE_UNIT_CHANGED'); return true; }
  const guard = baseGuardReply(err, false);
  if (guard) { res.status(guard.status).json(guard.body); return true; }
  return false;
}

// الاسم يُقصّ ويُفحص طوله في priceListName — المخطّط يقبل نصاً معقولاً فقط فلا تصل رسالة zod الإنجليزية
const nameSchema = z.string().max(PRICE_LIST_NAME_MAX * 4);
const LIST_SELECT = { id: true, name: true, sortOrder: true } as const;
const LIST_ORDER = [{ sortOrder: 'asc' as const }, { name: 'asc' as const }];
/** العملاء الأحياء — المحذوف (status DELETED) صفٌّ باقٍ لأسماء فواتيره لا يُحسب «مستخدماً» ولا يمنع الحذف */
const LIVE_CUSTOMER = { status: { not: 'DELETED' } } as const;
/**
 * مناديب على القائمة: افتراضيّتهم، أو ضمن قوائمهم المسموحة (مصفوفة JSON تحويها — `@>` في PostgreSQL). والمندوب المعطَّل يُحسب:
 * إعداده باقٍ ويعود بتفعيله. والمحذوف لا صفّ له
 */
const repsOnList = (id: string) => ({ OR: [{ defaultPriceListId: id }, { allowedPriceTypes: { array_contains: [id] } }] });

/** عدد العملاء الأحياء على كل قائمة — groupBy واحد للشركة */
async function customersCountOf(tid: string): Promise<Map<string, number>> {
  const rows = await prisma.customer.groupBy({
    by: ['priceListId'], where: { tenantId: tid, priceListId: { not: null }, ...LIVE_CUSTOMER }, _count: { _all: true },
  });
  return new Map((rows ?? []).filter((r) => r.priceListId).map((r) => [r.priceListId as string, r._count._all]));
}
/** عدد الأصناف المسعّرة في كل قائمة — groupBy واحد للشركة (المؤرشف تُحذف أسعاره معه فلا يُعدّ) */
async function itemsCountOf(tid: string): Promise<Map<string, number>> {
  const rows = await prisma.priceListItem.groupBy({ by: ['priceListId'], where: { tenantId: tid }, _count: { _all: true } });
  return new Map((rows ?? []).map((r) => [r.priceListId, r._count._all]));
}
/** عدد القواعد في كل قائمة — groupBy واحد للشركة */
async function rulesCountOf(tid: string): Promise<Map<string, number>> {
  const rows = await prisma.priceListRule.groupBy({ by: ['priceListId'], where: { tenantId: tid }, _count: { _all: true } });
  return new Map((rows ?? []).map((r) => [r.priceListId, r._count._all]));
}

/**
 * القوائم التي يرى المندوب أسعارها وقواعدها (/prices و/rules وجدول القائمة): بلا «تبديل قائمة الأسعار» قوائم عملائه وحدها
 * (بنطاق عزل العملاء) — لا يسعّر إلا بقائمة العميل أصلاً — وقائمته الافتراضية لعميلٍ بلا قائمة (طلب المالك ٢ نوفمبر ٢٠٢٦) تكون في
 * كاش جواله دون اتصال. لا قوائمه المسموحة: لا يبدّل إليها بلا الصلاحية (403 PRICE_LIST_FORBIDDEN)، فلا قائمة جملةٍ كاملة في كاشه
 * لا يسعّر بها. وبالصلاحية كلها. null = بلا قيد (مستخدم الشركة، أو المندوب بالصلاحية)
 */
async function repVisibleListIds(req: AuthRequest, tid: string): Promise<Set<string> | null> {
  if (req.user?.role !== 'SALES_REP') return null;
  const rep = await prisma.salesRep.findFirst({
    where: { id: req.user.id, tenantId: tid }, select: { canChangePriceList: true, defaultPriceListId: true },
  });
  if (rep?.canChangePriceList === true) return null;
  const used = await prisma.customer.findMany({
    where: { tenantId: tid, priceListId: { not: null }, ...LIVE_CUSTOMER, ...(await customerScope(req, tid)) },
    distinct: ['priceListId'], select: { priceListId: true },
  });
  const mine = new Set<string>();
  for (const c of used ?? []) if (c.priceListId) mine.add(c.priceListId);
  if (rep?.defaultPriceListId) mine.add(rep.defaultPriceListId);
  return mine;
}

/** قائمةٌ من الشركة يراها الطالب (المندوب بنطاقه) — وإلا null فيُردّ 404 PRICE_LIST_INVALID كقائمة شركةٍ أخرى */
async function readableList(req: AuthRequest, tid: string, id: string): Promise<{ id: string } | null> {
  const list = await prisma.priceList.findFirst({ where: { id, tenantId: tid }, select: { id: true } });
  if (!list) return null;
  const visible = await repVisibleListIds(req, tid);
  return visible && !visible.has(list.id) ? null : list;
}

// ═══ القاعدة كما تُرسل (PriceRuleDTO) ═══

/** صفّ قاعدةٍ من القاعدة (raw أو Prisma) — و`unit`/`baseConvertedAt` أساس صنفها لقاعدة الصنف */
interface RuleSource {
  id: string; priceListId: string; scope: string; productId: string | null; categoryId: string | null; kind: string;
  basePrice: number | null; primaryPrice: number | null; percent: number | null; minQty: number | null;
  startsOn: string | null; endsOn: string | null; updatedAt: Date | string | null;
  unit?: string | null; baseConvertedAt?: Date | string | null;
}
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/**
 * القاعدة للأجهزة والمحرّر: basePrice لوحدة الأساس (قاعدة صنفٍ ثابتة)، وprimaryPrice للوحدة الرئيسية (قاعدة فئةٍ ثابتة)، وpercent
 * موجبةً خصمٌ وسالبةً زيادة. وقاعدة الصنف تحمل `unit` و`baseConvertedAt` من صنفها كأسعار القائمة في /prices: بهما يعيد تطبيق
 * المندوب أساس السعر المخزَّن في كاشه بعد تحويل (rebaseCustPrices)
 */
function ruleDtoOf(r: RuleSource) {
  const dto = {
    id: r.id, priceListId: r.priceListId, scope: r.scope, productId: r.productId ?? null, categoryId: r.categoryId ?? null, kind: r.kind,
    basePrice: numOrNull(r.basePrice), primaryPrice: numOrNull(r.primaryPrice), percent: numOrNull(r.percent), minQty: Number(r.minQty ?? 0),
    startsOn: r.startsOn ?? null, endsOn: r.endsOn ?? null, updatedAt: r.updatedAt ?? null,
  };
  return r.scope === 'product' ? { ...dto, unit: r.unit ?? null, baseConvertedAt: r.baseConvertedAt ?? null } : dto;
}
type RuleDto = ReturnType<typeof ruleDtoOf>;

/**
 * قواعد قوائمٍ بعينها للأجهزة — جملةٌ واحدة: القاعدة وأساس صنفها في لقطةٍ واحدة (كأسعار القائمة في /prices؛ التحويل يقسم
 * basePrice على F ويغيّر الأساس في معاملةٍ واحدة). قواعد الأصناف المؤرشفة خارجها. بلا قوائم لا استعلام
 */
async function rulesOfLists(tid: string, ids: string[]): Promise<RuleDto[]> {
  if (!ids.length) return [];
  const rows = await prisma.$queryRaw<RuleSource[]>`
    SELECT r.id, r."priceListId", r.scope, r."productId", r."categoryId", r.kind, r."basePrice", r."primaryPrice", r.percent,
      r."minQty", r."startsOn", r."endsOn", r."updatedAt", p.unit, p."baseConvertedAt"
    FROM price_list_rules r LEFT JOIN products p ON p.id = r."productId" AND p."tenantId" = ${tid}
    WHERE r."tenantId" = ${tid} AND r."priceListId" IN (${Prisma.join(ids)})
      AND (r."productId" IS NULL OR (p.id IS NOT NULL AND p."deletedAt" IS NULL))
    ORDER BY r."priceListId", r.id`;
  return (rows ?? []).map(ruleDtoOf);
}

const UNIT_PICK = { id: true, name: true, factor: true, price: true, isActive: true } as const;
/** القاعدة بحقول العرض (اسم الصنف وكوده ورئيسيّته، واسم الفئة) — للمحرّر وردّ الكتابة */
const RULE_SELECT = {
  id: true, priceListId: true, scope: true, productId: true, categoryId: true, kind: true, basePrice: true, primaryPrice: true,
  percent: true, minQty: true, startsOn: true, endsOn: true, updatedAt: true,
  product: { select: { name: true, code: true, unit: true, baseConvertedAt: true, deletedAt: true, primaryUnitId: true, units: { select: UNIT_PICK } } },
  category: { select: { name: true } },
} as const;
type RuleRow = Prisma.PriceListRuleGetPayload<{ select: typeof RULE_SELECT }>;

const unitView = (u: UnitDef | null) => (u ? { id: String(u.id), name: u.name, factor: Number(u.factor) } : null);
function ruleDisplayOf(r: RuleRow) {
  const p = r.product;
  return {
    ...ruleDtoOf({ ...r, unit: p?.unit ?? null, baseConvertedAt: p?.baseConvertedAt ?? null }),
    productName: p?.name ?? null, productCode: p?.code ?? null, categoryName: r.category?.name ?? null,
    primaryUnit: p ? unitView(primaryUnitOf(p)) : null,
  };
}
type RuleDisplay = ReturnType<typeof ruleDisplayOf>;

const SCOPE_ORDER: Record<string, number> = { product: 0, category: 1, all: 2 };
/** ترتيب العرض في المحرّر: صنف ثم فئة ثم الكل، ثم الاسم، ثم الحدّ الأدنى للكمية، ثم بداية الفترة (المفتوحة أولاً) */
function displayOrder(a: RuleDisplay, b: RuleDisplay): number {
  const s = (SCOPE_ORDER[a.scope] ?? 9) - (SCOPE_ORDER[b.scope] ?? 9);
  if (s !== 0) return s;
  const n = String(a.productName ?? a.categoryName ?? '').localeCompare(String(b.productName ?? b.categoryName ?? ''), 'ar');
  if (n !== 0) return n;
  const q = a.minQty - b.minQty;
  if (Math.abs(q) > 1e-9) return q;
  const d = String(a.startsOn ?? '').localeCompare(String(b.startsOn ?? ''));
  if (d !== 0) return d;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// ═══ الكتابة: حارس الأساس والرئيسية ولمس الصنف ═══

const expectedPrimarySchema = z.object({ id: z.string().min(1).max(200), factor: z.number() });
type ExpectedPrimary = z.infer<typeof expectedPrimarySchema>;
/** الرئيسية تحت القفل هي التي رآها المحرّر: { id, factor } أو null (رآه بلا رئيسية) */
function primaryMatches(primary: UnitDef | null, want: ExpectedPrimary | null): boolean {
  return want
    ? !!primary && primary.id === want.id && Math.abs(Number(primary.factor) - want.factor) <= QTY_EPS
    : primary == null;
}
const hasOwn = (o: unknown, k: string) => !!o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
/** أساسٌ مُرسَل فعلاً (لا غائب ولا فارغ بعد القصّ) */
const sentBase = (s: string | null | undefined): s is string => typeof s === 'string' && s.trim() !== '';

/** طابع تعديل الأصناف (كـtouchProduct في routes/products.ts) — بترتيب المعرّف بعد قفلها، فلا ينتظر كاتبان أحدهما الآخر متقاطعَين */
async function touchProducts(tx: Prisma.TransactionClient, tid: string, ids: Iterable<string | null | undefined>): Promise<void> {
  const now = new Date();
  for (const id of [...new Set([...ids].filter((x): x is string => !!x))].sort()) {
    await tx.product.updateMany({ where: { id, tenantId: tid }, data: { updatedAt: now } });
  }
}

/** أسعار جدول القائمة: سعر الوحدة الرئيسية صافياً (أربع منازل) من المخزَّن لوحدة الأساس */
const listPriceView = (perBase: number | null, primaryFactor: number) =>
  (perBase == null ? null : roundHalfUp(Number(perBase) * primaryFactor, 4));

// ═══ القراءة ═══

/**
 * القوائم مرتّبة واسم زرّ الأساس، ولكلٍّ عدد عملائها الأحياء — شركةٌ بلا قوائم: قائمة فارغة بلا groupBy ولا منطقة.
 * - `?counts=1` (لوحة القوائم وحدها — priceListApi.listWithCounts): ومعه عدد أصنافها المسعّرة وقواعدها (itemsCount، rulesCount)،
 *   groupBy لكلٍّ لا يدفعه كل نموذج فاتورةٍ وعميلٍ وتطبيق مندوبٍ يقرأ الأسماء وحدها (CONTRACT2 D5). وبلاه لا مفتاحان كما قبلهما.
 * - `timezone` منطقة الشركة (حساب tenantTz نفسه — companyZoneOf: الدفاتر ثم البلد، المصدر الذي يحسب به حارس الفاتورة يوم الشركة) حين
 *   توجد قوائم: بها تحسب الأجهزة يوم صلاحية القواعد كالخادم لا بساعة الجهاز ومنطقته (D1). والبلد من قراءة إعدادات الشركة نفسها (اسم زرّ
 *   الأساس)، فالمنطقة استعلامٌ واحد (glSettings.timezone) لا اثنان. شركةٌ بلا قوائم لا قواعد لها فلا منطقة ولا استعلامها
 */
router.get('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const withCounts = req.query.counts === '1' || req.query.counts === 'true';
    const [lists, settings] = await Promise.all([
      prisma.priceList.findMany({ where: { tenantId: tid }, orderBy: LIST_ORDER, select: LIST_SELECT }),
      prisma.companySettings.findUnique({ where: { tenantId: tid }, select: { basePriceLabel: true, countryCode: true } }),
    ]);
    const none = new Map<string, number>();
    const [customers, items, rules, gl] = lists.length
      ? await Promise.all([
        customersCountOf(tid), withCounts ? itemsCountOf(tid) : none, withCounts ? rulesCountOf(tid) : none,
        prisma.glSettings.findUnique({ where: { tenantId: tid }, select: { timezone: true } }),
      ])
      : [none, none, none, null];
    const timezone = lists.length ? companyZoneOf(gl?.timezone, settings?.countryCode) : null;
    res.json({
      success: true,
      data: {
        basePriceLabel: settings?.basePriceLabel ?? null,
        lists: lists.map((l) => ({
          ...l, customersCount: customers.get(l.id) ?? 0,
          ...(withCounts && { itemsCount: items.get(l.id) ?? 0, rulesCount: rules.get(l.id) ?? 0 }),
        })),
        ...(timezone && { timezone }),
      },
    });
  } catch (err) { next(err); }
});

/**
 * أسعار القوائم لتطبيق المندوب والفواتير: `[{ id, name, items: [{ productId, price, unit, baseConvertedAt }], rules: PriceRuleDTO[] }]`
 * — السعر صافٍ لوحدة الأساس، و`unit` أساس الصنف لحظة القراءة و`baseConvertedAt` لحظة آخر تحويلٍ له (كـ/products/customer-prices
 * حرفياً): بهما يعرف الجهاز على أي أساسٍ حُسب السعر المخزَّن في كاشه. والسعر وأساس صنفه في جملةٍ واحدة — لقطةٌ واحدة لا يفصلها
 * تحويلٌ يلتزم بين استعلامين (يقسم الأسعار على F ويغيّر الأساس في معاملةٍ واحدة). الأصناف المؤرشفة خارجها. و`rules` قواعد كل
 * قائمة (طلب المالك ٥ نوفمبر ٢٠٢٦) بالشكل نفسه: قاعدة الصنف الثابتة بأساس صنفها، فيحلّها الجهاز بـservices/priceRules.ts كالخادم.
 * وهي أسعار أصناف: مستخدم شركةٍ بلا صلاحية الأصناف (ومفتاحه) لا يقرؤها كما لا يقرأ /products — والمندوب يمرّ بالحارس نفسه
 * (requireAdminPermission) ويقيّده نطاقه (repVisibleListIds). وأسماء القوائم (GET /) تبقى لكل مستخدم: نموذج العميل يحتاجها
 */
router.get('/prices', requireAdminPermission('canManageProducts'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    let lists = await prisma.priceList.findMany({ where: { tenantId: tid }, orderBy: LIST_ORDER, select: { id: true, name: true } });
    if (lists.length) {
      const visible = await repVisibleListIds(req, tid);
      if (visible) lists = lists.filter((l) => visible.has(l.id));
    }
    if (!lists.length) { res.json({ success: true, data: [] }); return; }
    const ids = lists.map((l) => l.id);
    const [rows, rules] = await Promise.all([
      prisma.$queryRaw<Array<{ priceListId: string; productId: string; price: number; unit: string | null; baseConvertedAt: Date | null }>>`
      SELECT i."priceListId", i."productId", i.price, p.unit, p."baseConvertedAt"
      FROM price_list_items i JOIN products p ON p.id = i."productId"
      WHERE i."tenantId" = ${tid} AND p."tenantId" = ${tid} AND p."deletedAt" IS NULL AND i."priceListId" IN (${Prisma.join(ids)})`,
      rulesOfLists(tid, ids),
    ]);
    const byList = new Map<string, Array<{ productId: string; price: number; unit: string | null; baseConvertedAt: Date | null }>>();
    for (const r of rows ?? []) {
      const items = byList.get(r.priceListId) ?? [];
      if (!byList.has(r.priceListId)) byList.set(r.priceListId, items);
      items.push({ productId: r.productId, price: Number(r.price), unit: r.unit ?? null, baseConvertedAt: r.baseConvertedAt ?? null });
    }
    const rulesByList = new Map<string, RuleDto[]>();
    for (const r of rules) {
      const list = rulesByList.get(r.priceListId) ?? [];
      if (!rulesByList.has(r.priceListId)) rulesByList.set(r.priceListId, list);
      list.push(r);
    }
    res.json({ success: true, data: lists.map((l) => ({ id: l.id, name: l.name, items: byList.get(l.id) ?? [], rules: rulesByList.get(l.id) ?? [] })) });
  } catch (err) { next(err); }
});

/**
 * كل قواعد القوائم التي يراها الطالب (PriceRuleDTO[]) — لتسعير فاتورة الإدارة و/m بالحلّ المشترك (services/priceRules.ts).
 * بنطاق /prices نفسه للمندوب. شركةٌ بلا قوائم: استعلامٌ واحد. قبل /:id
 */
router.get('/rules', readPrices, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    let lists = await prisma.priceList.findMany({ where: { tenantId: tid }, orderBy: LIST_ORDER, select: { id: true } });
    if (lists.length) {
      const visible = await repVisibleListIds(req, tid);
      if (visible) lists = lists.filter((l) => visible.has(l.id));
    }
    res.json({ success: true, data: await rulesOfLists(tid, lists.map((l) => l.id)) });
  } catch (err) { next(err); }
});

// اسم زرّ السعر الأساسي (Product.basePrice) — null أو الفارغ يعيده «السعر الأساسي». قبل /:id وإلا التُقط معرّفاً
router.put('/base-label', ...manage, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const { label } = z.object({ label: nameSchema.nullable() }).parse(req.body);
    const stored = label == null || label.trim() === '' ? null : priceListName(label);
    if (label != null && label.trim() !== '' && stored == null) { refuse(res, 400, 'PRICE_LIST_NAME_INVALID'); return; }
    // كتابة واحدة على صفّ الشركة — count 0 = لا صفّ بعد ⇒ 409 بلا إنشاء (نمط companyBuyerRelax)
    const r = await prisma.companySettings.updateMany({ where: { tenantId: tid }, data: { basePriceLabel: stored } });
    if (r.count === 0) { res.status(409).json({ success: false, code: 'COMPANY_SETTINGS_MISSING', message: 'احفظ إعدادات الشركة أولاً' }); return; }
    res.json({ success: true, data: { basePriceLabel: stored } });
  } catch (err) { next(err); }
});

// ═══ القواعد (PriceListRule) ═══

const numIn = z.union([z.number(), z.string().max(40)]).nullish();
/**
 * جسم القاعدة (PriceRuleInput) — مخطّطٌ متسامح في الشكل فيصل السبب العربي من priceRuleProblem (المشترك مع الواجهة) لا رسالة zod.
 * `price` بالوحدة الرئيسية: لصنفٍ يُحوَّل لوحدة الأساس تحت الحارس (expectedBaseName لازم، وexpectedPrimary إن حضر مفتاحه)، ولفئةٍ
 * يُخزَّن للرئيسية كما هو بأربع منازل
 */
const ruleBodySchema = z.object({
  scope: z.string().max(20).nullish(),
  productId: z.string().max(200).nullish(),
  categoryId: z.string().max(200).nullish(),
  kind: z.string().max(20).nullish(),
  price: numIn,
  percent: numIn,
  minQty: numIn,
  startsOn: z.string().max(40).nullish(),
  endsOn: z.string().max(40).nullish(),
  expectedBaseName: z.string().max(200).nullish(),
  expectedPrimary: expectedPrimarySchema.nullish(),
});
type RuleBody = z.infer<typeof ruleBodySchema>;
type ProductPre = { id: string; name: string; unit: string };

const toNum = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));
const dayOrNull = (v: string | null | undefined): string | null => (v == null || v === '' ? null : v);

/** الجسم بعد التحقق ⇒ 400 PRICE_RULE_INVALID بسبب priceRuleProblem، أو الجسم */
function parseRule(raw: unknown): RuleBody {
  const body = ruleBodySchema.parse(raw ?? {});
  const problem = priceRuleProblem(body);
  if (problem) throw new ListRefusal(400, 'PRICE_RULE_INVALID', problem);
  return body;
}

/**
 * هدف القاعدة من الشركة نفسها: صنفٌ غير مؤرشف (400 PRODUCT_NOT_FOUND) أو فئة (400 CATEGORY_NOT_FOUND) — المفتاح الأجنبي لا يعرف
 * الشركة. وسعرٌ ثابت لصنفٍ بلا الأساس الذي رآه المحرّر ⇒ 400 BASE_UNIT_REQUIRED (سعر الكرتون لا يُقرأ سعرَ حبّة بعد تحويل)
 */
async function ruleTargetOf(tid: string, body: RuleBody): Promise<ProductPre | null> {
  if (body.scope === 'category') {
    const cat = await prisma.productCategory.findFirst({ where: { id: String(body.categoryId), tenantId: tid }, select: { id: true } });
    if (!cat) throw new ListRefusal(400, 'CATEGORY_NOT_FOUND');
    return null;
  }
  if (body.scope !== 'product') return null;
  const product = await prisma.product.findFirst({
    where: { id: String(body.productId), tenantId: tid, deletedAt: null }, select: { id: true, name: true, unit: true },
  });
  if (!product) throw new ListRefusal(400, 'PRODUCT_NOT_FOUND');
  if (body.kind === 'fixed' && !sentBase(body.expectedBaseName)) throw new ListRefusal(400, 'BASE_UNIT_REQUIRED');
  return product;
}

/**
 * داخل المعاملة: قفل أصناف القاعدة FOR KEY SHARE (الجديد بالأساس الذي رآه المحرّر لسعرٍ ثابت، والقديم في التعديل بأساسه المقروء)
 * ثم قراءة الجديد تحت القفل: مؤرشفٌ بينهما ⇒ 400، ورئيسيةٌ غير التي رآها المحرّر ⇒ 409 PRIMARY_UNIT_CHANGED. يعيد معامل الرئيسية
 */
async function lockRuleProducts(
  tx: Prisma.TransactionClient, tid: string, body: RuleBody, seenPrimary: boolean, product: ProductPre | null, old: ProductPre | null,
): Promise<number> {
  const expected = new Map<string, { name: string; unit: string }>();
  if (old) expected.set(old.id, { name: old.name, unit: old.unit });
  if (product) expected.set(product.id, { name: product.name, unit: body.kind === 'fixed' ? String(body.expectedBaseName) : product.unit });
  if (!expected.size) return 1;
  await lockBases(tx, tid, expected as ExpectedBases);
  if (!product) return 1;
  const locked = await tx.product.findFirst({
    where: { id: product.id, tenantId: tid }, select: { deletedAt: true, primaryUnitId: true, units: { select: UNIT_PICK } },
  });
  if (!locked || locked.deletedAt) throw new ListRefusal(400, 'PRODUCT_NOT_FOUND');
  const primary = primaryUnitOf(locked);
  if (body.kind === 'fixed' && seenPrimary && !primaryMatches(primary, body.expectedPrimary ?? null)) {
    throw new ListRefusal(409, 'PRIMARY_UNIT_CHANGED');
  }
  return primary ? Number(primary.factor) : 1;
}

/** أعمدة القاعدة من جسمٍ صالح: كل نطاقٍ بحقله وحده، والسعر لصنفٍ لوحدة الأساس (÷ معامل الرئيسية بستّ منازل) ولفئةٍ للرئيسية */
function ruleColumnsOf(body: RuleBody, primaryFactor: number) {
  const scope = body.scope as string;
  const kind = body.kind as string;
  const price = toNum(body.price);
  const fixed = kind === 'fixed' && price != null;
  return {
    scope,
    productId: scope === 'product' ? String(body.productId) : null,
    categoryId: scope === 'category' ? String(body.categoryId) : null,
    kind,
    basePrice: fixed && scope === 'product' ? listBasePriceOf(price, primaryFactor) : null,
    primaryPrice: fixed && scope === 'category' ? roundHalfUp(price, 4) : null,
    percent: kind === 'percent' ? toNum(body.percent) : null,
    minQty: toNum(body.minQty) ?? 0,
    startsOn: dayOrNull(body.startsOn),
    endsOn: dayOrNull(body.endsOn),
  };
}

// تعديل قاعدة (استبدالٌ كامل بجسم PriceRuleInput) — القائمة لا تتغيّر. قبل /:id
router.put('/rules/:ruleId', ...manage, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const body = parseRule(req.body);
    const existing = await prisma.priceListRule.findFirst({
      where: { id: String(req.params.ruleId), tenantId: tid },
      select: { id: true, scope: true, product: { select: { id: true, name: true, unit: true } } },
    });
    if (!existing) { refuse(res, 404, 'PRICE_RULE_NOT_FOUND'); return; }
    const product = await ruleTargetOf(tid, body);
    const old = existing.scope === 'product' && existing.product ? existing.product : null;
    const seenPrimary = hasOwn(req.body, 'expectedPrimary');
    const row = await prisma.$transaction(async (tx) => {
      const f = await lockRuleProducts(tx, tid, body, seenPrimary, product, old);
      // الطابع صريحاً: إعادة رفع صندوق المندوب تقيس عليه ما عرفه الجهاز من القواعد (rulesAtDevice، CONTRACT2 D3) — لا تعويل على
      // @updatedAt في updateMany
      const updated = await tx.priceListRule.updateMany({ where: { id: existing.id, tenantId: tid }, data: { ...ruleColumnsOf(body, f), updatedAt: new Date() } });
      if (updated.count === 0) throw new ListRefusal(404, 'PRICE_RULE_NOT_FOUND'); // حُذفت (أو حُذفت قائمتها) بعد القراءة
      await touchProducts(tx, tid, [old?.id, product?.id]);
      return tx.priceListRule.findFirst({ where: { id: existing.id, tenantId: tid }, select: RULE_SELECT });
    }, BASE_GUARD_TX);
    if (!row) { refuse(res, 404, 'PRICE_RULE_NOT_FOUND'); return; }
    res.json({ success: true, data: ruleDisplayOf(row) });
  } catch (err) {
    if (replyWriteError(res, err)) return;
    next(err);
  }
});

// حذف قاعدة — وقاعدة الصنف تحرّك طابع صنفها
router.delete('/rules/:ruleId', ...manage, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const existing = await prisma.priceListRule.findFirst({
      where: { id: String(req.params.ruleId), tenantId: tid },
      select: { id: true, scope: true, product: { select: { id: true, name: true, unit: true } } },
    });
    if (!existing) { refuse(res, 404, 'PRICE_RULE_NOT_FOUND'); return; }
    const product = existing.scope === 'product' && existing.product ? existing.product : null;
    await prisma.$transaction(async (tx) => {
      if (product) await lockBases(tx, tid, new Map([[product.id, { name: product.name, unit: product.unit }]]));
      const gone = await tx.priceListRule.deleteMany({ where: { id: existing.id, tenantId: tid } });
      if (gone.count === 0) throw new ListRefusal(404, 'PRICE_RULE_NOT_FOUND');
      await touchProducts(tx, tid, [product?.id]);
    }, BASE_GUARD_TX);
    res.json({ success: true });
  } catch (err) {
    if (replyWriteError(res, err)) return;
    next(err);
  }
});

// ═══ القوائم ═══

// قائمةٌ جديدة في آخر الترتيب
router.post('/', ...manage, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const body = z.object({ name: nameSchema }).parse(req.body);
    const name = priceListName(body.name);
    if (!name) { refuse(res, 400, 'PRICE_LIST_NAME_INVALID'); return; }
    const last = await prisma.priceList.findFirst({ where: { tenantId: tid }, orderBy: { sortOrder: 'desc' }, select: { sortOrder: true } });
    const list = await prisma.priceList.create({
      data: { tenantId: tid, name, sortOrder: (last?.sortOrder ?? -1) + 1 },
      select: LIST_SELECT,
    });
    res.status(201).json({ success: true, data: { ...list, customersCount: 0 } });
  } catch (err) {
    if (isUniqueClash(err)) { refuse(res, 409, 'PRICE_LIST_NAME_TAKEN'); return; }
    next(err);
  }
});

// إعادة تسمية قائمةٍ أو نقلها في الترتيب — اسمها في ملفات العملاء والفواتير يتبعها (مرجعٌ لا لقطة اسم)
router.put('/:id', ...manage, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const body = z.object({ name: nameSchema.optional(), sortOrder: z.number().int().min(0).max(100_000).optional() }).parse(req.body);
    const exists = await prisma.priceList.findFirst({ where: { id: String(req.params.id), tenantId: tid }, select: { id: true } });
    if (!exists) { refuse(res, 404, 'PRICE_LIST_INVALID'); return; }
    const data: { name?: string; sortOrder?: number } = {};
    if (body.name !== undefined) {
      const name = priceListName(body.name);
      if (!name) { refuse(res, 400, 'PRICE_LIST_NAME_INVALID'); return; }
      data.name = name;
    }
    if (body.sortOrder !== undefined) data.sortOrder = body.sortOrder;
    const list = await prisma.priceList.update({ where: { id: exists.id }, data, select: LIST_SELECT });
    const counts = await customersCountOf(tid);
    res.json({ success: true, data: { ...list, customersCount: counts.get(list.id) ?? 0 } });
  } catch (err) {
    if (isUniqueClash(err)) { refuse(res, 409, 'PRICE_LIST_NAME_TAKEN'); return; }
    next(err);
  }
});

/**
 * حذف قائمةٍ لا عملاء أحياء عليها — أسعارها وقواعدها تُحذف معها (Cascade في القاعدة: PriceListItem وPriceListRule). كلّه في
 * معاملةٍ واحدة بعد قفل صفّ القائمة (FOR UPDATE، كقفل حذف الصنف): إسناد عميلٍ إليها يأخذ FOR KEY SHARE لمفتاحه الأجنبي فيتعارض
 * مع القفل — إمّا التزم قبله فعُدَّ هنا (409)، وإمّا انتظر ففشل مفتاحه بعد الحذف (400 PRICE_LIST_INVALID في routes/customers.ts)،
 * ولا يسقط عميلٌ إلى السعر الأساسي بصمت (SetNull). والمناديب كذلك: كتابة قوائم المندوب تقفل صفوف قوائمها FOR KEY SHARE في
 * معاملتها (routes/salesReps.ts) فتُعدّ هنا أو تُردّ 400. وكتابة سعرٍ أو قاعدةٍ فيها تأخذ القفل نفسه بمفتاحها الأجنبي فتنتظر ثم
 * تُردّ 404 PRICE_LIST_INVALID (fkRefusalOf). وختم الفواتير والعملاء المحذوفين يُفرَّغ هنا صراحةً بطابع تعديل: SetNull في القاعدة
 * لا يحرّك updatedAt، فتبقى مزامنة /api/v1/sync عند مكامِلٍ على معرّفٍ لا يُترجم (كـtouchInvoice في services/invoiceExpiry.ts)
 */
router.delete('/:id', ...manage, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const id = String(req.params.id);
    const refusal = await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM price_lists WHERE id = ${id} AND "tenantId" = ${tid} FOR UPDATE`;
      if (!locked?.length) return { status: 404, code: 'PRICE_LIST_INVALID' as const };
      const customersCount = await tx.customer.count({ where: { tenantId: tid, priceListId: id, ...LIVE_CUSTOMER } });
      // ومناديب هي افتراضيّتهم أو ضمن قوائمهم المسموحة (قوائم الأسعار على مستوى المندوب): الحذف يُسقط افتراضيّتهم إلى الأساس
      // بصمت (SetNull) ويترك في allowedPriceTypes معرّفاً ميتاً. وكتابة المندوب تقفل الصفّ نفسه FOR KEY SHARE (routes/salesReps.ts)
      const repsCount = await tx.salesRep.count({ where: { tenantId: tid, ...repsOnList(id) } });
      if (customersCount > 0 || repsCount > 0) {
        const message = PRICE_LIST_IN_USE_BY[customersCount > 0 ? (repsCount > 0 ? 'both' : 'customers') : 'reps'];
        return { status: 409, code: 'PRICE_LIST_IN_USE' as const, customersCount, repsCount, message };
      }
      const unstamp = { priceListId: null, updatedAt: new Date() };
      await tx.invoice.updateMany({ where: { tenantId: tid, priceListId: id }, data: unstamp });
      await tx.customer.updateMany({ where: { tenantId: tid, priceListId: id }, data: unstamp });
      await tx.priceList.deleteMany({ where: { id, tenantId: tid } }); // أسعارها وقواعدها معها (Cascade)
      return null;
    }, { maxWait: 10_000, timeout: 30_000 }); // قائمةٌ على آلاف الفواتير: تفريغها عبارةٌ واحدة قد تتجاوز مهلة الخمس ثوانٍ
    if (refusal) {
      const { status, code, ...extra } = refusal;
      refuse(res, status, code, extra);
      return;
    }
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ═══ جدول أسعار القائمة (PriceListItem) ═══

const ITEMS_LIMIT_MAX = 200;
const SEARCH_MAX = 100;
const queryText = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/**
 * أصناف القائمة بأسعارها صفحةً صفحة (للمحرّر): `scope=priced` (الافتراضي) المسعّرة فيها وحدها، و`all` كل الأصناف لإضافة سطر.
 * غير المؤرشفة وحدها مرتّبةً بالاسم، والبحث بالاسم أو الكود أو الباركود كـGET /products. listPrice سعر الوحدة الرئيسية صافياً
 * (المخزَّن لوحدة الأساس × معاملها، أربع منازل)، وdefaultPrice سعر الصنف بالرئيسية (الأساس بلاها). وpricedCount عدد المسعّر كلّه
 */
router.get('/:id/items', readPrices, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const list = await readableList(req, tid, String(req.params.id));
    if (!list) { refuse(res, 404, 'PRICE_LIST_INVALID'); return; }
    const page = Math.max(1, parseInt(String(req.query.page ?? ''), 10) || 1);
    const limit = Math.min(ITEMS_LIMIT_MAX, Math.max(1, parseInt(String(req.query.limit ?? ''), 10) || 50));
    const search = queryText(req.query.search, SEARCH_MAX);
    const categoryId = queryText(req.query.categoryId, 200);
    const scope = req.query.scope === 'all' ? 'all' : 'priced';
    const where: Prisma.ProductWhereInput = {
      tenantId: tid,
      deletedAt: null,
      ...(categoryId && { categoryId }),
      ...(search && { OR: [{ name: { contains: search } }, { code: { contains: search } }, { barcode: { contains: search } }] }),
      ...(scope === 'priced' && { priceListItems: { some: { priceListId: list.id } } }),
    };
    const [total, products, pricedCount] = await Promise.all([
      prisma.product.count({ where }),
      prisma.product.findMany({
        where,
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true, code: true, name: true, categoryId: true, category: { select: { name: true } }, unit: true, basePrice: true, status: true,
          primaryUnitId: true, units: { select: UNIT_PICK },
          priceListItems: { where: { priceListId: list.id, tenantId: tid }, select: { price: true } },
        },
      }),
      prisma.priceListItem.count({ where: { tenantId: tid, priceListId: list.id, product: { deletedAt: null } } }),
    ]);
    const rows = (products ?? []).map((p) => {
      const primary = primaryUnitOf(p);
      const f = primary ? Number(primary.factor) : 1;
      const item = p.priceListItems?.[0];
      return {
        productId: p.id, code: p.code, name: p.name, categoryId: p.categoryId ?? null, categoryName: p.category?.name ?? null,
        unit: p.unit, primaryUnit: unitView(primary), defaultPrice: primaryPriceOf(p) ?? Number(p.basePrice),
        listPrice: listPriceView(item ? Number(item.price) : null, f), status: p.status,
      };
    });
    res.json({ success: true, data: { rows, pagination: paginationMeta(total, page, limit), pricedCount } });
  } catch (err) { next(err); }
});

const itemsBodySchema = z.object({
  items: z.array(z.object({
    productId: z.string().min(1).max(200),
    /** سعر الوحدة الرئيسية صافياً (الأساس بلاها)؛ null يحذف سعر الصنف من القائمة */
    price: z.number().finite().min(0).nullable(),
    expectedBaseName: z.string().max(200).nullish(),
    expectedPrimary: expectedPrimarySchema.nullish(),
  })).min(1).max(500),
});

/**
 * حفظ أسعار أصنافٍ في القائمة (الحفظ الذاتي لكل سطرٍ في المحرّر، أو دفعةٌ من مكامِل) — معاملةٌ واحدة: الأصناف تُقفل FOR KEY SHARE
 * بترتيب المعرّف (lockBases، كـPUT /customers/:id/prices) ويُقارن أساس كلٍّ منها بما رآه المحرّر ⇒ 409 BASE_UNIT_CHANGED، ورئيسيّته
 * تحت القفل بما رآه ⇒ 409 PRIMARY_UNIT_CHANGED؛ ثم السعر ÷ معامل الرئيسية لوحدة الأساس بستّ منازل (listBasePriceOf)، وnull يحذف.
 * السطر بسعرٍ بلا expectedBaseName ⇒ 400 BASE_UNIT_REQUIRED. والصنف من الشركة غير مؤرشف وإلا 400 PRODUCT_NOT_FOUND، والقائمة
 * وإلا 404 PRICE_LIST_INVALID. والمعرّف المكرَّر: الأخير يغلب. والمهلة تكبر بعدد السطور (I10)
 */
router.put('/:id/items', ...manage, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const body = itemsBodySchema.parse(req.body ?? {});
    const list = await prisma.priceList.findFirst({ where: { id: String(req.params.id), tenantId: tid }, select: { id: true } });
    if (!list) { refuse(res, 404, 'PRICE_LIST_INVALID'); return; }
    const rawItems: unknown[] = Array.isArray(req.body?.items) ? req.body.items : [];
    const rows = new Map<string, z.infer<typeof itemsBodySchema>['items'][number] & { seenPrimary: boolean }>();
    body.items.forEach((it, i) => rows.set(it.productId, { ...it, seenPrimary: hasOwn(rawItems[i], 'expectedPrimary') }));
    if ([...rows.values()].some((r) => r.price != null && !sentBase(r.expectedBaseName))) { refuse(res, 400, 'BASE_UNIT_REQUIRED'); return; }
    const ids = [...rows.keys()];
    const owned = await prisma.product.findMany({ where: { id: { in: ids }, tenantId: tid, deletedAt: null }, select: { id: true, name: true, unit: true } });
    if ((owned ?? []).length !== ids.length) { refuse(res, 400, 'PRODUCT_NOT_FOUND'); return; }
    // الأساس الذي رآه المحرّر لكل سطر (وسطر الحذف بلا الحقل: أساسه المقروء الآن) — يُقارن تحت القفل
    const expected: ExpectedBases = new Map(owned.map((p) => {
      const sent = rows.get(p.id)?.expectedBaseName;
      return [p.id, { name: p.name, unit: sentBase(sent) ? sent : p.unit }];
    }));
    const written = await prisma.$transaction(async (tx) => {
      await lockBases(tx, tid, expected);
      const locked = await tx.product.findMany({
        where: { id: { in: ids }, tenantId: tid }, select: { id: true, deletedAt: true, primaryUnitId: true, units: { select: UNIT_PICK } },
      });
      const byId = new Map((locked ?? []).map((p) => [p.id, p]));
      // كل السطور تُفحص تحت القفل قبل أول كتابة: مؤرشفٌ بين القراءة والقفل ⇒ 400، ورئيسيةٌ غير التي رآها المحرّر ⇒ 409
      const plan = [...rows].map(([productId, r]) => {
        const p = byId.get(productId);
        if (!p || p.deletedAt) throw new ListRefusal(400, 'PRODUCT_NOT_FOUND');
        const primary = primaryUnitOf(p);
        if (r.seenPrimary && r.price != null && !primaryMatches(primary, r.expectedPrimary ?? null)) throw new ListRefusal(409, 'PRIMARY_UNIT_CHANGED');
        const f = primary ? Number(primary.factor) : 1;
        return { productId, f, base: r.price == null ? null : listBasePriceOf(r.price, f) };
      });
      const out: Array<{ productId: string; listPrice: number | null }> = [];
      const changed: string[] = [];
      for (const { productId, f, base } of plan) {
        if (base == null) {
          const gone = await tx.priceListItem.deleteMany({ where: { priceListId: list.id, productId, tenantId: tid } });
          if (gone.count > 0) changed.push(productId);
        } else {
          await tx.priceListItem.upsert({
            where: { priceListId_productId: { priceListId: list.id, productId } },
            create: { tenantId: tid, priceListId: list.id, productId, price: base },
            update: { price: base },
          });
          changed.push(productId);
        }
        out.push({ productId, listPrice: listPriceView(base, f) });
      }
      // أسعار القائمة بلا طابع تعديل في الصنف — فتغييرها تغييرٌ للصنف تراه مزامنة ERP و/api/v1/sync (كالشرائح)
      await touchProducts(tx, tid, changed);
      return out;
    }, { ...BASE_GUARD_TX, timeout: Math.max(BASE_GUARD_TX.timeout, rows.size * 60) }); // I10: المهلة تكبر بالسطور (٥٠٠ سطر ⇒ ٣٠ ثانية)
    res.json({ success: true, data: { rows: written } });
  } catch (err) {
    if (replyWriteError(res, err)) return;
    next(err);
  }
});

// ═══ قواعد قائمةٍ واحدة ═══

// قواعد القائمة بأسماء أصنافها وفئاتها (للمحرّر) بترتيب العرض
router.get('/:id/rules', readPrices, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const list = await readableList(req, tid, String(req.params.id));
    if (!list) { refuse(res, 404, 'PRICE_LIST_INVALID'); return; }
    const rows = await prisma.priceListRule.findMany({ where: { tenantId: tid, priceListId: list.id }, select: RULE_SELECT });
    const data = (rows ?? [])
      .filter((r) => r.scope !== 'product' || (r.product && !r.product.deletedAt))
      .map(ruleDisplayOf)
      .sort(displayOrder);
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

/**
 * قاعدةٌ جديدة في القائمة — بحدّ PRICE_RULE_LIMITS.perList قاعدةً للقائمة (409 PRICE_RULE_LIMIT). العدّ داخل المعاملة بعد قفل صفّ
 * القائمة: منشئان معاً (سكربت مكامِل أو تبويبان) قرأ كلاهما ١٩٩٩ خارجها فصارت ٢٠٠١. FOR NO KEY UPDATE يرتّب المنشئين (وإعادة
 * التسمية) ويتعارض مع FOR UPDATE حذف القائمة، ولا يتعارض مع FOR KEY SHARE الذي تأخذه مفاتيح العملاء والفواتير والأسعار الأجنبية —
 * فإنشاء قاعدةٍ لا يوقف إصدار فواتير القائمة. وقائمةٌ حُذفت بين القراءة والقفل ⇒ 404 PRICE_LIST_INVALID. ثم قفل الصنف (lockRuleProducts)
 */
router.post('/:id/rules', ...manage, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const body = parseRule(req.body);
    const list = await prisma.priceList.findFirst({ where: { id: String(req.params.id), tenantId: tid }, select: { id: true } });
    if (!list) { refuse(res, 404, 'PRICE_LIST_INVALID'); return; }
    const product = await ruleTargetOf(tid, body);
    const seenPrimary = hasOwn(req.body, 'expectedPrimary');
    const row = await prisma.$transaction(async (tx) => {
      const held = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM price_lists WHERE id = ${list.id} AND "tenantId" = ${tid} FOR NO KEY UPDATE`;
      if (!held?.length) throw new ListRefusal(404, 'PRICE_LIST_INVALID');
      const count = await tx.priceListRule.count({ where: { tenantId: tid, priceListId: list.id } });
      if (count >= PRICE_RULE_LIMITS.perList) throw new ListRefusal(409, 'PRICE_RULE_LIMIT');
      const f = await lockRuleProducts(tx, tid, body, seenPrimary, product, null);
      const created = await tx.priceListRule.create({
        data: { tenantId: tid, priceListId: list.id, ...ruleColumnsOf(body, f) }, select: RULE_SELECT,
      });
      await touchProducts(tx, tid, [product?.id]);
      return created;
    }, BASE_GUARD_TX);
    res.status(201).json({ success: true, data: ruleDisplayOf(row) });
  } catch (err) {
    if (replyWriteError(res, err)) return;
    next(err);
  }
});

export default router;
