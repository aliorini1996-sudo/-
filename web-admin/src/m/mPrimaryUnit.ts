/**
 * «الوحدة الرئيسية» (القاعدة ١٢) في تطبيق الإدارة على الجوال — منطقٌ نقيّ بلا React ولا شبكة لشاشات /m، يُختبر وحده
 * (mPrimaryUnit.test.ts). العرض نفسه (formatQty بالرئيسية، productUnitLabel، unitsBrief، tierToPrimary…) ونموذج «أعرّف الصنف
 * بالكرتون» (ReverseForm وreverseCreatePayload…) في lib/units.ts وlib/adminUnits.ts وm/mUnits.ts — لا نسخةٌ ثانية هنا. وهنا ما
 * يخصّ شاشات الجوال وحدها: وسم المجاميع، ورموز الرفض التي يُعاد بها الجلب، و`baseUnitName` في أسطر المخزون، وتذكّر طريقة
 * التعريف، والانتقال إلى العكسي، وبوّابة معاينة «إضافة وحدة فرعية أصغر»، وقرار إدخال الشرائح بالرئيسية.
 *
 * ═══ الثابت الحاكم ═══
 * الحساب الداخلي لا ينقلب (D1): القارورة هي `Product.unit/basePrice`، والكرتون صفّ `ProductUnit` بمعامله، و`primaryUnitId`
 * يشير إليه. فلا شيء هنا يدخل جسم بندٍ أو كميةً مخزَّنة: الجسم بلا `unitId` = الأساس دائماً (D3)، والرئيسية افتراضٌ وعرض.
 *
 * ═══ D21 ═══
 * كل نصّ هنا مفتاح قاموس (tr في الشاشة) بلا كلمة «الأساس»: يحلّ محلها اسم الوحدة نفسه أو «الوحدة الصغرى».
 */
import { derivedBasePrice, MAX_UNIT_FACTOR, QTY_EPS, type UnitDef } from '../lib/units';
import { convertDraftProblem, tierBaseBounds, type TierIn } from './mUnits';

/** صحيحٌ من ٢ إلى MAX_UNIT_FACTOR — معامل الرئيسية (I5) ومعامل «إضافة وحدة فرعية أصغر» */
function factorOk(s: string): boolean {
  const f = Number(s);
  return s.trim() !== '' && Number.isFinite(f) && Math.abs(f - Math.round(f)) <= QTY_EPS && Math.round(f) >= 2 && Math.round(f) <= MAX_UNIT_FACTOR;
}

/** رقمٌ غير سالب مكتوبٌ نصّاً — «» ليس صفراً */
function priceOk(s: string): boolean {
  const p = Number(s);
  return s.trim() !== '' && Number.isFinite(p) && p >= 0;
}

// ═══════════════ R3: المجاميع عبر الأصناف ═══════════════

/**
 * في المجموع صنفٌ له رئيسية؟ — بالقيمة الصادقة `!!primaryUnitId` لا `!== undefined` ولا `in`: D18 يجعل `null` حاضراً في كل
 * ردّ، فشرطٌ على الحضور يقلب وسم كل شركة (I1).
 */
export function anyPrimary(rows: ReadonlyArray<{ primaryUnitId?: string | null } | null | undefined> | null | undefined): boolean {
  return (rows ?? []).some(r => !!r?.primaryUnitId);
}

/**
 * وسم مجموع كمياتٍ بالأساس عبر الأصناف (R3): «X بالوحدات الصغرى» حين في المجموع صنفٌ له رئيسية، وإلّا الوسم القائم حرفاً —
 * «… بوحدات الأساس» لمجموعٍ فيه صنفٌ بوحدات (I1)، والوسم المجرّد لغيره. `plain` و`legacyBase` مفتاحا قاموس.
 */
export function qtyTotalLabel(tr: (ar: string) => string, plain: string, legacyBase: string, flags: { primary: boolean; multi: boolean }): string {
  if (flags.primary) return `${tr(plain)} ${tr('بالوحدات الصغرى')}`;
  return flags.multi ? tr(legacyBase) : tr(plain);
}

