import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import prisma from '../config/database';
import { authenticate, requireAdmin, requireAdminPermission, requireAccounting, tenantId, isOwnerSession, actorOf } from '../middleware/auth';
import { AuthRequest } from '../types';
import { paginate, paginationMeta, roundDecimal } from '../utils/helpers';
import { canAccessCustomer } from '../services/customerScope';
import { applyProductVatGate } from './productsZatca';
import { RETURN_RULE_METRICS, RETURN_RULE_MODES, SHELF_LIFE_BASES, SHELF_LIFE_UNITS, returnRuleConfigProblem, shelfLifeProblem } from '../services/shelfLife';
import { MAX_UNIT_FACTOR, QTY_EPS, unitProblem, factorOf, baseNameKey, derivedBasePrice, primaryUnitOf, type UnitDef } from '../services/units';
import { REP_UNIT_RULES, hasRepRules, repRuleConfigProblem, repRulesChanged, repUnitRuleOf } from '../services/repProductRules';
import { LOT_BUCKETS, LOT_EPS, LotError, asLockBusy, asLotBusy, lotErr, lotErrorBody, lotHttpError, roundLot, type BucketQty, type PlaceLotView } from '../services/lots';
import { LOT_LOCK_TIMEOUT, acquireLotQueue, lockLotProducts, placeViews, recordLotEvent, type LotEventActor, type LotTx } from '../services/lotsDb';
import { convertBaseRefusalFor } from '../services/convertBaseAccess';
import { BASE_GUARD_TX, markConverting, unmarkConverting } from '../services/baseGuard';

const router = Router();
router.use(authenticate); // القراءة متاحة للمندوب (للبحث عند إصدار الفاتورة)؛ الكتابة للإدارة فقط
router.use(requireAccounting); // عزل «النظام المحاسبي»
router.use(requireAdminPermission('canManageProducts'));

const productSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  // nullish لا optional: نماذج RHF ترسل null للحقول الفارغة غير الملموسة،
  // وoptional() يرفض null فيفشل حفظ التعديل بلا سبب ظاهر (درس نموذج العملاء)
  barcode: z.string().nullish(),
  unit: z.string().min(1),
  basePrice: z.number().min(0),
  taxPct: z.number().min(0).max(100).nullish(), // يُورَث من ضريبة دولة الشركة عند الغياب
  image: z.string().nullish().or(z.literal('')), // صورة الصنف (base64 data URL)
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
  damagedReturnToStock: z.boolean().optional(), // سياسة: هل يعود مرتجع هذا الصنف التالف للمخزون؟
  // صلاحية الصنف وأساس حسابها (البيع | الشراء بتاريخٍ يُكتب هنا | تحميل السيارة) — يُتحقَّق منها بعد الدمج مع المحفوظ
  shelfLifeEnabled: z.boolean().optional(),
  shelfLifeValue: z.number().int().positive().nullish(),
  shelfLifeUnit: z.enum(SHELF_LIFE_UNITS).nullish(),
  shelfLifeBasis: z.enum(SHELF_LIFE_BASES).optional(),
  shelfLifeFromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish().or(z.literal('')),
  // قيد المرتجع لصنف الصلاحية: قرب الانتهاء | ما زال صالحاً، بالأيام | بالنسبة — يُتحقَّق منه مدمجاً (returnRuleConfigProblem)
  returnRuleEnabled: z.boolean().optional(),
  returnRuleMode: z.enum(RETURN_RULE_MODES).nullish(),
  returnRuleMetric: z.enum(RETURN_RULE_METRICS).nullish(),
  returnRuleValue: z.number().int().positive().nullish(),
  // «قيود المندوب» (services/repProductRules.ts): للمندوب وحده. null من النموذج ⇒ بلا تغيير (الأعمدة غير قابلة للفراغ)،
  // و«الكبرى فقط» يُتحقَّق منه مع وحدات الصنف (repRuleConfigProblem)
  repSaleAllowed: z.boolean().nullish(),
  repReturnAllowed: z.boolean().nullish(),
  repSaleUnit: z.enum(REP_UNIT_RULES).nullish(),
  repReturnUnit: z.enum(REP_UNIT_RULES).nullish(),
  categoryId: z.string().nullish(),
  // أكواد الفوترة الإلكترونية
  itemCode: z.string().nullish().or(z.literal('')),     // كود الصنف (EGS/GS1)
  itemCodeType: z.enum(['EGS', 'GS1']).nullish(),
  unitCode: z.string().nullish().or(z.literal('')),     // كود الوحدة حسب جدول المزوّد
});

// «تتبّع اللوط» (§٤.٢) — مخطّطٌ منفصل عن productSchema فلا يمرّ العلم في { ...data } إلى الإنشاء والتعديل: انتقاله يُحكم بعلم
// الشركة والقفل والحقبة (setProductLotTracking)، وproductSchema يُسقط المفتاحين من data كأي مفتاحٍ مجهول.
// nullish لا optional (درس productSchema أعلاه): null من نموذج RHF غيابٌ كما كان قبل الميزة — لا 400 ولا انتقال (§١٠.١)
const productLotSchema = z.object({
  lotTracked: z.boolean().nullish(),
  confirmLotBalances: z.boolean().nullish(), // إطفاء تتبّع صنفٍ له أرصدة في تشغيلات (D9)
});

const categorySchema = z.object({ name: z.string().min(1) });

/** تاريخ الشراء YYYY-MM-DD ⇒ تاريخٌ مجرّد (منتصف ليل UTC لعمود @db.Date)؛ والفارغ null */
const asDay = (d: string | null | undefined) => (d ? new Date(`${d}T00:00:00.000Z`) : null);

// حدود الشريحة **بوحدة الأساس** وسعرها لوحدة الأساس (DESIGN القاعدتان ٤ و٥). baseMinQty/baseMaxQty اختياريان:
// غيابهما ⇒ هما minQty/maxQty نفسيهما — فالواجهة القائمة التي ترسل minQty وحده تكتب العمودين معاً كما يلزم
const priceTierSchema = z.array(z.object({
  minQty: z.number().min(0),
  maxQty: z.number().optional(),
  baseMinQty: z.number().min(0).optional(),
  baseMaxQty: z.number().nullish(),
  price: z.number().min(0),
}));

// ═══ الوحدات المتعددة (DESIGN.md «عقد الـAPI») ═══

/** ترتيب وحدات الصنف في كل ردّ: ترتيب المدير ثم المعامل — والأولى هي وحدة البيع الافتراضية بعد التحويل */
const UNITS_ORDER = { orderBy: [{ sortOrder: 'asc' as const }, { factor: 'asc' as const }] };

/** سعر الوحدة: رقمٌ موجب، أو فارغ/null ⇒ يُشتقّ من سعر الأساس × المعامل (unitPriceOf) */
const unitPriceField = z.union([z.number(), z.literal(''), z.null()]).optional();

const unitCreateSchema = z.object({
  name: z.string(),
  factor: z.number(),
  price: unitPriceField,
  unitCode: z.string().max(16).nullish().or(z.literal('')),
  sortOrder: z.number().int().optional(),
  // «الوحدة الرئيسية» (§2.2-د): الوحدة الجديدة تصير رئيسية الصنف في المعاملة نفسها
  makePrimary: z.boolean().optional(),
  // الأساس كما رآه النموذج — وحدةٌ بمعاملٍ محسوب على أساسٍ حُوِّل بعده ⇒ 409 BASE_UNIT_CHANGED (ولمفتاح API على صنفٍ حُوِّل إلزامي، D19)
  expectedBaseName: z.string().nullish(),
});

const unitUpdateSchema = z.object({
  name: z.string().optional(),
  factor: z.number().optional(),
  price: unitPriceField,
  unitCode: z.string().max(16).nullish().or(z.literal('')),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
  // إيقاف الوحدة الرئيسية يلزمه إلغاء الرئيسية صراحةً معه (D13) — وإلا 409 PRIMARY_UNIT_IN_USE
  clearPrimary: z.boolean().optional(),
  expectedBaseName: z.string().nullish(),
});

const convertBaseSchema = z.object({
  newBaseName: z.string(),
  factor: z.number(),
  // اسم وحدة الأساس كما رآه من فتح نافذة التحويل — يمنع التحويل المزدوج (نقرتان أو مديران معاً)
  expectedBaseName: z.string(),
  basePrice: z.number().min(0).nullish(),
  // اختياري: رمز وحدة الأساس الجديدة الضريبي. غيابه ⇒ رمز الصنف كما هو؛ والرمز القديم يرثه الكرتون (الخطوة ٣)
  baseUnitCode: z.string().max(16).nullish().or(z.literal('')),
  // «الوحدة الرئيسية» (D12): الوحدة القديمة (الكرتون) تصير رئيسية الصنف ما لم تُرسل false — فلا يتغيّر عرضه ولا إدخاله الافتراضي
  keepOldBaseAsPrimary: z.boolean().optional(),
  // معاينة بلا معاملة ولا قفل ولا كتابة: ما سيُحوَّل، وما يلزم إقراره (ERP ومفاتيح API)
  dryRun: z.boolean().optional(),
  acknowledgeErp: z.boolean().optional(),
  acknowledgeApi: z.boolean().optional(),
});

// ═══ «الوحدة الرئيسية» (مواصفة الوحدة الرئيسية §2.2) — عرضٌ وتعريفٌ وإدخالٌ افتراضي فقط (القاعدة الذهبية ١٢) ═══

/** الإنشاء العكسي الذرّي (D10): وحدات الصنف ورئيسيّه باسمها مع إنشائه — مخطّطٌ منفصل، وproductSchema كما هو لأن PUT يستعمل .partial() منه */
const productCreateUnitSchema = z.object({ name: z.string(), factor: z.number(), price: unitPriceField, unitCode: z.string().max(16).nullish().or(z.literal('')) });
const productCreateSchema = productSchema.extend({
  basePrice: z.number().min(0).nullish(),
  units: z.array(productCreateUnitSchema).max(10).optional(),
  primaryUnitName: z.string().trim().min(1).max(24).nullish(),
});

/** تبديل الرئيسية لصنفٍ قائم (D11): علمٌ لا مال. expectedPrimaryUnitId (إن حضر مفتاحه) يمنع نموذجاً قديماً */
const primaryUnitSchema = z.object({ unitId: z.string().min(1).nullable(), expectedPrimaryUnitId: z.string().nullish() });

/** حارس التعديل (§2.2-هـ): الأساس كما رآه النموذج، ورقعة الوحدة الرئيسية تُكتب مع الصنف في معاملةٍ واحدة */
const productEditGuardSchema = z.object({
  expectedBaseName: z.string().nullish(),
  primaryUnit: z.object({ id: z.string().min(1), name: z.string().optional(), factor: z.number().optional(),
    price: unitPriceField, unitCode: z.string().max(16).nullish().or(z.literal('')) }).nullish(),
});

/** حارس الشرائح (§2.2-د): الأساس، والرئيسية ومعاملها كما حُسبت عليهما الحدود حين تُدخل بالرئيسية (/m) */
const tierGuardSchema = z.object({
  expectedBaseName: z.string().nullish(),
  expectedPrimary: z.object({ id: z.string().min(1), factor: z.number() }).nullish(),
});

const BASE_UNIT_REQUIRED_MSG = 'هذا الصنف حُوِّلت وحدته — أرسل expectedBaseName';
const BASE_UNIT_STALE_MSG = 'تغيّرت وحدات الصنف — أعد فتحه قبل الحفظ';
const PRIMARY_UNIT_INVALID_MSG = 'الوحدة الرئيسية يجب أن تكون إحدى وحدات الصنف';
const PRIMARY_UNIT_CHANGED_MSG = 'تغيّرت الوحدة الرئيسية منذ فتحت الصنف — أعد فتحه';
const PRIMARY_UNIT_IN_USE_MSG = 'هذه الوحدة الرئيسية للصنف — اجعل وحدة أخرى رئيسية أو ألغِ الرئيسية أولاً';
const PRODUCT_UNITS_BUSY_MSG = 'يجري تحويل وحدات هذا الصنف — أعد المحاولة بعد قليل';
const retiredBaseMsg = (name: string) => `اسم «${name}» كان وحدة هذا الصنف قبل تحويله — اختر اسماً آخر`;
/** D19-أ: مفتاحٌ استُعمل في هذه المدة «نشط» — يلزم إقرار التحويل */
const API_KEY_ACTIVE_DAYS = 30;

/** وحدة الأساس كوحدةٍ بمعامل ١ — تدخل «الأخريات» في unitProblem فلا تُكرَّر باسمها ولا بمعاملها */
const baseAsUnit = (unit: string): UnitDef => ({ name: unit, factor: 1 });

const priceOrNull = (p: number | '' | null | undefined): number | null => (p === '' || p == null ? null : p);

/** رفض بنيويّ للتحويل والوحدات — يُرمى داخل المعاملة فيُلغيها، ويُردّ برمزه ورسالته */
class UnitsRefusal extends Error {
  constructor(readonly status: number, message: string, readonly code = 'PRODUCT_UNITS_INVALID') { super(message); }
}

const isUniqueViolation = (err: unknown): boolean => (err as { code?: string })?.code === 'P2002';

type RepRuleKeys = 'repSaleAllowed' | 'repReturnAllowed' | 'repSaleUnit' | 'repReturnUnit';
const REP_RULE_KEYS: readonly RepRuleKeys[] = ['repSaleAllowed', 'repReturnAllowed', 'repSaleUnit', 'repReturnUnit'];