/** نصّ مترجَمٌ بحقوله: `{unit}` و`{sub}` و`{cur}` و`{n}`… تُملأ **بعد** tr — المفتاح ثابت والقيم متغيّرة */
export function fill(text: string, vars: Record<string, string | number>): string {
  return Object.entries(vars).reduce((s, [k, v]) => s.split(`{${k}}`).join(String(v)), text);
}

// ═══════════════ أخطاء الكتابة: ما يُعاد جلبه ═══════════════

/** رمز رفض الخادم من خطأ axios (أو undefined) */
export function errorCode(e: unknown): string | undefined {
  return (e as { response?: { data?: { code?: string } } } | null)?.response?.data?.code;
}

/**
 * كاتب مخزونٍ أو مستند رُفض لأن أساس صنفٍ تغيّر: كاشٌ قديم (400 UNIT_INVALID) أو سباقٌ مع تحويل (409 PRODUCT_UNITS_CHANGED)
 * ⇒ تُجلب الأصناف من جديد. أمّا 503 PRODUCT_UNITS_BUSY فلا: الكتالوج لم يتغيّر بعد، والرسالة تكفي (§6.4).
 */
export function refetchUnitsOn(e: unknown): boolean {
  const c = errorCode(e);
  return c === 'UNIT_INVALID' || c === 'PRODUCT_UNITS_CHANGED';
}

/** كاتب إعداد صنفٍ من نموذجٍ قديم: 409 BASE_UNIT_CHANGED أو PRIMARY_UNIT_CHANGED ⇒ «تغيّرت وحدات الصنف — أعد فتحه» */
export function productUnitsChanged(e: unknown): boolean {
  const c = errorCode(e);
  return c === 'BASE_UNIT_CHANGED' || c === 'PRIMARY_UNIT_CHANGED';
}

// ═══════════════ baseUnitName في أسطر المخزون ═══════════════

/**
 * البند ومعه أساس الصنف كما يعرفه كتالوج الشاشة (§3 البند ١٣، §5.3): يختلف عن أساس الصنف الآن ⇒ 400 UNIT_INVALID بدل أن
 * يُقيَّد «١٠» كرتوناً على أساسٍ صار قارورة (خطأ ×٢٤). والاسم الفارغ لا يُرسَل: الخادم يقرأ غيابه «لا مقارنة» كما قبل الميزة.
 */
export function withBaseUnitName<T extends object>(item: T, base: string | null | undefined): T & { baseUnitName?: string } {
  const b = String(base ?? '').trim();
  return b ? { ...item, baseUnitName: String(base) } : item;
}

/**
 * بنود التنزيل بأساسها: `splitVanMovement` (lib/vanMovement.ts) يعيد بناء بند التنزيل من حقوله المعروفة فيُسقط غيرها،
 * وترتيبه ترتيب الأسطر السالبة نفسه (المنتهية والصفرية ساقطة). فيُعاد الأساس إليها بالترتيب — من السطر لا من الصنف، فسطران
 * للصنف أُضيفا قبل تحويلٍ وبعده يحمل كلٌّ ما رآه.
 */
export function backWithBaseNames<B extends object>(
  rows: ReadonlyArray<{ qty: number; baseUnitName?: string | null }>, back: B[],
): Array<B & { baseUnitName?: string }> {
  const neg = rows.filter(r => Number.isFinite(r.qty) && r.qty < 0);
  return back.map((b, i) => withBaseUnitName(b, neg[i]?.baseUnitName));
}

// ═══════════════ طريقة تعريف صنفٍ جديد: آخر ما اختاره المستخدم ═══════════════

/** طريقة تعريف الصنف — `base` النموذج القائم حرفاً (أصغر وحدة)، و`primary` العكسي (بالكرتون وفيه وحدة أصغر) */
export type DefMode = 'base' | 'primary';