/**
 * «قيود المندوب» كما تُكتب في الإنشاء والتعديل: null أو الغياب ⇒ بلا تغيير، وأيّ تغييرٍ عن المحفوظ (أو قيدٌ غير الافتراضي
 * لصنفٍ جديد) يختم repRulesChangedAt — مرجع تسامح صندوق الأوف-لاين (services/repProductRules.ts replayPredatesRepRule).
 * تُعيد الحقول للكتابة والحالة المدمجة للفحص.
 */
function repRuleWrite(data: Partial<Record<RepRuleKeys, unknown>>, before: Partial<Record<RepRuleKeys, unknown>> | null) {
  const write: Record<string, unknown> = {};
  for (const k of REP_RULE_KEYS) if (data[k] != null) write[k] = data[k];
  const merged = { ...(before ?? {}), ...write } as Parameters<typeof hasRepRules>[0];
  if (before ? repRulesChanged(before as Parameters<typeof hasRepRules>[0], merged) : hasRepRules(merged)) write.repRulesChangedAt = new Date();
  return { write, merged };
}

/** قيد «الكبرى فقط» بلا وحدةٍ كبرى نشطة بعد تعديل الوحدات ⇒ يُمنع الصنف على المندوب بلا قصد — فيُرفض التعديل */
function refuseLargeRuleWithout(product: { repSaleUnit: string; repReturnUnit: string }, units: ReadonlyArray<{ factor: number; isActive: boolean }>) {
  if (repRuleConfigProblem(product, units)) {
    throw new UnitsRefusal(409, 'الصنف مقيد للمندوب بالوحدة الكبرى فقط — غير قيد المندوب قبل إيقاف آخر وحدة كبرى أو حذفها', 'REP_UNIT_RULE_SET');
  }
}

/**
 * قفل صفّ الصنف داخل المعاملة ثم قراءته — كل كتابةٍ على وحدات الصنف تمرّ من هنا.
 *
 * لماذا القفل حتى لإضافة وحدة: التحويل يضرب معاملات الوحدات القائمة بـF، فوحدةٌ تُضاف بمعاملٍ محسوبٍ على الأساس
 * القديم وتلتزم بعد التحويل تُقرأ على الأساس الجديد — كرتونٌ صار حبّتين. والقفل يرتّب الكاتبَين فيرى الثاني ما التزمه الأوّل.
 */
async function lockProduct(tx: Prisma.TransactionClient, tid: string, productId: string) {
  await tx.$queryRaw`SELECT id FROM products WHERE id = ${productId} AND "tenantId" = ${tid} FOR UPDATE`;
  return readLockedProduct(tx, tid, productId);
}

/**
 * قفل كتّاب الوحدات والشرائح والرئيسية: FOR UPDATE كـlockProduct، بمهلةٍ محلية تُحفظ وتُستعاد (نمط lockProductForEdit) — خلف
 * تحويلٍ طويل يمسك الصفّ (حتى ١٢٠ ثانية) ⇒ 503 PRODUCT_UNITS_BUSY بعد ٥ ثوانٍ، لا P2028 ثم 500 ممسكاً اتصالاً. ويُحوَّل خطأ
 * القفل وحده (لا خطأٌ من بقية المعاملة). والتحويل نفسه يبقى على lockProduct بلا مهلة: ينتظر الفواتير الممسكة FOR KEY SHARE كما كان
 */
async function lockProductForUnits(tx: Prisma.TransactionClient, tid: string, productId: string) {
  const prev = await tx.$queryRaw<{ lock_timeout: string }[]>`SELECT current_setting('lock_timeout') AS lock_timeout`;
  await tx.$executeRaw`SELECT set_config('lock_timeout', ${LOT_LOCK_TIMEOUT}, true)`;
  try {
    await tx.$queryRaw`SELECT id FROM products WHERE id = ${productId} AND "tenantId" = ${tid} FOR UPDATE`;
  } catch (e) {
    if (asLotBusy(e)) throw new UnitsRefusal(503, PRODUCT_UNITS_BUSY_MSG, 'PRODUCT_UNITS_BUSY');
    throw e;
  }
  await tx.$executeRaw`SELECT set_config('lock_timeout', ${prev[0]?.lock_timeout ?? '0'}, true)`;
  return readLockedProduct(tx, tid, productId);
}

/** صفّ الصنف كما يقرؤه كل كاتبٍ بعد قفله — select واحد لقفلَي الوحدات والتعديل */
function readLockedProduct(tx: Prisma.TransactionClient, tid: string, productId: string) {
  return tx.product.findFirst({
    where: { id: productId, tenantId: tid },
    select: {
      id: true, unit: true, basePrice: true, unitCode: true,
      // «تتبّع اللوط»: الصفّ المقفل يغني convert-base عن FOR KEY SHARE ثانٍ (lockLotProducts بـlockedRows)
      lotTracked: true, lotTrackedSince: true,
      // «الوحدة الرئيسية»: الرئيسية ولحظة آخر تحويل تحت القفل نفسه (D2، D19، D20)
      primaryUnitId: true, baseConvertedAt: true,
      units: { select: { id: true, name: true, factor: true, price: true, unitCode: true, isActive: true, sortOrder: true } },
      repSaleUnit: true, repReturnUnit: true, // «قيود المندوب»: الكبرى فقط تحرس آخر وحدةٍ كبرى، وتمنع تحويل الأساس
    },
  });
}

/**
 * قفل التعديل (§2.2-أ): FOR NO KEY UPDATE — القفل الذي يأخذه UPDATE عادي. يتعارض مع FOR UPDATE الذي يأخذه التحويل وكتّاب
 * الوحدات، ولا يتعارض مع FOR KEY SHARE الذي تأخذه الفواتير، فتعديل الصنف لا ينتظر كل فاتورة تصدر. والانتظار بمهلةٍ محلية تُحفظ
 * وتُستعاد (نمط حذف الصنف): تحويلٌ طويل يمسك الصفّ ⇒ 503 PRODUCT_UNITS_BUSY مبكراً، لا انتظار مهلة المعاملة ثم 500.
 * والانشغال المحوَّل هو انتظار هذا القفل وحده (55P03 و40P01، أو انقضاء المعاملة عنده P2028) — ما يقع في بقية المعاملة يمرّ كما هو
 */
async function lockProductForEdit(tx: Prisma.TransactionClient, tid: string, productId: string) {
  const prev = await tx.$queryRaw<{ lock_timeout: string }[]>`SELECT current_setting('lock_timeout') AS lock_timeout`;
  await tx.$executeRaw`SELECT set_config('lock_timeout', ${LOT_LOCK_TIMEOUT}, true)`;
  try {
    await tx.$queryRaw`SELECT id FROM products WHERE id = ${productId} AND "tenantId" = ${tid} FOR NO KEY UPDATE`;
  } catch (e) {
    if (asLotBusy(e)) throw new UnitsRefusal(503, PRODUCT_UNITS_BUSY_MSG, 'PRODUCT_UNITS_BUSY');
    throw e;
  }
  await tx.$executeRaw`SELECT set_config('lock_timeout', ${prev[0]?.lock_timeout ?? '0'}, true)`;
  return readLockedProduct(tx, tid, productId);
}

/**
 * كاتب إعداد الصنف (الوحدات والشرائح، §2.2-د) على الصفّ المقفل: الأساس الذي حُسب عليه الجسم هو أساسه الآن.
 * D19: مفتاح API على صنفٍ حُوِّل يلزمه الأساس صراحةً — رفضٌ ظاهر بدل «طبلية = 50» محسوبة على الكرتون بعد تحويله (×٢٤ صامت).
 */
function assertExpectedBase(req: AuthRequest, locked: { unit?: string | null; baseConvertedAt?: Date | null }, expectedBaseName: string | null | undefined): void {
  if (req.user?.apiKeyId && locked.baseConvertedAt != null && expectedBaseName == null) {
    throw new UnitsRefusal(400, BASE_UNIT_REQUIRED_MSG, 'BASE_UNIT_REQUIRED');
  }
  if (expectedBaseName != null && baseNameKey(expectedBaseName) !== baseNameKey(locked.unit)) {
    throw new UnitsRefusal(409, BASE_UNIT_STALE_MSG, 'BASE_UNIT_CHANGED');
  }
}

/**
 * D20-ب: اسمٌ ظهر fromUnit في تحويلٍ سابق بمعامل > ١ لهذا الصنف «متقاعد» — لا يعود أساساً، فلا تلتقط سلسلة إعادة الرفع صفاً
 * خاطئاً. يُسأل السجلّ حين حُوِّل الصنف وحده (I8)، والمقارنة بـbaseNameKey على الطرفين (D20-أ).
 */
async function isRetiredBaseName(db: Prisma.TransactionClient, tid: string, productId: string, baseConvertedAt: Date | null | undefined, name: string): Promise<boolean> {
  if (baseConvertedAt == null) return false;
  const rows = await db.productBaseConversion.findMany({ where: { tenantId: tid, productId, factor: { gt: 1 } }, select: { fromUnit: true } });
  const key = baseNameKey(name);
  return (rows ?? []).some((r) => baseNameKey(r.fromUnit) === key);
}

/** صفّ الصنف المقفل كما يحتاجه التعديل المحروس — من lockProductForEdit، أو من صفّ «تتبّع اللوط» المقفل مع وحداته */
interface LockedForEdit {
  id: string; unit: string; primaryUnitId: string | null; baseConvertedAt: Date | null;
  units: Array<{ id: string; name: string; factor: number; price: number | null; isActive?: boolean }>;
}

/**
 * خطوات التعديل المحروس ٢–٦ (§2.2-هـ) على الصفّ المقفل، قبل product.update — مشتركة بين المسار العادي (lockProductForEdit)
 * ومسار «تتبّع اللوط» (setProductLotTracking بعد FOR UPDATE). أي رفضٍ UnitsRefusal يُلغي المعاملة قبل أي كتابة على الصنف.
 */
async function guardProductEdit(tx: Prisma.TransactionClient, req: AuthRequest, tid: string, locked: LockedForEdit,
  o: { guard: z.infer<typeof productEditGuardSchema>; newUnit: string | undefined; seenUnit: string }): Promise<void> {
  // ٢. D19: مفتاحٌ يجهل التحويل يكتب سعراً أو وحدة لصنفٍ حُوِّل ⇒ 400، لا سعر كرتونٍ للقارورة
  if (req.user?.apiKeyId && locked.baseConvertedAt != null && o.guard.expectedBaseName == null) {
    throw new UnitsRefusal(400, BASE_UNIT_REQUIRED_MSG, 'BASE_UNIT_REQUIRED');
  }
  // ٣. الأساس الذي حُسب عليه الجسم ليس أساس الصفّ المقفل ⇒ حُوِّل بينهما: basePrice الكرتون فوق سعر القارورة مالٌ ×٢٤
  if (baseNameKey(locked.unit) !== baseNameKey(o.guard.expectedBaseName || o.seenUnit)) {
    throw new UnitsRefusal(409, BASE_UNIT_STALE_MSG, 'BASE_UNIT_CHANGED');
  }
  const newBase = o.newUnit !== undefined ? o.newUnit : locked.unit;
  const renames = baseNameKey(newBase) !== baseNameKey(locked.unit);
  const patch = o.guard.primaryUnit ?? null;
  if (renames) {
    // ٤. اسم الأساس الجديد لا يساوي اسم وحدةٍ للصنف — على الصفّ المقفل وبعد رقعة الرئيسية، ثم الاسم المتقاعد (D20-ب)
    const names = locked.units.map((u) => (patch && u.id === patch.id && patch.name !== undefined ? patch.name : u.name).trim());
    if (names.includes(newBase.trim())) throw new UnitsRefusal(400, 'اسم وحدة الأساس مستخدم لوحدة أخرى لهذا الصنف');
    if (await isRetiredBaseName(tx, tid, locked.id, locked.baseConvertedAt, newBase)) {
      throw new UnitsRefusal(409, retiredBaseMsg(newBase.trim()), 'BASE_NAME_RETIRED');
    }
  }
  // ٥. رقعة الرئيسية: الوحدة التي رآها النموذج هي الرئيسية الآن، والمدموج صالحٌ بين وحدات الصنف والأساس الجديد
  if (patch) {
    const current = locked.units.find((u) => u.id === patch.id);
    if (!current || patch.id !== locked.primaryUnitId) throw new UnitsRefusal(409, PRIMARY_UNIT_CHANGED_MSG, 'PRIMARY_UNIT_CHANGED');
    const merged = {
      name: patch.name ?? current.name,
      factor: patch.factor ?? current.factor,
      price: patch.price !== undefined ? patch.price : current.price,
    };
    const problem = unitProblem(merged, [baseAsUnit(newBase), ...locked.units.filter((u) => u.id !== current.id)]);
    if (problem) throw new UnitsRefusal(400, problem);
    await tx.productUnit.updateMany({
      where: { id: current.id, productId: locked.id, tenantId: tid },
      data: {
        ...(patch.name !== undefined && { name: patch.name.trim() }),
        ...(patch.factor !== undefined && { factor: Math.round(Number(patch.factor)) }),
        ...(patch.price !== undefined && { price: priceOrNull(patch.price) }),
        ...(patch.unitCode !== undefined && { unitCode: patch.unitCode || null }),
      },
    });
  }
  // ٦. إعادة تسمية الأساس: صفٌّ بمعامل ١ يُبقي سلسلة إعادة الرفع متّصلة (§2.12) — لكل صنفٍ حُوِّل أم لا، وbaseConvertedAt كما هو
  if (renames) {
    await tx.productBaseConversion.create({
      data: { tenantId: tid, productId: locked.id, fromUnit: locked.unit, toUnit: newBase, factor: 1, fromUnitId: null, convertedBy: actorOf(req) },
    });
  }
}