/** مفتاح آخر طريقةٍ اختارها هذا المستخدم — لكل مستخدم، بلا أثرٍ في الخادم (§4.1) */
export const defModeKey = (userId: string | null | undefined): string => `fs.m.productDefMode.${userId || 'anon'}`;

/** آخر طريقة، وإلّا الأولى — التخزين قد يرمي (وضع خاص، بيانات ممسوحة) فلا يُسقط النموذج */
export function readDefMode(storage: Pick<Storage, 'getItem'> | null | undefined, userId: string | null | undefined): DefMode {
  try {
    return storage?.getItem(defModeKey(userId)) === 'primary' ? 'primary' : 'base';
  } catch {
    return 'base';
  }
}

export function writeDefMode(storage: Pick<Storage, 'setItem'> | null | undefined, userId: string | null | undefined, m: DefMode): void {
  try { storage?.setItem(defModeKey(userId), m); } catch { /* تفضيلٌ لا حالة — يضيع بلا أثر */ }
}

// ═══════════════ صنفٌ قائم: الانتقال إلى العكسي ═══════════════

/**
 * وحداتٌ تصلح رئيسيةً لصنفٍ قائم (الخيار «أ»): النشطة بمعاملٍ صحيح من ٢ إلى MAX_UNIT_FACTOR (شروط primaryUnitOf، I5)،
 * تصاعدياً — وافتراض المنتقي أصغرها (كرتون قبل طبلية).
 */
export function primaryCandidates(units: UnitDef[] | null | undefined): UnitDef[] {
  return (units ?? [])
    .filter(u => u && u.id && u.isActive !== false && factorOk(String(u.factor)))
    .sort((a, b) => Number(a.factor) - Number(b.factor));
}

/** رمز رفض «إضافة وحدة فرعية أصغر» كما يحسبه الخادم (adminPermissionFields) */
export type ConvertRefusalCode = 'OWNER_ONLY' | 'SCOPED_USER' | 'FORBIDDEN' | 'ROLE_FORBIDDEN';

/**
 * من يرى «إضافة وحدة فرعية أصغر» مفعّلة: `canConvertBase === true` من ردّ الدخول (§3)، أو جلسة المالك بـ«دخول» — الخادم
 * يسمح لها دائماً، وجلسةٌ محفوظة قبل هذا النشر لا تحمل الحقل فلا يُحجب عنها ما كان متاحاً لها. والخادم يحكم في كل طلب.
 */
export function canAddSubUnit(user: { canConvertBase?: boolean } | null | undefined, ownerSession: boolean): boolean {
  return ownerSession || user?.canConvertBase === true;
}

/**
 * تلميح الزرّ المعطَّل بحسب `convertBaseRefusalCode` (§4.2) — مفاتيح كتلة WP0. جلسةٌ قديمة بلا الحقل (null) تُقرأ «غير
 * مفعّلة لشركتك»: هو حال كل مستخدم شركة لم يفتح مالك المنصّة علمها، والخادم يحكم في كل طلب.
 */
export function convertRefusalHint(code: ConvertRefusalCode | null | undefined): string {
  switch (code) {
    case 'SCOPED_USER': return 'تخصّ الشركة كلها — لمستخدم غير مقيّد بنطاق';
    case 'ROLE_FORBIDDEN': return 'لمستخدم بدور مدير أو مشرف';
    case 'FORBIDDEN': return 'تتطلّب صلاحيات الأصناف والفواتير ومخزون السيارات معاً';
    default: return 'غير مفعّلة لشركتك — اطلب تفعيلها من الدعم الفني';
  }
}

// ═══════════════ «إضافة وحدة فرعية أصغر» (convert-base) ═══════════════

/** مسوّدة النافذة — الاسم والعدد والسعر نصوصٌ، و«تبقى الحالية رئيسية» مفعّلٌ افتراضاً (D12) */
export interface SubUnitDraft { newBaseName: string; factor: string; basePrice: string; keepPrimary: boolean }

export const emptySubUnitDraft: SubUnitDraft = { newBaseName: '', factor: '', basePrice: '', keepPrimary: true };