/** وحدات الصنف بلا طابع تعديل في الصنف — فتغييرها تغييرٌ للصنف تراه مزامنة ERP و/api/v1/sync (كالشرائح) */
const touchProduct = (tx: Prisma.TransactionClient, tid: string, productId: string) =>
  tx.product.updateMany({ where: { id: productId, tenantId: tid }, data: { updatedAt: new Date() } });

/**
 * سبب رفض تحويل وحدة الأساس، أو null — صرفةٌ على صفّ الصنف المقفل.
 *
 * المعامل صحيحٌ ≥ ٢: الأساس الجديد أصغر من القديم (كرتون ⇒ حبة)، والمعامل ١ تحويلٌ بلا معنى، والكسر نقضٌ للمبدأ.
 * ووحدات الصنف القائمة تُضرب بـF، فلا تتجاوز إحداها الحدّ بعده.
 */
export function baseConversionProblem(
  product: { unit: string; units: Array<{ name: string; factor: number }> },
  input: { newBaseName: string; factor: number },
): string | null {
  const f = Number(input.factor);
  if (!Number.isFinite(f) || Math.abs(f - Math.round(f)) > QTY_EPS || Math.round(f) < 2) {
    return 'معامل التحويل عدد صحيح أكبر من ١ — كم وحدة أساس جديدة في الوحدة الحالية';
  }
  const F = Math.round(f);
  if (F > MAX_UNIT_FACTOR) return `معامل التحويل لا يتجاوز ${MAX_UNIT_FACTOR}`;
  const name = String(input.newBaseName ?? '').trim();
  if (!name) return 'اسم وحدة الأساس الجديدة مطلوب';
  if (name.length > 24) return 'اسم الوحدة طويل';
  if (name === product.unit.trim()) return 'وحدة الأساس الجديدة هي الحالية نفسها';
  if (product.units.some((u) => u.name.trim() === name)) return 'اسم وحدة الأساس الجديدة مستخدم لوحدة أخرى لهذا الصنف';
  // الوحدة الحالية تصير وحدةً باسمها — فلا وحدةَ قائمة تحمل الاسم نفسه (قيد productId+name)
  if (product.units.some((u) => u.name.trim() === product.unit.trim())) return 'يوجد وحدة باسم وحدة الأساس الحالية لهذا الصنف';
  const over = product.units.find((u) => Number(u.factor) * F > MAX_UNIT_FACTOR);
  if (over) return `معامل وحدة «${over.name}» يتجاوز ${MAX_UNIT_FACTOR} بعد التحويل`;
  return null;
}

// أسعار عميل بعينها (صافية قبل الضريبة) — يحتاجها تطبيق المندوب ليعرض السعر المتفق
// عليه مع هذا العميل. بدونها كان يعرض basePrice الأعلى فيرفضه حارس الصلاحية في الخادم
// (سعر العميل هو السقف المرجعي) ⇒ «لا تملك صلاحية تغيير سعر البيع» على كل مستند لهذا العميل.
// خفيفة عمداً (معرّف + سعر) لتُحمَّل وتُخزَّن في الكاش على الجوال بلا كلفة.
// و«الوحدة الرئيسية» (§2.2-ح): `unit` أساس الصنف لحظة القراءة — فيعرف الجهاز على أي أساسٍ حُسب السعر المخزَّن في كاشه
// (بعد تحويلٍ يُقسم سعر الكرتون على المعامل، فلا يُضرب ×٢٤ مرّتين)
router.get('/customer-prices/:customerId', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    if (!(await canAccessCustomer(req, tid, req.params.customerId))) {
      res.status(403).json({ success: false, message: 'هذا العميل غير مسند لك' });
      return;
    }
    /* «الوحدة الرئيسية»: السعر وأساس صنفه (`unit`) ولحظة آخر تحويلٍ له (`baseConvertedAt`، حاضرٌ دائماً null أو تاريخ) في جملةٍ
     * واحدة — لقطةٌ واحدة تحت READ COMMITTED. بـfindMany وعلاقةٍ متداخلة يقرأ Prisma الصنف في استعلامٍ ثانٍ (بلا relationJoins)،
     * فتحويلٌ يلتزم بينهما (يقسم أسعار العميل على F ويغيّر الأساس في معاملةٍ واحدة) يعطي {سعر الكرتون القديم، اسم القارورة}
     * فيعدّه تطبيق المندوب سعر قارورة (×٢٤) ويحفظه في كاشه. و`baseConvertedAt` يفرّق به التطبيق إعادة التسمية (لا تغيّره) عن
     * التحويل ×F. الشروط كما كانت: الشركة والصنف غير المؤرشف */
    const prices = await prisma.$queryRaw<Array<{ productId: string; price: number; unit: string | null; baseConvertedAt: Date | null }>>`
      SELECT cp."productId", cp.price, p.unit, p."baseConvertedAt"
      FROM customer_prices cp JOIN products p ON p.id = cp."productId"
      WHERE cp."customerId" = ${req.params.customerId} AND p."tenantId" = ${tid} AND p."deletedAt" IS NULL`;
    res.json({
      success: true,
      data: prices.map((p) => ({ productId: p.productId, price: Number(p.price), unit: p.unit ?? null, baseConvertedAt: p.baseConvertedAt ?? null })),
    });
  } catch (err) { next(err); }
});

router.get('/categories', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const cats = await prisma.productCategory.findMany({ where: { tenantId: tid }, orderBy: { name: 'asc' } });
    res.json({ success: true, data: cats });
  } catch (err) { next(err); }
});

router.post('/categories', requireAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const data = categorySchema.parse(req.body);
    const cat = await prisma.productCategory.create({ data: { ...data, tenantId: tid } as any });
    res.status(201).json({ success: true, data: cat });
  } catch (err) { next(err); }
});

router.get('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 50;
    const search = req.query.search as string | undefined;
    const categoryId = req.query.categoryId as string | undefined;
    const status = req.query.status as string | undefined;

    const where = {
      tenantId: tid,
      deletedAt: null, // المؤرشف محذوف من كل القوائم — صفه باق لأسماء الفواتير القديمة
      ...(search && {
        OR: [
          { name: { contains: search } },
          { code: { contains: search } },
          { barcode: { contains: search } },
        ],
      }),
      ...(categoryId && { categoryId }),
      ...(status && { status: status as 'ACTIVE' | 'INACTIVE' }),
    };

    const [total, products] = await Promise.all([
      prisma.product.count({ where }),
      prisma.product.findMany({
        where,
        // teams: فرق الصنف («الفرق») — تطبيق المندوب يصفّي بها أصناف فريقه الحالي + العامة
        // units: وحداته النشطة والموقوفة — الموقوفة لعرض مستندٍ صدر بها وإعادة رفعه، ولا تُعرض للبيع
        include: { category: true, priceTiers: { orderBy: { minQty: 'asc' } }, units: UNITS_ORDER, teams: { select: { teamId: true } } },
        ...paginate(page, limit),
        orderBy: { name: 'asc' },
      }),
    ]);

    res.json({ success: true, data: products, pagination: paginationMeta(total, page, limit) });
  } catch (err) { next(err); }
});

router.get('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const product = await prisma.product.findFirst({
      where: { id: req.params.id, tenantId: tid },
      include: { category: true, priceTiers: { orderBy: { minQty: 'asc' } }, units: UNITS_ORDER },
    });
    if (!product) { res.status(404).json({ success: false, message: 'الصنف غير موجود' }); return; }
    res.json({ success: true, data: product });
  } catch (err) { next(err); }
});

/**
 * التصنيف من الشركة نفسها — أو لا تصنيف. بلا هذا يُربط صنفٌ بتصنيف شركةٍ أخرى (المفتاح الأجنبيّ لا يعرف
 * الشركة) فيُقرأ اسمه مع الصنف، أو يفشل معرّفٌ مجهول بخطأ 500 بدل 400.
 */
async function categoryOwned(tid: string, categoryId: string | null | undefined): Promise<boolean> {
  if (!categoryId) return true;
  return (await prisma.productCategory.count({ where: { id: categoryId, tenantId: tid } })) > 0;
}

// ═══ «تتبّع اللوط» للصنف (المواصفة §٤.٢، §٤.١٩، D9، D25) ═══

/**
 * فاعل سجل تدقيق اللوط (LotEvent، المادة ٥٢): جلسة «دخول» المالك أو موظف المنصة موسومةٌ بمُصدِرها لا باسم المدير الذي وُقّع به
 * التوكن (وعد «لا يدخل حسابك إلا مديره»)، والمفتاح بمعرّفه، والإدارة بمعرّفها واسمها.
 */
function lotActorOf(req: AuthRequest): LotEventActor {
  const u = req.user;
  if (isOwnerSession(req)) {
    return u?.byKind === 'STAFF' ? { type: 'STAFF', id: u.by ?? null, name: 'موظف المنصة' } : { type: 'OWNER', id: u?.by ?? null, name: 'الدعم الفني' };
  }
  if (u?.apiKeyId) return { type: 'API_KEY', id: u.apiKeyId, name: u.name ?? null };
  return { type: 'ADMIN', id: u?.id ?? null, name: u?.name ?? null };
}

/** علم الشركة — يُقرأ حين يطلب الجسم **تفعيل** التتبّع وحده (§١٠.١: لا استعلام إضافي في غيره) */
async function lotsAllowed(tid: string): Promise<boolean> {
  const t = await prisma.tenant.findUnique({ where: { id: tid }, select: { lotTrackingEnabled: true } });
  return t?.lotTrackingEnabled === true;
}

const isoOrNull = (d: Date | null | undefined): string | null => (d ? new Date(d).toISOString() : null);

/** رصيدٌ مسمّى للصنف في مكان — qty = Σ الخام الموجب في دلائه (الأساس، D22) — تفاصيل LOT_TRACKING_HAS_BALANCE (D9) */
export interface NamedLotBalance { place: 'WAREHOUSE' | 'VAN'; salesRepId: string | null; lotId: string; lotNumber: string; qty: number; raw: BucketQty }
/** سقف التشغيلات المسرودة في تفاصيل الرفض — والعدد الكامل معها */
const LOT_BALANCES_DETAIL_MAX = 50;

/**
 * أرصدة التشغيلات المسمّاة للصنف في كل الأماكن (D9): المستودع، وكل سيارةٍ لها صفّ لوطٍ للصنف (حركة أو فاتورة أو تسمية) ومنها
 * سيارة المندوب المحذوف. الخام بعد الحقبة من placeViews نفسها وبالكمية الأساسية (D22)؛ «رصيدٌ» = خامٌ موجب > EPS في أي دلو
 * (D9 حرفياً، ودلالة الإطفاء الجماعي نفسها: lotsTrace.namedLotBalances). يُحسب عند الانتقال إلى الإطفاء وحده (ن٢-١٤)، داخل
 * معاملته بعد القفل.
 */
export async function namedLotBalances(tx: LotTx, tid: string, productId: string): Promise<NamedLotBalance[]> {
  const keyRows = await tx.$queryRaw<{ vanKey: string }[]>`
    SELECT "vanKey" FROM van_load_item_lots WHERE "tenantId" = ${tid} AND "productId" = ${productId}
    UNION SELECT "vanKey" FROM invoice_item_lots WHERE "tenantId" = ${tid} AND "productId" = ${productId} AND "vanKey" IS NOT NULL
    UNION SELECT "vanKey" FROM lot_relabels WHERE "tenantId" = ${tid} AND "productId" = ${productId} AND place = 'VAN' AND "vanKey" IS NOT NULL`;
  const vanKeys = [...new Set(keyRows.map((r) => r.vanKey).filter((k): k is string => typeof k === 'string' && k.length > 0))].sort();
  const views = await placeViews(tx, tid, { warehouse: true, vanKeys, productIds: [productId], withTotals: false });
  const out: NamedLotBalance[] = [];
  const collect = (view: PlaceLotView | undefined, place: NamedLotBalance['place'], salesRepId: string | null) => {
    for (const l of view?.lots ?? []) {
      const qty = roundLot(LOT_BUCKETS.reduce((s, b) => s + Math.max(0, l.raw[b]), 0));
      if (qty > LOT_EPS) out.push({ place, salesRepId, lotId: l.lotId, lotNumber: l.meta.lotNumber, qty, raw: { ...l.raw } });
    }
  };
  collect(views.warehouse.get(productId), 'WAREHOUSE', null);
  for (const key of vanKeys) collect(views.vans.get(key)?.get(productId), 'VAN', key);
  return out;
}

/**
 * تفاصيل LOT_TRACKING_HAS_BALANCE للصنف الواحد: `products` بشكل الإطفاء الجماعي نفسه (POST /api/lots/products/tracking) فتعرضهما
 * الواجهة بعارضٍ واحد، و`lots` تفصيلها لكل تشغيلةٍ ومكان (أول LOT_BALANCES_DETAIL_MAX، والعدد في `count`).
 */
export function trackingBalanceDetail(productId: string, name: string | null, balances: NamedLotBalance[]): Record<string, unknown> {
  const warehouse = roundLot(balances.filter((b) => b.place === 'WAREHOUSE').reduce((s, b) => s + b.qty, 0));
  const byVan = new Map<string, number>();
  for (const b of balances) if (b.place === 'VAN' && b.salesRepId) byVan.set(b.salesRepId, (byVan.get(b.salesRepId) ?? 0) + b.qty);
  const vans = [...byVan].map(([salesRepId, qty]) => ({ salesRepId, qty: roundLot(qty) }));
  return {
    productId, updated: 0,
    products: [{ productId, name, warehouse, vans, qty: roundLot(warehouse + vans.reduce((s, v) => s + v.qty, 0)) }],
    count: balances.length, lots: balances.slice(0, LOT_BALANCES_DETAIL_MAX),
  };
}