/** نصوص convertDraftProblem (mUnits.ts، حارس الخادم نفسه) بلفظ D21 — ونصٌّ غير مذكور هنا يمرّ كما هو (لا «أساس» فيه) */
const SUB_UNIT_WORDS: Record<string, string> = {
  'اسم وحدة الأساس الجديدة مطلوب': 'اسم الوحدة الفرعية مطلوب',
  'وحدة الأساس الجديدة هي الحالية نفسها': 'الوحدة الفرعية باسم الوحدة الحالية نفسها',
  'اسم وحدة الأساس الجديدة مستخدم لوحدة أخرى لهذا الصنف': 'اسم الوحدة الفرعية مستخدم لوحدة أخرى لهذا الصنف',
  'معامل التحويل عدد صحيح أكبر من 1 كم وحدة أساس جديدة في الوحدة الحالية': 'العدد صحيح أكبر من 1 — كم وحدة فرعية في الوحدة الحالية',
};

/** سبب رفض المسوّدة قبل المعاينة (مفتاح قاموس) أو null — قاعدة convertDraftProblem وحدها، ثم السعر الاختياري */
export function subUnitDraftProblem(d: SubUnitDraft, p: { unit: string; units?: UnitDef[] | null }): string | null {
  const why = convertDraftProblem({ newBaseName: d.newBaseName, factor: d.factor }, p);
  if (why) return SUB_UNIT_WORDS[why] ?? why;
  if (d.basePrice.trim() !== '' && !priceOk(d.basePrice)) return 'سعر الوحدة رقم موجب';
  return null;
}

/** سعر الفرعية المعروض قبل الإرسال: المكتوب، وإلّا سعر الوحدة الحالية ÷ العدد بأربع منازل (خطوة ٥ في convert-base) */
export function subUnitPrice(d: SubUnitDraft, currentBasePrice: number | string): number {
  if (d.basePrice.trim() !== '' && priceOk(d.basePrice)) return Number(d.basePrice);
  return derivedBasePrice(Number(currentBasePrice), Math.round(Number(d.factor)));
}

/**
 * بصمة القيم التي تُعاين بها النافذة — زرّ التنفيذ يُفتح لمعاينةٍ نجحت **بهذه البصمة نفسها**، وأي تعديلٍ بعدها يغلقه حتى
 * معاينةٍ جديدة (§4.3): فلا يُنفَّذ عددٌ لم يُعايَن.
 */
export function subUnitDraftKey(d: SubUnitDraft): string {
  return JSON.stringify([d.newBaseName.trim(), Math.round(Number(d.factor)), d.basePrice.trim(), d.keepPrimary]);
}

/**
 * جسم convert-base: `expectedBaseName` الأساس كما رآه النموذج (409 BASE_UNIT_CHANGED لتحويلٍ مزدوج)، والسعر الفارغ غائب
 * (الخادم يقسم بأربع منازل)، و`keepOldBaseAsPrimary` صريحٌ في الاتجاهين. والإقراران حين يُطلبان وحدهما.
 */
export function subUnitBody(d: SubUnitDraft, expectedBaseName: string, opts: { dryRun?: boolean; acknowledgeErp?: boolean; acknowledgeApi?: boolean } = {}): {
  newBaseName: string; factor: number; expectedBaseName: string; basePrice?: number;
  keepOldBaseAsPrimary: boolean; dryRun?: boolean; acknowledgeErp?: boolean; acknowledgeApi?: boolean;
} {
  return {
    newBaseName: d.newBaseName.trim(),
    factor: Math.round(Number(d.factor)),
    expectedBaseName,
    ...(d.basePrice.trim() !== '' && { basePrice: Number(d.basePrice) }),
    keepOldBaseAsPrimary: d.keepPrimary,
    ...(opts.dryRun && { dryRun: true }),
    ...(opts.acknowledgeErp && { acknowledgeErp: true }),
    ...(opts.acknowledgeApi && { acknowledgeApi: true }),
  };
}