/** صفّ الصنف المقفل FOR UPDATE في تبديل «تتبّع اللوط» — ومعه ما يحتاجه التعديل المحروس (الأساس والرئيسية ولحظة التحويل) */
interface LotLockedProductRow {
  id: string; name: string; unit: string; lotTracked: boolean; lotTrackedSince: Date | null; primaryUnitId: string | null; baseConvertedAt: Date | null;
}

/**
 * تبديل «تتبّع باللوط» للصنف (§٤.٢، D25) مع بقية حقول التعديل في معاملةٍ واحدة: الطابور قبل المعاملة، ثم صفّ الصنف FOR UPDATE —
 * ينتظر كل عملية لوطٍ تمسكه FOR KEY SHARE (lockLotProducts) ويحجب ما بعدها حتى نلتزم — ثم قفل اللوط. الحالة المقروءة تحت القفل
 * هي المرجع: تبديلٌ متزامن سبقنا إليها ⇒ لا انتقال ولا حدث. التفعيل يبدأ حقبةً جديدة **بعد** الأقفال، فصفوفٌ كتبتها عمليةٌ وزّعت
 * على حقبةٍ سابقة تقع قبلها ولا تدخل الخام (لا سالب مسمّى منها). الإطفاء بأرصدةٍ مسمّاة يتطلب confirmLotBalances وإلا
 * LOT_TRACKING_HAS_BALANCE (D9)، ويُخفي ولا يحذف؛ وإعادة التفعيل حقبةٌ جديدة: المسمّى يصير غير مسمّى حتى يُسمّى. لا تسميات تصحيح
 * (الحقبة تكفي). LotEvent TRACKING_ON/OFF في المعاملة نفسها. null ⇒ الصنف غير موجود.
 */
async function setProductLotTracking(tid: string, productId: string, on: boolean,
  opts: { confirm: boolean; data: Record<string, unknown>; actor: LotEventActor; guard?: (tx: Prisma.TransactionClient, row: LotLockedProductRow) => Promise<void> }) {
  const release = await acquireLotQueue(tid, [productId]);
  try {
    return await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<LotLockedProductRow[]>`
        SELECT id, name, unit, "lotTracked", "lotTrackedSince", "primaryUnitId", "baseConvertedAt" FROM products WHERE id = ${productId} AND "tenantId" = ${tid} FOR UPDATE`;
      const row = rows[0];
      if (!row) return null;
      // قفل اللوط في الاتجاهين — الصفّ مقفلٌ سلفاً فلا FOR KEY SHARE ثانية، والاستشاري يُؤخذ ولو لم يكن الصنف متتبَّعاً بعد
      await lockLotProducts(tx, tid, [productId], { lockedRows: [{ id: row.id, lotTracked: true, lotTrackedSince: row.lotTrackedSince ?? null }] });
      // «الوحدة الرئيسية» (§2.2-هـ): التعديل المحروس (السعر أو الوحدة أو رقعة الرئيسية) على هذا الصفّ المقفل نفسه، قبل الكتابة
      if (opts.guard) await opts.guard(tx, row);
      const moves = (row.lotTracked === true) !== on;
      const data: Record<string, unknown> = { ...opts.data };
      let balances: NamedLotBalance[] = [];
      if (moves) {
        if (!on) {
          balances = await namedLotBalances(tx, tid, productId);
          if (balances.length > 0 && !opts.confirm) {
            throw lotErr('LOT_TRACKING_HAS_BALANCE', {}, trackingBalanceDetail(productId, row.name ?? null, balances));
          }
        }
        data.lotTracked = on;
        if (on) data.lotTrackedSince = new Date(); // بعد الأقفال لا قبلها
      }
      const product = await tx.product.update({ where: { id: productId }, data, include: { category: true, units: UNITS_ORDER } });
      if (moves) {
        await recordLotEvent(tx, {
          tenantId: tid, lotId: null, productId, kind: on ? 'TRACKING_ON' : 'TRACKING_OFF',
          before: { lotTracked: row.lotTracked === true, lotTrackedSince: isoOrNull(row.lotTrackedSince) },
          after: {
            lotTracked: on, lotTrackedSince: isoOrNull(on ? (data.lotTrackedSince as Date) : row.lotTrackedSince),
            ...(!on && { confirmLotBalances: opts.confirm, namedBalances: balances.length }),
          },
          actor: opts.actor,
        });
      }
      return product;
    }, { maxWait: 10_000, timeout: 20_000 }); // D13
  } finally {
    release();
  }
}

/** خطة الإنشاء العكسي بعد التحقق كله (D10) — data بشكل productSchema نفسه (basePrice محسوم)، فيمرّ بالفحوص القائمة كما هي */
interface ReverseCreatePlan {
  data: z.infer<typeof productSchema>;
  units: Array<z.infer<typeof productCreateUnitSchema>>;
  primaryName: string;
}

/**
 * التحقق من الإنشاء العكسي قبل أي كتابة (§2.2-ب): كل وحدة بـunitProblem والأساس وما سبقها بين «الأخريات»، والرئيسية إحداها،
 * وسعر الفرعية الغائب يُشتقّ من سعر الرئيسية الصريح بأربع منازل (derivedBasePrice = خطوة ٥ في convert-base) — فلا سعر صفرياً صامتاً.
 */
function reverseCreatePlan(body: z.infer<typeof productCreateSchema>): ReverseCreatePlan | UnitsRefusal {
  const { units = [], primaryUnitName, basePrice, ...rest } = body;
  const primaryName = String(primaryUnitName ?? '').trim();
  const others: UnitDef[] = [baseAsUnit(rest.unit)];
  for (const u of units) {
    const problem = unitProblem(u, others);
    if (problem) return new UnitsRefusal(400, problem);
    others.push({ name: u.name.trim(), factor: Number(u.factor) });
  }
  const primary = units.find((u) => u.name.trim() === primaryName);
  if (!primary) return new UnitsRefusal(400, PRIMARY_UNIT_INVALID_MSG, 'PRIMARY_UNIT_INVALID');
  let price = basePrice;
  if (price == null) {
    const primaryPrice = priceOrNull(primary.price);
    if (primaryPrice == null) return new UnitsRefusal(400, 'اكتب سعر الوحدة الرئيسية أو سعر الوحدة الفرعية');
    price = derivedBasePrice(primaryPrice, Math.round(primary.factor));
  }
  return { data: { ...rest, basePrice: price }, units, primaryName };
}

/**
 * الإنشاء العكسي الذرّي (D10): الصنف ووحداته ورئيسيّه — وTRACKING_ON حين يُنشأ متتبَّعاً — في معاملةٍ واحدة: فشل إدراج وحدةٍ
 * ⇒ لا صنف. خطوتان لأن صفّ الأب يُدرج قبل أبنائه فلا يُعرف معرّف الرئيسية قبله. سعر الرئيسية يُحفظ صريحاً على وحدته فلا يزحف
 * مع سعر الفرعية المشتقّ، والرئيسية أولى في الترتيب.
 */
async function createWithUnits(tid: string, args: { data: Record<string, unknown> }, plan: ReverseCreatePlan,
  lotStart: { lotTrackedSince: Date } | null, actor: LotEventActor) {
  return prisma.$transaction(async (tx) => {
    const created = await tx.product.create({
      data: {
        ...(args.data as any),
        units: {
          create: plan.units.map((u, i) => ({
            tenantId: tid, name: u.name.trim(), factor: Math.round(u.factor), price: priceOrNull(u.price), unitCode: u.unitCode || null,
            sortOrder: u.name.trim() === plan.primaryName ? 0 : i + 1,
          })),
        },
      },
      include: { units: true },
    });
    const primary = created.units.find((u) => u.name === plan.primaryName);
    if (!primary) throw new UnitsRefusal(400, PRIMARY_UNIT_INVALID_MSG, 'PRIMARY_UNIT_INVALID');
    const product = await tx.product.update({ where: { id: created.id }, data: { primaryUnitId: primary.id }, include: { category: true, units: UNITS_ORDER } });
    if (lotStart) {
      await recordLotEvent(tx, {
        tenantId: tid, lotId: null, productId: created.id, kind: 'TRACKING_ON',
        after: { lotTracked: true, lotTrackedSince: lotStart.lotTrackedSince.toISOString(), created: true }, actor,
      });
    }
    return product;
  });
}

router.post('/', requireAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    // «الوحدة الرئيسية» (D10): التفرّع على primaryUnitName وحده — جسمٌ بلاه يمرّ بالمسار القائم حرفياً (I1)، ومنه جسمٌ فيه units
    // منسوخٌ من ردّ GET: يُتجاهل كما كان. والجسم الموسَّع يُتحقَّق منه كله قبل أي استعلام
    const reverse = req.body?.primaryUnitName != null ? reverseCreatePlan(productCreateSchema.parse(req.body)) : null;
    if (reverse instanceof UnitsRefusal) { res.status(reverse.status).json({ success: false, code: reverse.code, message: reverse.message }); return; }
    const data = reverse ? reverse.data : productSchema.parse(req.body);
    // كود مكرر يفسر بوضوح (خاصة تصادم كود صنف مؤرشف) بدل خطأ unique غامض
    const dupe = await prisma.product.findFirst({ where: { tenantId: tid, code: data.code }, select: { deletedAt: true } });
    if (dupe) {
      res.status(409).json({ success: false, message: dupe.deletedAt ? 'الكود مستخدم بصنف محذوف مؤرشف بفواتيره القديمة استخدم كودا مختلفا' : 'كود الصنف مستخدم من قبل' });
      return;
    }
    const lifeProblem = shelfLifeProblem(data) ?? returnRuleConfigProblem(data);
    if (lifeProblem) { res.status(400).json({ success: false, message: lifeProblem }); return; }
    // «قيود المندوب»: الصنف الجديد بلا وحدات بعد، فلا «كبرى فقط» عند إنشائه — إلا الإنشاء العكسي فوحداته معه (D10)
    const repRules = repRuleWrite(data, null);
    const repProblem = repRuleConfigProblem(repRules.merged, reverse ? reverse.units.map((u) => ({ factor: u.factor, isActive: true })) : null);
    if (repProblem) { res.status(400).json({ success: false, code: 'REP_UNIT_RULE_INVALID', message: repProblem }); return; }
    if (data.taxPct == null) { // وراثة ضريبة دولة الشركة عند عدم تحديدها
      const company = await prisma.companySettings.findUnique({ where: { tenantId: tid }, select: { defaultVatPct: true } });
      data.taxPct = company?.defaultVatPct ?? 15;
    }
    // فوترة ZATCA (Z5.1a): الفئة الضريبية للشركة الجامعة وحدها — لا تُقرأ البوابة إلا إن حمل الجسم حقلاً منها
    const vatGate = await applyProductVatGate(prisma, req.body, tid, { productId: null, taxPct: data.taxPct });
    if (!vatGate.ok) { res.status(vatGate.status).json(vatGate.body); return; }
    if (!(await categoryOwned(tid, data.categoryId))) { res.status(400).json({ success: false, message: 'التصنيف غير موجود' }); return; }
    // «تتبّع اللوط» (§٤.٢): صنفٌ يُنشأ متتبَّعاً يلزمه علم الشركة، وتبدأ حقبته لحظة إنشائه، وTRACKING_ON في معاملة الإنشاء نفسها.
    // صنفٌ جديد لا عملية لوطٍ عليه قبل التزامه فلا قفل ولا طابور. والجسم بلا العلم (أو بـfalse) ⇒ الإنشاء كما كان حرفياً
    const lot = productLotSchema.parse(req.body);
    if (lot.lotTracked === true && !(await lotsAllowed(tid))) { res.status(403).json(lotErrorBody(lotErr('LOTS_NOT_ALLOWED'))); return; }
    const lotStart = lot.lotTracked === true ? { lotTracked: true, lotTrackedSince: new Date() } : null;
    for (const k of REP_RULE_KEYS) delete (data as Record<string, unknown>)[k];
    const createArgs = { data: { ...data, ...vatGate.patch, barcode: data.barcode || null, shelfLifeFromDate: asDay(data.shelfLifeFromDate), categoryId: data.categoryId || null, image: data.image || null, itemCode: data.itemCode || null, unitCode: data.unitCode || null, ...repRules.write, tenantId: tid, ...lotStart } as any, include: { category: true, units: UNITS_ORDER } };
    const product = reverse ? await createWithUnits(tid, createArgs, reverse, lotStart, lotActorOf(req)) : !lotStart
      ? await prisma.product.create(createArgs)
      : await prisma.$transaction(async (tx) => {
        const created = await tx.product.create(createArgs);
        await recordLotEvent(tx, {
          tenantId: tid, lotId: null, productId: created.id, kind: 'TRACKING_ON',
          after: { lotTracked: true, lotTrackedSince: lotStart.lotTrackedSince.toISOString(), created: true }, actor: lotActorOf(req),
        });
        return created;
      });
    res.status(201).json({ success: true, data: product });
  } catch (err) {
    if (err instanceof UnitsRefusal) { res.status(err.status).json({ success: false, code: err.code, message: err.message }); return; }
    if (reverseUniqueViolation(err)) { res.status(409).json({ success: false, message: 'اسم الوحدة مكرر لهذا الصنف' }); return; }
    next(err);
  }
});

/** تصادم اسم وحدةٍ في الإنشاء العكسي (productId+name) — لا يقع بعد unitProblem إلا بسباقٍ نظري، ورسالته كمسارات الوحدات */
const reverseUniqueViolation = (err: unknown): boolean =>
  isUniqueViolation(err) && JSON.stringify((err as { meta?: unknown })?.meta ?? '').includes('name');

router.put('/:id', requireAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  let lotPath = false;
  try {
    const tid = tenantId(req);
    const exists = await prisma.product.findFirst({
      where: { id: req.params.id, tenantId: tid },
      select: {
        id: true, shelfLifeEnabled: true, shelfLifeValue: true, shelfLifeUnit: true, shelfLifeBasis: true, shelfLifeFromDate: true,
        returnRuleEnabled: true, returnRuleMode: true, returnRuleMetric: true, returnRuleValue: true,
        unit: true, units: { select: { name: true, factor: true, isActive: true } },
        lotTracked: true, // «تتبّع اللوط»: الانتقال يُعرف من القراءة نفسها بلا استعلام
        repSaleAllowed: true, repReturnAllowed: true, repSaleUnit: true, repReturnUnit: true,
      },
    });
    if (!exists) { res.status(404).json({ success: false, message: 'الصنف غير موجود' }); return; }
    // productSchema.partial() يُسقط primaryUnitId من الجسم عمداً: رحلة GET ثم PUT لا تكتب قيمةً قديمة (PUT /:id/primary-unit وحده يكتبه)
    const data = productSchema.partial().parse(req.body);
    // «الوحدة الرئيسية» (§2.2-هـ): ما يمسّ الأساس (سعره أو اسمه أو رقعة الرئيسية) يُكتب تحت قفل الصفّ بعد مقارنة الأساس الذي رآه النموذج
    const guard = productEditGuardSchema.parse(req.body ?? {});
    const touchesBase = data.basePrice !== undefined || data.unit !== undefined || guard.primaryUnit != null;
    // اسم الأساس لا يأخذ اسم وحدةٍ أكبر للصنف نفسه: «٢ كرتون» تصير ملتبسة بين الأساس والكرتون
    if (data.unit !== undefined && data.unit.trim() !== exists.unit.trim() && exists.units.some((u) => u.name.trim() === data.unit!.trim())) {
      res.status(400).json({ success: false, message: 'اسم وحدة الأساس مستخدم لوحدة أخرى لهذا الصنف' }); return;
    }
    // الصلاحية تُفحص مدمجةً مع المحفوظ: تفعيلها وحده يلزمه مدةٌ محفوظة من قبل أو مرسلة معه
    const merged = {
      shelfLifeEnabled: data.shelfLifeEnabled ?? exists.shelfLifeEnabled,
      shelfLifeValue: data.shelfLifeValue !== undefined ? data.shelfLifeValue : exists.shelfLifeValue,
      shelfLifeUnit: data.shelfLifeUnit !== undefined ? data.shelfLifeUnit : exists.shelfLifeUnit,
      shelfLifeBasis: data.shelfLifeBasis ?? exists.shelfLifeBasis,
      shelfLifeFromDate: data.shelfLifeFromDate !== undefined ? (data.shelfLifeFromDate || null) : exists.shelfLifeFromDate,
      returnRuleEnabled: data.returnRuleEnabled ?? exists.returnRuleEnabled,
      returnRuleMode: data.returnRuleMode !== undefined ? data.returnRuleMode : exists.returnRuleMode,
      returnRuleMetric: data.returnRuleMetric !== undefined ? data.returnRuleMetric : exists.returnRuleMetric,
      returnRuleValue: data.returnRuleValue !== undefined ? data.returnRuleValue : exists.returnRuleValue,
    };
    const lifeProblem = shelfLifeProblem(merged) ?? returnRuleConfigProblem(merged);
    if (lifeProblem) { res.status(400).json({ success: false, message: lifeProblem }); return; }
    // «قيود المندوب»: مدمجةً مع المحفوظ — «الكبرى فقط» يلزمه وحدةٌ كبرى نشطة، وتغييرها يختم repRulesChangedAt
    const repRules = repRuleWrite(data, exists);
    const newlyLarge = (['SALE', 'RETURN'] as const).some((a) => repUnitRuleOf(repRules.merged, a) === 'LARGE' && repUnitRuleOf(exists, a) !== 'LARGE');
    const repProblem = newlyLarge ? repRuleConfigProblem(repRules.merged, exists.units) : null;
    if (repProblem) { res.status(400).json({ success: false, code: 'REP_UNIT_RULE_INVALID', message: repProblem }); return; }
    // «تتبّع اللوط» (§٤.٢): القيمة المرسلة المختلفة عن المحفوظ وحدها انتقال — وتفعيله وحده يقرأ علم الشركة (§١٠.١)
    const lot = productLotSchema.parse(req.body);
    const lotTo = lot.lotTracked != null && lot.lotTracked !== exists.lotTracked ? lot.lotTracked : null;
    if (lotTo === true && !(await lotsAllowed(tid))) { res.status(403).json(lotErrorBody(lotErr('LOTS_NOT_ALLOWED'))); return; }
    const updateData: Record<string, unknown> = { ...data };
    for (const k of REP_RULE_KEYS) delete updateData[k];
    Object.assign(updateData, repRules.write);
    if ('barcode' in updateData) updateData.barcode = updateData.barcode || null;
    // taxPct الفارغ (حقل مُسح او null من النموذج) يعني «بلا تغيير» لا تصفير النسبة
    if (updateData.taxPct == null) delete updateData.taxPct;
    if ('categoryId' in updateData) updateData.categoryId = updateData.categoryId || null;
    if (!(await categoryOwned(tid, updateData.categoryId as string | null | undefined))) { res.status(400).json({ success: false, message: 'التصنيف غير موجود' }); return; }
    if ('image' in updateData) updateData.image = updateData.image || null;
    if ('itemCode' in updateData) updateData.itemCode = updateData.itemCode || null;
    if ('unitCode' in updateData) updateData.unitCode = updateData.unitCode || null;
    if ('shelfLifeFromDate' in updateData) updateData.shelfLifeFromDate = asDay(data.shelfLifeFromDate);
    // فوترة ZATCA (Z5.1a): الفئة الضريبية للشركة الجامعة وحدها — على الحالة المدمجة مع المحفوظ والنسبة التي ستُحفظ
    const vatGate = await applyProductVatGate(prisma, req.body, tid, { productId: req.params.id, taxPct: updateData.taxPct as number | undefined });
    if (!vatGate.ok) { res.status(vatGate.status).json(vatGate.body); return; }
    Object.assign(updateData, vatGate.patch);
    if (lotTo !== null) {
      // الانتقال وبقية الحقول في معاملة القفل نفسها (setProductLotTracking) — والردّ بشكل التعديل العادي نفسه
      lotPath = true;
      const editGuard = touchesBase
        ? async (tx: Prisma.TransactionClient, row: LotLockedProductRow) => {
          const units = await tx.productUnit.findMany({ where: { productId: row.id, tenantId: tid }, select: { id: true, name: true, factor: true, price: true, isActive: true } });
          await guardProductEdit(tx, req, tid, { ...row, units }, { guard, newUnit: data.unit, seenUnit: exists.unit });
        }
        : undefined;
      const tracked = await setProductLotTracking(tid, req.params.id, lotTo, { confirm: lot.confirmLotBalances === true, data: updateData, actor: lotActorOf(req), ...(editGuard && { guard: editGuard }) });
      if (!tracked) { res.status(404).json({ success: false, message: 'الصنف غير موجود' }); return; }
      res.json({ success: true, data: tracked });
      return;
    }
    if (touchesBase) {
      // التعديل المحروس (§2.2-هـ): قفل التعديل ثم الخطوات ٢–٦ ثم الكتابة، في معاملةٍ واحدة
      const guarded = await prisma.$transaction(async (tx) => {
        const locked = await lockProductForEdit(tx, tid, req.params.id);
        if (!locked) throw new UnitsRefusal(404, 'الصنف غير موجود', 'PRODUCT_NOT_FOUND');
        await guardProductEdit(tx, req, tid, locked, { guard, newUnit: data.unit, seenUnit: exists.unit });
        return tx.product.update({ where: { id: req.params.id }, data: updateData, include: { category: true, units: UNITS_ORDER } });
      }, { maxWait: 10_000, timeout: 20_000 });
      res.json({ success: true, data: guarded });
      return;
    }
    const product = await prisma.product.update({
      where: { id: req.params.id },
      data: updateData,
      // الوحدات مع الردّ: الواجهة تستبدل صفّ الصنف بما يعود، فبلاها تختفي وحداته من الشاشة حتى إعادة التحميل
      include: { category: true, units: UNITS_ORDER },
    });
    res.json({ success: true, data: product });
  } catch (err) {
    // التعديل المحروس في المسارين: الرفض برمزه، ومنه انتظار قفل الصنف خلف تحويلٍ طويل ⇒ 503 PRODUCT_UNITS_BUSY (من lockProductForEdit
    // وحده). وانشغالٌ آخر في المعاملة (قاعدةٌ بطيئة، تعطّل متبادل) ليس «وحدات الصنف قيد التحويل»: يمرّ إلى المعالج العام كما كان
    if (err instanceof UnitsRefusal) { res.status(err.status).json({ success: false, code: err.code, message: err.message }); return; }
    // مسار الانتقال وحده: LotError (LOT_TRACKING_HAS_BALANCE…) والانشغال (55P03، 40P01، P2028، الطابور) ⇒ 503 LOT_BUSY
    const lh = lotPath ? lotHttpError(err) : null;
    if (lh) { res.status(lh.status).json(lh.body); return; }
    next(err);
  }
});