/** ردّ المعاينة (dryRun) كما يكتبه الخادم (§2.2-ز) — قراءةٌ متساهلة: حقلٌ غائب صفر */
export interface SubUnitDryRun {
  erpLinked?: boolean;
  apiKeys?: { write?: number; readOnly?: number };
  primaryAfter?: string | null;
  converted?: Record<string, number | string | undefined>;
}

/** ردّ المعاينة من جسم الاستجابة، أو null حين لا يشبهها (dryRun: true) — فلا يُفتح زرّ التنفيذ على ردٍّ غير مفهوم */
export function dryRunOf(body: unknown): SubUnitDryRun | null {
  const b = body as (SubUnitDryRun & { success?: boolean; dryRun?: boolean }) | null | undefined;
  return b && typeof b === 'object' && b.dryRun === true ? b : null;
}

/** عدد البنود التي يُعاد وسمها (المستندات والمخزون) — «سيُعاد وسم N بنداً» */
export function dryRunItems(r: SubUnitDryRun | null | undefined): number {
  const c = r?.converted ?? {};
  return ['invoiceItems', 'vanLoadItems', 'warehouseEntryItems', 'stockRequestItems']
    .reduce((s, k) => s + (Number(c[k]) || 0), 0);
}

/** ما يلزم إقراره قبل التنفيذ: ERP مربوط، ومفاتيح API نشطة (كتابةً وقراءة) */
export function dryRunNeeds(r: SubUnitDryRun | null | undefined): { erp: boolean; apiKeys: number } {
  return { erp: r?.erpLinked === true, apiKeys: (Number(r?.apiKeys?.write) || 0) + (Number(r?.apiKeys?.readOnly) || 0) };
}

/**
 * زرّ التنفيذ: معاينةٌ ناجحة بالبصمة الحالية نفسها، والإقراران المطلوبان مؤشَّران. وغير ذلك معطّل — والخادم يردّ 409 على
 * إقرارٍ ناقص أيّاً كانت الواجهة.
 */
export function canRunSubUnit(s: { previewKey: string | null; key: string; preview: SubUnitDryRun | null; ackErp: boolean; ackApi: boolean }): boolean {
  if (!s.preview || s.previewKey !== s.key) return false;
  const n = dryRunNeeds(s.preview);
  return (!n.erp || s.ackErp) && (n.apiKeys === 0 || s.ackApi);
}

/**
 * سطر «الافتراض في البيع بعد الإضافة: …» (§4.3): يُقال حين يختلف ما يقرّره الخادم رئيسيةً بعد الإضافة (`primaryAfter`) عن
 * افتراض المندوب اليوم — طبليةٌ موجودة بلا رئيسية ثم «تبقى الحالية رئيسية». و`null` ⇒ لا سطر.
 */
export function defaultAfterLine(primaryAfter: string | null | undefined, currentDefault: string): string | null {
  const a = String(primaryAfter ?? '').trim();
  return a && a !== String(currentDefault ?? '').trim() ? a : null;
}

// ═══════════════ شرائح الأسعار بالرئيسية ═══════════════

/**
 * تُدخَل الشرائح بالرئيسية (§4.4) حين كل حدٍّ قائم مضاعفٌ صحيح لمعاملها — وإلّا تبقى بالفرعية بوسمها: حدٌّ «٣٠ قارورة»
 * لكرتون ٢٤ لا يُكتب كرتوناً بلا كسر. وبلا شرائح تُدخَل بالرئيسية. والتخزين بالأساس دائماً (القاعدة ٥).
 */
export function tiersFitPrimary(tiers: ReadonlyArray<TierIn> | null | undefined, factor: number): boolean {
  const f = Number(factor);
  if (!Number.isFinite(f) || f < 2) return false;
  const whole = (n: number) => Math.abs(n / f - Math.round(n / f)) < QTY_EPS;
  return (tiers ?? []).every(t => {
    const b = tierBaseBounds(t);
    return whole(b.min) && (b.max == null || whole(b.max));
  });
}