router.delete('/:id', requireAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const product = await prisma.product.findFirst({ where: { id: req.params.id, tenantId: tid }, select: { id: true } });
    if (!product) { res.status(404).json({ success: false, message: 'الصنف غير موجود' }); return; }

    // صنف له أثر مالي/مخزني — أو تشغيلة (§٤.١٩: ProductLot يمنع حذفه، Restrict) — يؤرشف لا يمحى: يختفي من كل القوائم ولا
    // يباع مجددا، ويبقى صفه باسمه حيا فتعرضه الفواتير والسندات والكشوف القديمة وتقارير المبيعات حسب الصنف وشاشة التتبّع كما
    // كانت حرفيا. العدّ والحذف في معاملة واحدة بعد قفل صفّ الصنف FOR UPDATE: بندٌ أو حركةٌ أو تشغيلةٌ تُكتب بين العدّ والحذف
    // تنتظر القفل (فحص مفتاحها الأجنبي يأخذ FOR KEY SHARE على الصنف، وكل عملية لوطٍ كذلك)، فلا يُمحى صنفٌ صار له أثر
    const archived = await prisma.$transaction(async (tx) => {
      // انتظار القفل بمهلةٍ محلية تُحفظ وتُستعاد (نمط lockLotProducts): من يمسك الصفّ أطول منها (convert-base حتى ١٢٠ ثانية،
      // أو عملية لوطٍ حتى ٢٠) ⇒ 55P03 ⇒ 503 LOT_BUSY مبكراً، لا انتظار مهلة المعاملة ثم 500
      const prev = await tx.$queryRaw<{ lock_timeout: string }[]>`SELECT current_setting('lock_timeout') AS lock_timeout`;
      await tx.$executeRaw`SELECT set_config('lock_timeout', ${LOT_LOCK_TIMEOUT}, true)`;
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM products WHERE id = ${req.params.id} AND "tenantId" = ${tid} FOR UPDATE`;
      await tx.$executeRaw`SELECT set_config('lock_timeout', ${prev[0]?.lock_timeout ?? '0'}, true)`;
      return locked.length ? deleteOrArchiveLocked(tx, req) : null;
    }, { maxWait: 10_000, timeout: 20_000 }); // قد ينتظر القفلُ عمليةَ لوطٍ جارية (D13)
    if (archived === null) { res.status(404).json({ success: false, message: 'الصنف غير موجود' }); return; }
    res.json({ success: true, archived });
  } catch (err) {
    // الانشغال (55P03، 40P01، أو P2028 مهلة المعاملة) ⇒ 503 LOT_BUSY «أعد المحاولة» (D14) لا 500 برسالةٍ داخلية
    const busy = asLotBusy(err);
    if (busy) { res.status(busy.status).json(lotErrorBody(busy)); return; }
    next(err);
  }
});

/**
 * حذف الصنف أو أرشفته **بعد** قفل صفّه FOR UPDATE داخل معاملة الحذف (§٤.١٩) — `prisma` هنا عميل المعاملة. العدّ على بنود الصنف
 * بمعرّفه (بند الإشعار المدين بلا صنف لا يُعدّ)، ومعه تشغيلاته: ProductLot يمنع حذفه (Restrict) فصنفٌ له تشغيلة يُؤرشف.
 */
async function deleteOrArchiveLocked(prisma: Prisma.TransactionClient, req: AuthRequest): Promise<boolean> {
  const invoiceItems = await prisma.invoiceItem.count({ where: { productId: req.params.id } });
  const loadItems = await prisma.vanLoadItem.count({ where: { productId: req.params.id } });
  const warehouseItems = await prisma.warehouseEntryItem.count({ where: { productId: req.params.id } });
  const lots = await prisma.productLot.count({ where: { productId: req.params.id } });
  await prisma.priceTier.deleteMany({ where: { productId: req.params.id } });
  await prisma.customerPrice.deleteMany({ where: { productId: req.params.id } });
  if (invoiceItems > 0 || loadItems > 0 || warehouseItems > 0 || lots > 0) {
    await prisma.product.update({ where: { id: req.params.id }, data: { deletedAt: new Date(), status: 'INACTIVE' } });
    return true;
  }
  // بلا أي أثر: حذف فعلي مع بيانات التسعير التابعة
  await prisma.product.delete({ where: { id: req.params.id } });
  return false;
}

router.put('/:id/price-tiers', requireAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const exists = await prisma.product.findFirst({ where: { id: req.params.id, tenantId: tid }, select: { id: true } });
    if (!exists) { res.status(404).json({ success: false, message: 'الصنف غير موجود' }); return; }
    const tiers = priceTierSchema.parse(req.body.tiers);
    const tg = tierGuardSchema.parse(req.body ?? {});
    await prisma.$transaction(async (tx) => {
      // بقفل صفّ الصنف كالتحويل: شرائح بحدودٍ على الأساس القديم لا تلتزم بعد تحويله فتُقرأ على الجديد
      const locked = await lockProductForUnits(tx, tid, req.params.id);
      if (!locked) throw new UnitsRefusal(404, 'الصنف غير موجود', 'PRODUCT_NOT_FOUND');
      assertExpectedBase(req, locked, tg.expectedBaseName);
      // حدودٌ أُدخلت بالرئيسية (/m): الرئيسية ومعاملها الآن كما حُسبت عليهما — لا حدود على كرتون ٢٤ بعد أن صار ١٢
      if (tg.expectedPrimary) {
        const primary = primaryUnitOf(locked);
        if (!primary || primary.id !== tg.expectedPrimary.id || Math.abs(Number(primary.factor) - tg.expectedPrimary.factor) > QTY_EPS) {
          throw new UnitsRefusal(409, PRIMARY_UNIT_CHANGED_MSG, 'PRIMARY_UNIT_CHANGED');
        }
      }
      await tx.priceTier.deleteMany({ where: { productId: req.params.id } });
      // العمودان معاً (القاعدة ٥): الحدود بالأساس للحساب، والقديمان للعرض القائم. والكمية المرسلة بوحدة الأساس الحالية
      for (const t of tiers) {
        await tx.priceTier.create({
          data: {
            productId: req.params.id, minQty: t.minQty, maxQty: t.maxQty ?? null, price: t.price,
            baseMinQty: t.baseMinQty ?? t.minQty,
            baseMaxQty: t.baseMaxQty !== undefined ? t.baseMaxQty : (t.maxQty ?? null),
          },
        });
      }
      // الشرائح بلا طابع تعديل وتُضمَّن في الصنف — فتغييرها تغييرٌ للصنف تراه مزامنة ERP و/api/v1/sync
      await touchProduct(tx, tid, req.params.id);
    }, BASE_GUARD_TX); // I10: مهلة المعاملة أطول من مهلة القفل
    res.json({ success: true });
  } catch (err) {
    if (err instanceof UnitsRefusal) { res.status(err.status).json({ success: false, code: err.code, message: err.message }); return; }
    next(err);
  }
});

// ═══ وحدات الصنف (DESIGN.md «عقد الـAPI») — الكتابة للإدارة بصلاحية الأصناف كبقيّة كتابات الصنف ═══

router.post('/:id/units', requireAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const data = unitCreateSchema.parse(req.body);
    const unit = await prisma.$transaction(async (tx) => {
      const product = await lockProductForUnits(tx, tid, req.params.id);
      if (!product) throw new UnitsRefusal(404, 'الصنف غير موجود', 'PRODUCT_NOT_FOUND');
      assertExpectedBase(req, product, data.expectedBaseName);
      // الأساس بين «الأخريات»: لا وحدة باسمه، ولا وحدة بمعامل ١ (هي الأساس نفسه)
      const problem = unitProblem(data, [baseAsUnit(product.unit), ...product.units]);
      if (problem) throw new UnitsRefusal(400, problem);
      const created = await tx.productUnit.create({
        data: {
          tenantId: tid, productId: product.id, name: data.name.trim(),
          // المعامل صحيحٌ تحقّق منه unitProblem — يُخزَّن مقرَّباً فلا يحمل غبار العائمة إلى كل لقطة
          factor: Math.round(Number(data.factor)),
          price: priceOrNull(data.price), unitCode: data.unitCode || null, sortOrder: data.sortOrder ?? 0,
        },
      });
      // «اجعلها الرئيسية» مع الإضافة: المعامل صحيحٌ ≥ ٢ تحقّق منه unitProblem (الأساس بمعامل ١ بين الأخريات)، وطابع الصنف معه
      if (data.makePrimary === true) {
        await tx.product.updateMany({ where: { id: product.id, tenantId: tid }, data: { primaryUnitId: created.id, updatedAt: new Date() } });
      } else {
        await touchProduct(tx, tid, product.id);
      }
      return created;
    }, BASE_GUARD_TX);
    res.status(201).json({ success: true, data: unit });
  } catch (err) {
    if (err instanceof UnitsRefusal) { res.status(err.status).json({ success: false, code: err.code, message: err.message }); return; }
    if (isUniqueViolation(err)) { res.status(409).json({ success: false, message: 'اسم الوحدة مكرر لهذا الصنف' }); return; }
    next(err);
  }
});

/**
 * تعديل وحدة: اسمها ومعاملها وسعرها ورمزها وإيقافها وترتيبها.
 *
 * تغيير المعامل لا يمسّ ما مضى: كل صفٍّ كُتب بالوحدة يحمل لقطة معامله (unitFields)، فكرتونٌ صار ١٢ بعد أن كان ٢٤
 * لا يُنقص مخزون شهرٍ مضى. والإيقاف يحجبها عن البيع الجديد ولا يُسقط مستنداً أوف-لاين صدر بها (القاعدة ٧).
 */
router.put('/:id/units/:unitId', requireAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const data = unitUpdateSchema.parse(req.body);
    const unit = await prisma.$transaction(async (tx) => {
      const product = await lockProductForUnits(tx, tid, req.params.id);
      if (!product) throw new UnitsRefusal(404, 'الصنف غير موجود', 'PRODUCT_NOT_FOUND');
      const current = product.units.find((u) => u.id === req.params.unitId);
      if (!current) throw new UnitsRefusal(404, 'الوحدة غير موجودة', 'UNIT_NOT_FOUND');
      assertExpectedBase(req, product, data.expectedBaseName);
      // D13: إيقاف الرئيسية بصمتٍ يقلب افتراض المندوب من كرتون إلى قارورة دون أن يعلم أحد — إلا مع clearPrimary صريح
      const isPrimary = product.primaryUnitId != null && product.primaryUnitId === current.id;
      if (isPrimary && data.isActive === false && data.clearPrimary !== true) {
        throw new UnitsRefusal(409, PRIMARY_UNIT_IN_USE_MSG, 'PRIMARY_UNIT_IN_USE');
      }
      const merged = {
        name: data.name ?? current.name,
        factor: data.factor ?? current.factor,
        price: data.price !== undefined ? data.price : current.price,
      };
      const problem = unitProblem(merged, [baseAsUnit(product.unit), ...product.units.filter((u) => u.id !== current.id)]);
      if (problem) throw new UnitsRefusal(400, problem);
      refuseLargeRuleWithout(product, product.units.map((u) => (u.id === current.id
        ? { factor: Number(merged.factor), isActive: data.isActive ?? u.isActive } : u)));
      await tx.productUnit.updateMany({
        where: { id: current.id, productId: product.id, tenantId: tid },
        data: {
          ...(data.name !== undefined && { name: data.name.trim() }),
          ...(data.factor !== undefined && { factor: Math.round(Number(data.factor)) }),
          ...(data.price !== undefined && { price: priceOrNull(data.price) }),
          ...(data.unitCode !== undefined && { unitCode: data.unitCode || null }),
          ...(data.isActive !== undefined && { isActive: data.isActive }),
          ...(data.sortOrder !== undefined && { sortOrder: data.sortOrder }),
        },
      });
      if (isPrimary && data.clearPrimary === true) {
        await tx.product.updateMany({ where: { id: product.id, tenantId: tid }, data: { primaryUnitId: null, updatedAt: new Date() } });
      } else {
        await touchProduct(tx, tid, product.id);
      }
      return tx.productUnit.findFirst({ where: { id: current.id, productId: product.id, tenantId: tid } });
    }, BASE_GUARD_TX);
    res.json({ success: true, data: unit });
  } catch (err) {
    if (err instanceof UnitsRefusal) { res.status(err.status).json({ success: false, code: err.code, message: err.message }); return; }
    if (isUniqueViolation(err)) { res.status(409).json({ success: false, message: 'اسم الوحدة مكرر لهذا الصنف' }); return; }
    next(err);
  }
});

/** حذفٌ فعليّ: الصفوف تحمل لقطة وحدتها (الاسم والمعامل) فلا ينكسر مستندٌ ولا مخزونٌ مضى، وإعادة الرفع تتحقّق من التاريخ */
router.delete('/:id/units/:unitId', requireAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    await prisma.$transaction(async (tx) => {
      const product = await lockProductForUnits(tx, tid, req.params.id);
      if (!product) throw new UnitsRefusal(404, 'الصنف غير موجود', 'PRODUCT_NOT_FOUND');
      // الحذف بلا جسم: الأساس المتوقَّع (اختياري، وإلزامي لمفتاح API على صنفٍ حُوِّل — D19) من الاستعلام كإذن الرئيسية
      assertExpectedBase(req, product, typeof req.query.expectedBaseName === 'string' ? req.query.expectedBaseName : undefined);
      // D13: حذف الرئيسية كإيقافها — الإذن من الاستعلام ?clearPrimary=1
      const isPrimary = product.primaryUnitId != null && product.primaryUnitId === req.params.unitId;
      const clearPrimary = req.query.clearPrimary === '1' || req.query.clearPrimary === 'true';
      if (isPrimary && !clearPrimary) throw new UnitsRefusal(409, PRIMARY_UNIT_IN_USE_MSG, 'PRIMARY_UNIT_IN_USE');
      refuseLargeRuleWithout(product, product.units.filter((u) => u.id !== req.params.unitId));
      const gone = await tx.productUnit.deleteMany({ where: { id: req.params.unitId, productId: product.id, tenantId: tid } });
      if (gone.count === 0) throw new UnitsRefusal(404, 'الوحدة غير موجودة', 'UNIT_NOT_FOUND');
      if (isPrimary) {
        await tx.product.updateMany({ where: { id: product.id, tenantId: tid }, data: { primaryUnitId: null, updatedAt: new Date() } });
      } else {
        await touchProduct(tx, tid, product.id);
      }
    }, BASE_GUARD_TX);
    res.json({ success: true });
  } catch (err) {
    if (err instanceof UnitsRefusal) { res.status(err.status).json({ success: false, code: err.code, message: err.message }); return; }
    next(err);
  }
});

/**
 * تبديل الوحدة الرئيسية لصنفٍ قائم (D11): مجرّد علم — لا قفل تاريخ ولا ترحيل ولا إعادة كتابة. القفل يرتّبه مع كتّاب الوحدات
 * والتحويل فلا يُشار إلى وحدةٍ أُوقفت أو حُذفت للتوّ. unitId = null يلغي الرئيسية (سلوك ما قبل الميزة). مفاتيح API مسموح لها.
 */
router.put('/:id/primary-unit', requireAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const body = primaryUnitSchema.parse(req.body);
    // المفتاح حاضرٌ في الجسم (ولو null) ⇒ يُقارن: null المتوقَّعة تعني «لم تكن له رئيسية»
    const checkExpected = Object.prototype.hasOwnProperty.call(req.body ?? {}, 'expectedPrimaryUnitId');
    const product = await prisma.$transaction(async (tx) => {
      const locked = await lockProductForUnits(tx, tid, req.params.id);
      if (!locked) throw new UnitsRefusal(404, 'الصنف غير موجود', 'PRODUCT_NOT_FOUND');
      if (checkExpected && (body.expectedPrimaryUnitId ?? null) !== (locked.primaryUnitId ?? null)) {
        throw new UnitsRefusal(409, PRIMARY_UNIT_CHANGED_MSG, 'PRIMARY_UNIT_CHANGED');
      }
      // وحدةٌ نشطة من وحدات هذا الصنف بمعاملٍ صحيح ≥ ٢ — المعيار نفسه الذي يقرأ به كل مستهلكٍ الرئيسية (primaryUnitOf)
      if (body.unitId !== null && !primaryUnitOf({ primaryUnitId: body.unitId, units: locked.units })) {
        throw new UnitsRefusal(400, PRIMARY_UNIT_INVALID_MSG, 'PRIMARY_UNIT_INVALID');
      }
      return tx.product.update({
        where: { id: locked.id },
        data: { primaryUnitId: body.unitId }, // @updatedAt يتحرّك فتراه المزامنة وERP
        include: { category: true, priceTiers: { orderBy: { minQty: 'asc' } }, units: UNITS_ORDER },
      });
    }, BASE_GUARD_TX);
    res.json({ success: true, data: product });
  } catch (err) {
    if (err instanceof UnitsRefusal) { res.status(err.status).json({ success: false, code: err.code, message: err.message }); return; }
    next(err);
  }
});

/** D19-أ: مفاتيح API الشركة غير الملغاة المستعملة في آخر API_KEY_ACTIVE_DAYS يوماً — للكتابة وللقراءة */
async function activeApiKeys(tid: string): Promise<{ write: number; readOnly: number }> {
  const since = new Date(Date.now() - API_KEY_ACTIVE_DAYS * 86_400_000);
  const groups = await prisma.apiKey.groupBy({ by: ['readOnly'], where: { tenantId: tid, revokedAt: null, lastUsedAt: { gte: since } }, _count: { _all: true } });
  let write = 0;
  let readOnly = 0;
  for (const g of groups ?? []) {
    const n = Number(g._count?._all) || 0;
    if (g.readOnly) readOnly += n; else write += n;
  }
  return { write, readOnly };
}

/**
 * رفض التحويل البنيوي على صفّ الصنف — مشتركٌ بين المعاينة (بلا قفل) والتحويل (تحت القفل)، بالترتيب نفسه: الأساس المتوقَّع،
 * ثم «قيود المندوب»، ثم المعامل والاسم، ثم الاسم المتقاعد
 */
async function convertBaseRefusalOn(db: Prisma.TransactionClient, tid: string,
  product: { id: string; unit: string; baseConvertedAt: Date | null; repSaleUnit: string; repReturnUnit: string; units: Array<{ name: string; factor: number }> },
  body: z.infer<typeof convertBaseSchema>): Promise<void> {
  // ١. التحويل المزدوج: ما رآه الطالب ليس الأساس الآن ⇒ حُوّل قبله (أو عُدّل) — لا يُضرب بـF ثانيةً
  if (baseNameKey(product.unit) !== baseNameKey(body.expectedBaseName)) {
    throw new UnitsRefusal(409, `وحدة الأساس الآن «${product.unit}» — تغيّرت منذ فتحت التحويل، أعد فتح الصنف`, 'BASE_UNIT_CHANGED');
  }
  // «قيود المندوب»: التحويل يقلب معنى «الصغرى» و«الكبرى» (الأساس القديم يصير وحدةً كبرى) — يُزال القيد قبله صراحةً
  if (repUnitRuleOf(product, 'SALE') !== 'ANY' || repUnitRuleOf(product, 'RETURN') !== 'ANY') {
    throw new UnitsRefusal(409, 'أزل قيد وحدة المندوب (البيع أو المرتجع) قبل تحويل وحدة الأساس — التحويل يغير معنى الصغرى والكبرى', 'REP_UNIT_RULE_SET');
  }
  const problem = baseConversionProblem(product, body);
  if (problem) throw new UnitsRefusal(400, problem);
  // D20-ب: الاسم المتقاعد لا يعود أساساً (يُسأل السجلّ لصنفٍ حُوِّل وحده، I8)
  if (await isRetiredBaseName(db, tid, product.id, product.baseConvertedAt, body.newBaseName)) {
    throw new UnitsRefusal(409, retiredBaseMsg(body.newBaseName.trim()), 'BASE_NAME_RETIRED');
  }
  // لقطات التاريخ تُضرب بـF كالوحدات القائمة، وbaseConversionProblem يحدّ القائمة وحدها: وحدةٌ حُذفت أو تغيّر معاملها تبقى لقطتها
  // في الصفوف، فتتجاوز MAX_UNIT_FACTOR بعد الضرب ويرمي كل ما ينسخ اللقطة بعدها (إشعارٌ دائن بوحدة البند ⇒ 500 على فاتورةٍ قديمة)
  const over = await historyFactorOver(db, tid, product.id, Math.round(Number(body.factor)));
  if (over !== null) throw new UnitsRefusal(400, `معامل وحدة «${over}» في تاريخ الصنف يتجاوز ${MAX_UNIT_FACTOR} بعد الإضافة`);
}

/**
 * أكبر لقطة معاملٍ في تاريخ الصنف (الجداول الأربعة التي يضربها التحويل، والشركة شرطٌ عبر رأس المستند كجمل التحويل نفسها)
 * تتجاوز الحدّ بعد ضربها بـF ⇒ اسمها، وإلا null. قراءةٌ بلا كتابة ولا جملة خام — للمعاينة والتحويل تحت قفله معاً
 */
async function historyFactorOver(db: Prisma.TransactionClient, tid: string, pid: string, F: number): Promise<string | null> {
  const over = { gt: MAX_UNIT_FACTOR / F };
  const pick = { select: { unitName: true, unitFactor: true }, orderBy: { unitFactor: 'desc' as const } };
  const rows = await Promise.all([
    db.invoiceItem.findFirst({ where: { productId: pid, invoice: { tenantId: tid }, unitFactor: over }, ...pick }),
    db.vanLoadItem.findFirst({ where: { productId: pid, vanLoad: { tenantId: tid }, unitFactor: over }, ...pick }),
    db.warehouseEntryItem.findFirst({ where: { productId: pid, entry: { tenantId: tid }, unitFactor: over }, ...pick }),
    db.repStockRequestItem.findFirst({ where: { productId: pid, request: { tenantId: tid }, unitFactor: over }, ...pick }),
  ]);
  const top = rows.filter((r): r is { unitName: string | null; unitFactor: number } => !!r).sort((a, b) => b.unitFactor - a.unitFactor)[0];
  return top ? (top.unitName?.trim() || '؟') : null;
}

/**
 * الرئيسية بعد التحويل: القائمة الصالحة تبقى بمعرّفها (معاملها يُضرب بـF)، وإلا الوحدة القديمة ما لم يُطلب غير ذلك (D12).
 * «صالحة» بـprimaryUnitOf: معرّفٌ معلَّق أو وحدةٌ تالفة لا تحجب جعل القديمة رئيسية.
 */
function primaryAfterConversion(product: { unit: string; primaryUnitId: string | null; units: UnitDef[] }, keep: boolean | undefined): string | null {
  return primaryUnitOf(product)?.name ?? (keep !== false ? product.unit : null);
}

/**
 * معاينة التحويل (dryRun): لا معاملة ولا قفل ولا كتابة. الرفض البنيوي نفسه، والعدّ بشروط WHERE التي تكتب بها جمل التحويل.
 */
async function convertBasePreview(tid: string, productId: string, body: z.infer<typeof convertBaseSchema>, erpLinked: boolean, apiKeys: { write: number; readOnly: number }) {
  const product = await prisma.product.findFirst({
    where: { id: productId, tenantId: tid },
    select: {
      id: true, unit: true, primaryUnitId: true, baseConvertedAt: true, repSaleUnit: true, repReturnUnit: true,
      units: { select: { id: true, name: true, factor: true, isActive: true } },
    },
  });
  if (!product) throw new UnitsRefusal(404, 'الصنف غير موجود', 'PRODUCT_NOT_FOUND');
  await convertBaseRefusalOn(prisma, tid, product, body);
  const pid = product.id;
  const [invoiceItems, vanLoadItems, warehouseEntryItems, stockRequestItems, customerPrices, priceTiers, vanLoadItemLots, invoiceItemLots, lotRelabels] = await Promise.all([
    prisma.invoiceItem.count({ where: { productId: pid, invoice: { tenantId: tid } } }),
    prisma.vanLoadItem.count({ where: { productId: pid, vanLoad: { tenantId: tid } } }),
    prisma.warehouseEntryItem.count({ where: { productId: pid, entry: { tenantId: tid } } }),
    prisma.repStockRequestItem.count({ where: { productId: pid, request: { tenantId: tid } } }),
    prisma.customerPrice.count({ where: { productId: pid, product: { tenantId: tid } } }),
    prisma.priceTier.count({ where: { productId: pid, product: { tenantId: tid } } }),
    prisma.vanLoadItemLot.count({ where: { tenantId: tid, productId: pid } }),
    prisma.invoiceItemLot.count({ where: { tenantId: tid, productId: pid } }),
    prisma.lotRelabel.count({ where: { tenantId: tid, productId: pid } }),
  ]);
  return {
    success: true, dryRun: true, erpLinked, apiKeys,
    primaryAfter: primaryAfterConversion(product, body.keepOldBaseAsPrimary),
    converted: {
      factor: Math.round(body.factor), from: product.unit, invoiceItems, vanLoadItems, warehouseEntryItems, stockRequestItems, customerPrices, priceTiers,
      ...(vanLoadItemLots + invoiceItemLots + lotRelabels > 0 && { vanLoadItemLots, invoiceItemLots, lotRelabels }),
    },
  };
}

/**
 * تحويل وحدة الأساس إلى أصغر منها (كرتون ⇒ حبة، F = ٢٤) لصنفٍ له تاريخ — DESIGN.md «عقد الـAPI» بخطواته الخمس.
 *
 * ═══ لماذا لا يكفي تعديل اسم الوحدة ═══
 * كل صفٍّ قديم كُتب بالكرتون يحمل `unitFactor = 1` (الكرتون كان الأساس). لو صار الأساس «حبة» بتعديل الاسم لقُرئت
 * مبيعات سنةٍ وتحميلاتها ومخزون السيارات حبّاتٍ لا كراتين: خطأ ٢٤ ضعفاً في كل رصيدٍ وتقرير. فالتحويل يعيد كتابة
 * **اللقطة** لا الكمية: كل صفٍّ يأخذ اسم وحدته القديمة ومعاملها مضروباً بـF، فيبقى «٢ كرتون» مطبوعاً كما هو ويصير
 * أساسه ٤٨ حبة. والأسعار المخزَّنة لوحدة الأساس (سعر العميل والشرائح) تُقسم على F فيبقى سعر الكرتون للعميل كما هو.
 *
 * ═══ لماذا معاملةٌ واحدة بقفل صفّ الصنف ═══
 * خطوةٌ تلتزم وأخرى تفشل = تاريخٌ نصفه بأساسٍ ونصفه بآخر، ولا سبيل لمعرفة أيّ الصفوف حُوّل. والقفل يمنع تحويلين
 * متزامنين (ومعه `expectedBaseName`: نقرةٌ ثانية بعد التزام الأولى تُردّ 409 لا تضرب بـF مرّتين)، ويرتّبه مع إصدار
 * الفواتير الذي يقفل صفوف أصنافه قفلاً مشتركاً (routes/invoices.ts).
 */
router.post('/:id/convert-base', requireAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  let marked: { tid: string; pid: string } | null = null;
  try {
    /* «إضافة وحدة فرعية أصغر» (مواصفة الوحدة الرئيسية §3، D14، D15): من يُسمح له — قبل الجسم.
     *
     * كان التحويل بجلسة المالك (الدعم الفني) وحدها (قرار المالك ٣٠ أكتوبر)، لأن العنقود الباقي من المراجعة العدائية (سباق
     * «تحويل الأساس» في مسارات المخزون والإشعار الدائن والأوف‑لاين) لا ينشأ إلّا من هذا الزرّ. تُكمَل الحماية في §3، ثم يُفتح
     * لمديري الشركة خلف بوابتين معاً: بوابة الإطلاق في الكود، وعلم الشركة يقلبه المالك. أيّهما مغلقة ⇒ جلسة المالك وحدها كما
     * كان (OWNER_ONLY). والمفتاح لا يحوّل أبداً. والحارس في الخادم — المرجع — لا في الزرّ وحده (services/convertBaseAccess.ts). */
    const refusal = await convertBaseRefusalFor(req);
    if (refusal) { res.status(refusal.status).json({ success: false, code: refusal.code, message: refusal.message }); return; }
    const tid = tenantId(req);
    const body = convertBaseSchema.parse(req.body);
    const newName = body.newBaseName.trim();
    /* ERP بوحدة واحدة (§2.2-ز): ما سبق التحويل هناك بالوحدة القديمة وما بعده بالجديدة، ولا إعادة دفع — إقرارٌ صريح.
     * ومفاتيح API النشطة (D19-أ): المتكامل يقرأ بعده الكميات والأسعار بالوحدة الجديدة — يُبلَّغ ثم يُقَرّ. والمعاينة تعيد الاثنين */
    const erpLinked = (await prisma.tenant.findUnique({ where: { id: tid }, select: { erpEnabled: true } }))?.erpEnabled === true
      && !!(await prisma.erpIntegration.findFirst({ where: { tenantId: tid, enabled: true }, select: { id: true } }));
    if (erpLinked && !body.dryRun && body.acknowledgeErp !== true) {
      res.status(409).json({
        success: false, code: 'CONVERT_BASE_ERP_ACK', erpLinked,
        message: `الصنف مربوط بنظام ERP بوحدة واحدة: ما سبق التحويل بـ«${body.expectedBaseName.trim()}» وما بعده بـ«${newName}» هناك — أكّد للمتابعة`,
      });
      return;
    }
    const apiKeys = await activeApiKeys(tid);
    const keyCount = apiKeys.write + apiKeys.readOnly;
    if (keyCount > 0 && !body.dryRun && body.acknowledgeApi !== true) {
      res.status(409).json({
        success: false, code: 'CONVERT_BASE_API_ACK', apiKeys,
        message: `للشركة ربط برمجي نشط (${keyCount} مفتاح): بعد الإضافة تُقرأ كمياته وأسعاره بـ«${newName}» — أبلغ المتكامل ثم أكّد`,
      });
      return;
    }
    if (body.dryRun) { res.json(await convertBasePreview(tid, String(req.params.id), body, erpLinked, apiKeys)); return; }
    // I10: سجلّ «قيد التحويل» في ذاكرة العملية — إسراعٌ يردّ به إصدار المرحلة الثانية قبل الـmutex، والقفل بمهلته هو الضامن
    marked = { tid, pid: String(req.params.id) };
    markConverting(marked.tid, marked.pid);
    const result = await prisma.$transaction(async (tx) => {
      const product = await lockProduct(tx, tid, req.params.id);
      if (!product) throw new UnitsRefusal(404, 'الصنف غير موجود', 'PRODUCT_NOT_FOUND');
      // ١. الأساس المتوقَّع، و«قيود المندوب»، والمعامل والاسم، والاسم المتقاعد — كالمعاينة حرفياً، تحت القفل
      await convertBaseRefusalOn(tx, tid, product, body);
      const F = Math.round(body.factor);
      const oldUnit = product.unit;
      const pid = product.id;

      /* «تتبّع اللوط» (R8، §٣.١): قفل اللوط للصنف بعد صفّه المقفل FOR UPDATE وقبل أيّ كتابة — الترتيب المنصوص «صفوف الأصناف
       * (FOR UPDATE في convert-base) ← أقفال lot». فلا تتداخل عمليةُ لوطٍ (تقرأ رصيد الصنف بالأساس وصفوف لوطه) مع إعادة
       * كتابة الأساس. والصفّ المقفل يُمرَّر فلا يُقرأ ثانيةً؛ والقفل الاستشاري للصنف المتتبَّع الآن وحده كبقية المسارات.
       * انتظار هذا القفل وحده (55P03، 40P01) يصير 503 LOT_BUSY؛ وما بعده كالصنف غير المتتبَّع: مهلة المعاملة (١٢٠ ثانية) ليست
       * انشغالاً تُعاد له المحاولة. ولا طابور داخل العملية هنا (استثناءٌ مسمّى في D29: مسار المالك النادر، والقفل في القاعدة هو
       * الحارس، وقراءة العلم قبل المعاملة استعلامٌ زائد على كل تحويلٍ والميزة مطفأة). */
      try {
        await lockLotProducts(tx, tid, [pid], {
          lockedRows: [{ id: pid, lotTracked: product.lotTracked === true, lotTrackedSince: product.lotTrackedSince ?? null }],
        });
      } catch (e) {
        throw asLockBusy(e) ?? e;
      }

      /* ٢. لقطات الصفوف في الجداول الأربعة: الاسم القديم لما لا اسم له، والمعامل × F، والأساس من جديد.
       * qty وunitPrice وunitCost وlineTotal لا تُمسّ — هي بوحدة الصفّ وما زالت الكرتون. والمعامل التالف (≤٠) يُقرأ ١
       * كما يقرؤه factorOf، فيصير F لا صفراً. والمُطلِق (scripts/backfillBaseQty.ts) يحسب baseQty أيضاً؛ القيمة الصريحة
       * هنا لبيئةٍ لم يُركَّب فيها بعد. والشركة شرطٌ في كل جملة عبر رأس المستند — لا يكفي معرّف الصنف وحده.
       * وبند الفاتورة يحمل رمز وحدته الضريبي أيضاً (القاعدة ١٠): البند القديم بلا رمز كان يُقرأ برمز الصنف، فيأخذه لقطةً
       * قبل أن يتغيّر رمز الصنف إلى رمز الأساس الجديد (baseUnitCode) — وإلّا خرج إشعارٌ دائن على كرتونٍ قديم برمز الحبة.
       * ورمزٌ فارغٌ على الصنف يبقى البند فارغاً كما كان (COALESCE مع null). */
      const invoiceItems = await tx.$executeRaw`
        UPDATE "invoice_items" AS r SET
          "unitName" = COALESCE(r."unitName", ${oldUnit}::text),
          "unitFactor" = (CASE WHEN r."unitFactor" > 0 THEN r."unitFactor" ELSE 1 END) * ${F}::float8,
          "baseQty" = r."qty" * (CASE WHEN r."unitFactor" > 0 THEN r."unitFactor" ELSE 1 END) * ${F}::float8,
          "unitCode" = COALESCE(r."unitCode", ${product.unitCode || null}::text)
        FROM "invoices" AS d
        WHERE r."invoiceId" = d.id AND d."tenantId" = ${tid} AND r."productId" = ${pid}`;
      /* وبند التحميل يحمل كميّتين **بالأساس دائماً** (قرار التنفيذ): الاقتراح والتنبّؤ — بلا ضربهما بـF يُقاس تنبّؤ «٥ كرتون»
       * على مبيعٍ صار ١٢٠ حبّة فتنقلب دقّة الاقتراح كلّها لأشهرٍ مضت. والفارغ يبقى فارغاً (null × F = null) */
      const vanLoadItems = await tx.$executeRaw`
        UPDATE "van_load_items" AS r SET
          "unitName" = COALESCE(r."unitName", ${oldUnit}::text),
          "unitFactor" = (CASE WHEN r."unitFactor" > 0 THEN r."unitFactor" ELSE 1 END) * ${F}::float8,
          "baseQty" = r."qty" * (CASE WHEN r."unitFactor" > 0 THEN r."unitFactor" ELSE 1 END) * ${F}::float8,
          "suggestedQty" = r."suggestedQty" * ${F}::float8,
          "expectedQty" = r."expectedQty" * ${F}::float8
        FROM "van_loads" AS d
        WHERE r."vanLoadId" = d.id AND d."tenantId" = ${tid} AND r."productId" = ${pid}`;
      const warehouseEntryItems = await tx.$executeRaw`
        UPDATE "warehouse_entry_items" AS r SET
          "unitName" = COALESCE(r."unitName", ${oldUnit}::text),
          "unitFactor" = (CASE WHEN r."unitFactor" > 0 THEN r."unitFactor" ELSE 1 END) * ${F}::float8,
          "baseQty" = r."qty" * (CASE WHEN r."unitFactor" > 0 THEN r."unitFactor" ELSE 1 END) * ${F}::float8
        FROM "warehouse_entries" AS d
        WHERE r."entryId" = d.id AND d."tenantId" = ${tid} AND r."productId" = ${pid}`;
      const stockRequestItems = await tx.$executeRaw`
        UPDATE "rep_stock_request_items" AS r SET
          "unitName" = COALESCE(r."unitName", ${oldUnit}::text),
          "unitFactor" = (CASE WHEN r."unitFactor" > 0 THEN r."unitFactor" ELSE 1 END) * ${F}::float8,
          "baseQty" = r."qty" * (CASE WHEN r."unitFactor" > 0 THEN r."unitFactor" ELSE 1 END) * ${F}::float8
        FROM "rep_stock_requests" AS d
        WHERE r."requestId" = d.id AND d."tenantId" = ${tid} AND r."productId" = ${pid}`;

      /* ٢ب. «تتبّع اللوط» (D22): كل كمية لوطٍ **بالأساس** ولا لقطة وحدةٍ معها، فتُضرب بـF كما صار أساس بنودها — وإلا انفصلت
       * Σ صفوف توزيع كل بندٍ عن كميته الأساسية (I3)، وصار رصيد كل لوطٍ (وغير المسمّى = رصيد الصنف − Σ الخام) بالكراتين
       * القديمة بين أرصدةٍ بالحبّات. لكل صفوف الصنف أيّاً كانت حقبتها وأيّاً كان علمه الآن: صفوف حقبةٍ سابقة تبقى في شاشة
       * التتبّع. والشركة والصنف من أعمدة الجدول نفسه (مكرَّرةٌ فيه). وProductLot بلا كمية، وLotEvent سجلّ تدقيقٍ لا يُعاد
       * كتابته (لا كمية فيه اليوم؛ ومن يضيف كميةً إلى before/after يكتب معها اسم وحدة الأساس). */
      const vanLoadItemLots = await tx.$executeRaw`
        UPDATE "van_load_item_lots" SET "qty" = "qty" * ${F}::float8
        WHERE "tenantId" = ${tid} AND "productId" = ${pid}`;
      const invoiceItemLots = await tx.$executeRaw`
        UPDATE "invoice_item_lots" SET "quantity" = "quantity" * ${F}::float8
        WHERE "tenantId" = ${tid} AND "productId" = ${pid}`;
      const lotRelabels = await tx.$executeRaw`
        UPDATE "lot_relabels" SET "qty" = "qty" * ${F}::float8
        WHERE "tenantId" = ${tid} AND "productId" = ${pid}`;

      /* ٣. الوحدات القائمة تُضرب بـF (طبليةٌ = ٥٠ كرتون ⇒ ١٢٠٠ حبة) وتتأخّر رتبةً، والوحدة القديمة تصير وحدةً بمعامل F
       * **بسعرها القديم** ورمزها الضريبي، وأولى في الترتيب: هي ما يبيعه المندوب كل يوم، فلا يتغيّر عمله بعد التحويل.
       *
       * وقبل الضرب: الوحداتُ المشتقّةُ سعرَها (price = null، كالطبلية) تُجمَّد على سعرها المشتقّ الآن
       * (سعر الأساس القديم × معاملها). وإلّا فبعد التحويل يُشتقّ سعرها من الأساس الجديد المقرَّب لأربع منازل ×
       * المعامل المضروب، فيزحّ سعرها هللاتٍ بلا أن يطلب أحدٌ ذلك. التجميد يبقيه كما كان حرفاً. */
      const derived = await tx.productUnit.findMany({ where: { productId: pid, tenantId: tid, price: null }, select: { id: true, factor: true } });
      for (const u of derived) {
        await tx.productUnit.update({ where: { id: u.id }, data: { price: roundDecimal(Number(product.basePrice) * factorOf({ unitFactor: u.factor }), 2) } });
      }
      await tx.productUnit.updateMany({
        where: { productId: pid, tenantId: tid },
        data: { factor: { multiply: F }, sortOrder: { increment: 1 } },
      });
      const oldBaseUnit = await tx.productUnit.create({
        data: {
          tenantId: tid, productId: pid, name: oldUnit, factor: F, price: Number(product.basePrice),
          unitCode: product.unitCode || null, isActive: true, sortOrder: 0,
        },
      });

      // ٤. الأسعار المخزَّنة لوحدة الأساس تصير للحبة: ÷ F — بلا تقريب، فسعر العميل × ٢٤ يعود سعر كرتونه بالفلس.
      // وحدود الشرائح بالأساس × F؛ والشريحة التي لم يملأها الترحيل بعد (baseMinQty = 0 وminQty ≠ 0) تُحسب من القديم.
      // والحدّان القديمان (minQty/maxQty، للعرض القائم) × F أيضاً — كلاهما بالأساس؛ والطرف الأيمن في SQL يقرأ القيم القديمة،
      // فشرط CASE لـbaseMinQty يرى minQty قبل ضربه
      const customerPrices = await tx.customerPrice.updateMany({
        where: { productId: pid, product: { tenantId: tid } },
        data: { price: { divide: F } },
      });
      const priceTiers = await tx.$executeRaw`
        UPDATE "price_tiers" AS t SET
          "price" = t."price" / ${F}::float8,
          "baseMinQty" = (CASE WHEN t."baseMinQty" = 0 AND t."minQty" <> 0 THEN t."minQty" ELSE t."baseMinQty" END) * ${F}::float8,
          "baseMaxQty" = COALESCE(t."baseMaxQty", t."maxQty") * ${F}::float8,
          "minQty" = t."minQty" * ${F}::float8,
          "maxQty" = t."maxQty" * ${F}::float8
        FROM "products" AS p
        WHERE t."productId" = p.id AND p."tenantId" = ${tid} AND t."productId" = ${pid}`;

      // ٥. الأساس الجديد وسعره: المُرسَل، وإلّا القديم ÷ F بأربع منازل (سعر الكرتون محفوظٌ على وحدته في الخطوة ٣).
      // و«الوحدة الرئيسية» (D12): بلا رئيسية صالحة تصير الوحدة القديمة رئيسية (ما لم يُطلب غير ذلك) فلا يتغيّر عرض الصنف ولا
      // إدخاله الافتراضي؛ والرئيسية القائمة (طبلية مثلاً) تبقى بمعرّفها ومعاملها ضُرب بـF في الخطوة ٣. ولحظة التحويل تُختم (I7)
      const now = new Date();
      await tx.product.updateMany({
        where: { id: pid, tenantId: tid },
        data: {
          unit: body.newBaseName.trim(),
          basePrice: body.basePrice ?? roundDecimal(Number(product.basePrice) / F, 4),
          ...(body.baseUnitCode !== undefined && { unitCode: body.baseUnitCode || null }),
          baseConvertedAt: now,
          ...(primaryUnitOf(product) == null && body.keepOldBaseAsPrimary !== false && { primaryUnitId: oldBaseUnit.id }),
        },
      });
      // I7: صفٌّ واحد في سجلّ التحويلات في المعاملة نفسها — شاهد الخادم في إعادة الرفع أوف‑لاين (§2.12)، وسجلّ تدقيق
      const log = await tx.productBaseConversion.create({
        data: { tenantId: tid, productId: pid, fromUnit: oldUnit, toUnit: body.newBaseName.trim(), factor: F, fromUnitId: oldBaseUnit.id, convertedAt: now, convertedBy: actorOf(req) },
      });
      const data = await tx.product.findFirst({
        where: { id: pid, tenantId: tid },
        include: { category: true, priceTiers: { orderBy: { minQty: 'asc' } }, units: UNITS_ORDER },
      });
      return {
        data,
        converted: {
          factor: F, from: oldUnit, invoiceItems, vanLoadItems, warehouseEntryItems, stockRequestItems, customerPrices: customerPrices.count, priceTiers,
          // عدّادات اللوط حين مسّ التحويل صفوفاً منها وحدها — فشكل الردّ لصنفٍ بلا لوط كما كان (§١٠.١)
          ...(vanLoadItemLots + invoiceItemLots + lotRelabels > 0 && { vanLoadItemLots, invoiceItemLots, lotRelabels }),
          conversionId: log.id,
        },
      };
    }, { maxWait: 10_000, timeout: 120_000 }); // صنفٌ بتاريخ سنوات: آلاف الصفوف بالمُطلِق على قاعدةٍ صغيرة
    res.json({ success: true, data: result.data, converted: result.converted });
  } catch (err) {
    if (err instanceof UnitsRefusal) { res.status(err.status).json({ success: false, code: err.code, message: err.message }); return; }
    if (isUniqueViolation(err)) { res.status(409).json({ success: false, message: 'يوجد وحدة باسم وحدة الأساس الحالية لهذا الصنف' }); return; }
    if (err instanceof LotError) { res.status(err.status).json(lotErrorBody(err)); return; } // LOT_BUSY من قفل اللوط وحده
    next(err);
  } finally {
    if (marked) unmarkConverting(marked.tid, marked.pid);
  }
});

export default router;

