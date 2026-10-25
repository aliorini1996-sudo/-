// ============================================================================
// «إدارة طرق الدفع» v1 — النواة الصرفة المشتركة بين الخادم والواجهة (طلب المالك ٢٥ أكتوبر ٢٠٢٦، صفحة «طرق الدفع»)
// ----------------------------------------------------------------------------
// عمود واحد بنسخة: CompanySettings.paymentMethodsConfig Json?. null = سلوك اليوم حرفياً: الطرق الخمس بأسمائها الافتراضية
// كلها مفعّلة ولا طريقة مخصّصة. الشركة: (أ) تعيد تسمية الطرق المدمجة، (ب) تضيف طرقاً مخصّصة (STC Pay، تابي…) باسم وأيقونة،
// (ج) تعطّل طريقة لا تستعملها فتختفي من نماذج السند وتبقى سنداتها القديمة باسمها.
//
// القاعدة المالية الحاكمة (قرار المالك ٢): كل طريقة مخصّصة «تُعامل مثل» أساسٍ من أربعة (نقدي/شبكة/تحويل بنكي/شيك) —
// والأساس وحده يُكتب في Receipt.paymentMethod، فالقيود والدفاتر وعهدة المندوب وتوجيه الحسابات وكل قاعدة مال قائمة تعمل
// عليه بلا تغيير. المفتاح المخصّص في Receipt.paymentMethodKey للعرض وحده (الاسم والأيقونة وجداول التقرير).
// ولذلك: المفتاح لا يُحذف أبداً (سنداته القديمة تحتاج اسمه)، وأساسه لا يتغيّر بعد أول حفظ (سنداته قُيّدت عليه).
// والدفع الإلكتروني (ONLINE) للنظام وحده (روابط ميسر): يُعاد تسميته ولا يُعطَّل ولا يُختار يدوياً ولا يكون أساساً.
//
// لماذا نواة واحدة منسوخة حرفياً: الخادم يرفض عند الحفظ ويتحقّق عند إصدار السند، والجهاز (أوف‑لاين أيضاً) يبني قائمة
// الاختيار والأسماء من القاعدة نفسها — قاعدتان مختلفتان تعنيان طريقةً يعرضها الجوال فيرفضها الخادم. والقراءة متسامحة
// (نسخة أحدث ⇒ الافتراضي، ومدخلٌ تالف يُهمل وحده) لأن العمود يصل خاماً لكل جهاز عبر GET /api/company وذاكرته.
//
// نسخة حرفية في web-admin/src/lib/paymentMethodsCore.ts (بعد هذا الرأس) — عدّل هنا ثم انسخ.
// ============================================================================

import { z } from 'zod';

/** نسخة البنية — أيّ نسخة أخرى (جهاز قديم يقرأ إعداداً أحدث) تُعامَل كأنها لا إعدادات (الأسماء الافتراضية) */
export const PAYMENT_METHODS_CONFIG_VERSION = 1;

/** الطرق المدمجة بترتيب العرض (ترتيب جداول صفحة «طرق الدفع» نفسه: الأكثر استعمالاً في الميدان أولاً) */
export const BUILTIN_METHODS = ['CASH', 'POS', 'BANK_TRANSFER', 'CHEQUE', 'ONLINE'] as const;
export type BuiltinMethod = (typeof BUILTIN_METHODS)[number];

/**
 * الأسس الأربعة التي «تُعامل مثلها» الطريقة المخصّصة، وهي نفسها ما يُختار يدوياً في نماذج السند.
 * ONLINE خارجها عمداً: سنده يُنشأ من تأكيد رابط ميسر وحده، ودفاتره تفرّق بين إلكتروني برابط وبلا رابط.
 */
export const MANUAL_BASES = ['CASH', 'POS', 'BANK_TRANSFER', 'CHEQUE'] as const;
export type ManualBase = (typeof MANUAL_BASES)[number];

/** الأسماء الافتراضية بالعربية (الواجهة تترجمها بقاموسها؛ اسم الشركة الخاص لا يُترجم — كلماتها هي) */
export const DEFAULT_METHOD_LABELS: Readonly<Record<BuiltinMethod, string>> = Object.freeze({
  CASH: 'نقدي',
  POS: 'شبكة',
  BANK_TRANSFER: 'تحويل بنكي',
  CHEQUE: 'شيك',
  ONLINE: 'دفع إلكتروني',
});

/**
 * أسماءٌ أخرى تعرضها الشاشات للطريقة المدمجة **غير المسمّاة** — محجوزةٌ مثل اسمها الافتراضي: أزرار سند المندوب و/m ورؤوس
 * تقرير التحصيل تقول «تحويل»، وقاموس الشاشات يكتب الإلكتروني «دفع الكتروني» بلا همزة، و«نقد» يكاد يكون «نقدي». مضافةٌ باسمٍ
 * منها كانت ستضع زرّين بالاسم نفسه وأساسين مختلفين. والطريقة التي سمّتها الشركة تعرض اسمها وحده فتتحرّر أسماؤها هذه.
 */
export const DEFAULT_METHOD_ALIASES: Readonly<Partial<Record<BuiltinMethod, readonly string[]>>> = Object.freeze({
  CASH: ['نقد'],
  BANK_TRANSFER: ['تحويل'],
  ONLINE: ['دفع الكتروني'],
});

/** أيقونات الطرق المخصّصة — قائمة مغلقة بأسماء lucide (الواجهة تربط كل اسم بمكوّنه)؛ لا صور مرفوعة ولا روابط */
export const METHOD_ICONS = [
  'wallet', 'smartphone', 'credit-card', 'banknote', 'landmark', 'qr-code',
  'coins', 'gift', 'receipt', 'handshake', 'store', 'globe',
] as const;
export type MethodIcon = (typeof METHOD_ICONS)[number];
export const DEFAULT_METHOD_ICON: MethodIcon = 'wallet';

export const PAYMENT_METHODS_LIMITS = Object.freeze({
  /** الطرق المخصّصة — والمعطّلة منها تُعدّ (لا تُحذف أبداً) */
  maxCustom: 20,
  /** الاسم بعد التطبيع بالمحارف (لا البايتات) — يتّسع في سطر الشريط الحراري 58 مم */
  labelMax: 40,
  /** حدّ الجسم الخام قبل التطبيع (يحمي zod من نصّ ضخم) */
  rawLabelMax: 200,
  /** حجم JSON بالبايت — العمود يُقرأ مع كل GET /api/company لكل جهاز ويُخزَّن أوف‑لاين */
  maxBytes: 8192,
});

/** مفتاح الطريقة المخصّصة: c_ ثم حروف لاتينية صغيرة وأرقام. يولّده الخادم (أو الواجهة) مرة واحدة ولا يتغيّر */
export const CUSTOM_METHOD_KEY_RE = /^c_[a-z0-9]{4,24}$/;

export interface BuiltinMethodSetting {
  /** اسم الشركة للطريقة، null = الاسم الافتراضي (يُترجم في الواجهة) */
  label: string | null;
  /** false = معطّلة: تختفي من نماذج السند وحدها. ONLINE دائماً true */
  active: boolean;
}
export interface CustomPaymentMethod {
  key: string;
  label: string;
  /** «تُعامل مثل» — ما يُكتب في Receipt.paymentMethod، ولا يتغيّر بعد أول حفظ */
  base: ManualBase;
  icon: MethodIcon;
  active: boolean;
}
/** الصورة القانونية: الطرق المدمجة الخمس حاضرة دائماً، والمخصّصة بترتيب الشركة */
export interface PaymentMethodsConfigV1 {
  version: 1;
  builtins: Record<BuiltinMethod, BuiltinMethodSetting>;
  custom: CustomPaymentMethod[];
}

// ─── رسائل الرفض (عربية؛ مترجمة في قاموس الواجهة) ───

export const PAYMENT_METHODS_ISSUES = Object.freeze({
  shape: 'بنية طرق الدفع غير صالحة',
  unknownKey: 'حقل غير معروف في طرق الدفع',
  version: 'نسخة إعداد طرق الدفع غير مدعومة',
  tooLarge: 'إعداد طرق الدفع أكبر من الحد المسموح 8 كيلوبايت',
  tooMany: 'عدد طرق الدفع المضافة 20 على الأكثر',
  labelRequired: 'اكتب اسم طريقة الدفع',
  labelTooLong: 'اسم طريقة الدفع أطول من 40 حرفا',
  labelDuplicate: 'توجد طريقة دفع بهذا الاسم',
  base: 'اختر ما تعامل مثله الطريقة: نقدي أو شبكة أو تحويل بنكي أو شيك',
  icon: 'أيقونة طريقة الدفع غير معروفة',
  keyInvalid: 'معرف طريقة الدفع غير صالح',
  keyDuplicate: 'معرف طريقة الدفع مكرر',
  keyRequired: 'معرف طريقة الدفع مفقود',
  onlineFixed: 'الدفع الإلكتروني يعمل من روابط الدفع ولا يعطل من هنا',
  noneActive: 'أبق طريقة دفع واحدة مفعلة على الأقل',
  keyRemoved: 'طريقة دفع محفوظة غائبة عن الحفظ فالطرق لا تحذف بل تعطل. أعد تحميل الصفحة إن عدلتها من شاشة أخرى',
  baseChanged: 'لا يتغير ما تعامل مثله طريقة دفع محفوظة لأن سنداتها قيدت عليه. أضف طريقة جديدة بدلا منها',
});

export interface PaymentMethodsIssue { path: string; message: string }

// ─── أدوات صرفة ───

const charLen = (s: string): number => Array.from(s).length;
/** محارف الاتجاه الخفية — لا حاجة لها في اسم طريقة، وتقلب ترتيب السطر المطبوع */
const BIDI_RE = /[‎‏‪-‮⁦-⁩]/g;

/** اسم سطر واحد: بلا محارف تحكّم ولا اتجاه خفية، والأسطر والمسافات المتكرّرة ⇒ مسافة واحدة */
export function normalizeMethodLabel(v: unknown): string {
  if (typeof v !== 'string') return '';
  return v.replace(BIDI_RE, '').replace(/[\u0000-\u001f\u007f-\u009f\s]+/g, ' ').trim();
}

/**
 * مفتاح مقارنة الأسماء في قاعدة التفرّد — للمقارنة وحدها، فالاسم يُحفظ ويُعرض كما كتبته الشركة. «دفع الكتروني» و«دفع
 * إلكتروني» و«تحويـل» و«شبكه» اسمٌ واحد في عين من يختار من الأزرار: أشكال العرض (NFKC) إلى حروفها، والألف المهموزة
 * والممدودة إلى ا، والتاء المربوطة إلى ه، والألف المقصورة إلى ي، بلا تطويل ولا حركات، واللاتيني بحروف صغيرة.
 */
export function methodLabelKey(label: unknown): string {
  return normalizeMethodLabel(label)
    .normalize('NFKC')
    .replace(/[ـً-ٰٟ]/g, '')
    .replace(/[آأإٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** طول JSON بالبايت (UTF-8) — بلا TextEncoder ليعمل في الخادم والمتصفح سواء */
export function paymentMethodsConfigBytes(v: unknown): number {
  const s = JSON.stringify(v) ?? '';
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; } else n += 3;
  }
  return n;
}

export function isBuiltinMethod(m: unknown): m is BuiltinMethod {
  return typeof m === 'string' && (BUILTIN_METHODS as readonly string[]).includes(m);
}
export function isManualBase(m: unknown): m is ManualBase {
  return typeof m === 'string' && (MANUAL_BASES as readonly string[]).includes(m);
}
function isMethodIcon(v: unknown): v is MethodIcon {
  return typeof v === 'string' && (METHOD_ICONS as readonly string[]).includes(v);
}

function defaultBuiltins(): Record<BuiltinMethod, BuiltinMethodSetting> {
  return {
    CASH: { label: null, active: true },
    POS: { label: null, active: true },
    BANK_TRANSFER: { label: null, active: true },
    CHEQUE: { label: null, active: true },
    ONLINE: { label: null, active: true },
  };
}

/** الافتراضي بصورته القانونية — ما يعنيه null في العمود */
export function defaultPaymentMethodsConfig(): PaymentMethodsConfigV1 {
  return { version: 1, builtins: defaultBuiltins(), custom: [] };
}

/** إعدادٌ يساوي الافتراضي (لا اسم خاص ولا تعطيل ولا مخصّص) — يُخزَّن NULL ويُقرأ «غير مخصّص» */
export function isDefaultPaymentMethodsConfig(c: PaymentMethodsConfigV1 | null): boolean {
  if (!c) return true;
  return c.custom.length === 0 && BUILTIN_METHODS.every((m) => c.builtins[m].label === null && c.builtins[m].active);
}

// ─── الحفظ: بنية صارمة ثم صورة قانونية ثم قواعد متقاطعة ───

const rawLabel = z.string().max(PAYMENT_METHODS_LIMITS.rawLabelMax);
const builtinInSchema = z.object({ label: rawLabel.nullish(), active: z.boolean().optional() }).strict();
const customInSchema = z.object({
  // غائب ⇒ طريقة جديدة يولّد الخادم مفتاحها
  key: z.string().max(40).optional(),
  label: rawLabel,
  base: z.enum(MANUAL_BASES),
  icon: z.enum(METHOD_ICONS).optional(),
  active: z.boolean().optional(),
}).strict();
const configInSchema = z.object({
  version: z.literal(PAYMENT_METHODS_CONFIG_VERSION),
  builtins: z.object({
    CASH: builtinInSchema.optional(),
    POS: builtinInSchema.optional(),
    BANK_TRANSFER: builtinInSchema.optional(),
    CHEQUE: builtinInSchema.optional(),
    ONLINE: builtinInSchema.optional(),
  }).strict().optional(),
  custom: z.array(customInSchema).max(PAYMENT_METHODS_LIMITS.maxCustom).optional(),
}).strict();

/** ما يقبله الحفظ (PUT): الطرق المدمجة الغائبة = افتراضية، والمخصّصة الجديدة بلا مفتاح */
export type PaymentMethodsConfigInput = z.input<typeof configInSchema>;

function zodIssueMessage(i: z.ZodIssue): string {
  const last = i.path[i.path.length - 1];
  if (i.code === 'unrecognized_keys') return PAYMENT_METHODS_ISSUES.unknownKey;
  if (i.path[0] === 'version') return PAYMENT_METHODS_ISSUES.version;
  if (i.path.length === 1 && i.path[0] === 'custom' && i.code === 'too_big') return PAYMENT_METHODS_ISSUES.tooMany;
  if (last === 'base') return PAYMENT_METHODS_ISSUES.base;
  if (last === 'icon') return PAYMENT_METHODS_ISSUES.icon;
  if (last === 'label') return i.code === 'too_big' ? PAYMENT_METHODS_ISSUES.labelTooLong : PAYMENT_METHODS_ISSUES.labelRequired;
  if (last === 'key') return PAYMENT_METHODS_ISSUES.keyInvalid;
  return PAYMENT_METHODS_ISSUES.shape;
}

export type PaymentMethodsCheck = { ok: true; value: PaymentMethodsConfigV1 } | { ok: false; issues: PaymentMethodsIssue[] };

/**
 * جسم الحفظ ⇒ الصورة القانونية أو أسباب الرفض. newKey يولّد مفتاح الطريقة الجديدة (الخادم يمرّره؛ الواجهة تتحقّق بلا
 * توليد فتقبل الغائب). القواعد: الاسم سطرٌ واحد 1–40 حرفاً وفريدٌ بين كل الطرق بمفتاح methodLabelKey (ومنها الأسماء
 * الافتراضية وأسماء الشاشات للمدمجة غير المسمّاة — «نقدي» أو «تحويل» مخصّصة بجانب المدمجة تجعل زرّين أو جدولين بالاسم
 * نفسه)، والأساس من الأربعة، والإلكتروني لا يُعطَّل، وطريقةٌ مفعّلة واحدة على الأقل.
 */
export function checkPaymentMethodsConfig(raw: unknown, opts: { newKey?: () => string } = {}): PaymentMethodsCheck {
  const parsed = configInSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues.slice(0, 10).map((i) => ({ path: i.path.join('.'), message: zodIssueMessage(i) })) };
  }
  const d = parsed.data;
  const issues: PaymentMethodsIssue[] = [];
  const add = (path: string, message: string): void => { issues.push({ path, message }); };
  const L = PAYMENT_METHODS_LIMITS;

  const builtins = defaultBuiltins();
  for (const m of BUILTIN_METHODS) {
    const b = d.builtins?.[m];
    const label = normalizeMethodLabel(b?.label ?? '');
    if (label && charLen(label) > L.labelMax) add(`builtins.${m}.label`, PAYMENT_METHODS_ISSUES.labelTooLong);
    const active = b?.active !== false;
    if (m === 'ONLINE' && !active) add('builtins.ONLINE.active', PAYMENT_METHODS_ISSUES.onlineFixed);
    // الاسم المساوي للافتراضي ليس تسميةً — يبقى null فيُترجم في الواجهة
    builtins[m] = { label: label && label !== DEFAULT_METHOD_LABELS[m] ? label : null, active: m === 'ONLINE' ? true : active };
  }

  const given = new Set((d.custom ?? []).map((c) => c.key).filter((k): k is string => typeof k === 'string' && k !== ''));
  const seen = new Set<string>();
  const custom: CustomPaymentMethod[] = (d.custom ?? []).map((c, i) => {
    const at = `custom.${i}`;
    let key = c.key ?? '';
    if (!key) {
      if (opts.newKey) {
        // مفتاحٌ لا يصطدم بمفتاحٍ مُرسَل ولا بمولَّدٍ قبله في الطلب نفسه
        do { key = opts.newKey(); } while (given.has(key) || seen.has(key));
      } else add(`${at}.key`, PAYMENT_METHODS_ISSUES.keyRequired);
    } else if (!CUSTOM_METHOD_KEY_RE.test(key)) add(`${at}.key`, PAYMENT_METHODS_ISSUES.keyInvalid);
    if (key) {
      if (seen.has(key)) add(`${at}.key`, PAYMENT_METHODS_ISSUES.keyDuplicate);
      seen.add(key);
    }
    const label = normalizeMethodLabel(c.label);
    if (!label) add(`${at}.label`, PAYMENT_METHODS_ISSUES.labelRequired);
    else if (charLen(label) > L.labelMax) add(`${at}.label`, PAYMENT_METHODS_ISSUES.labelTooLong);
    return { key, label, base: c.base, icon: c.icon ?? DEFAULT_METHOD_ICON, active: c.active !== false };
  });

  // الأسماء فريدة بين كل الطرق (المعطّلة أيضاً: سنداتها القديمة تُعرض وتُجمع باسمها في التقارير) بمفتاح المقارنة المطبَّع.
  // والحجز على ثلاث مراتب كي يقع الخطأ على الصفّ الذي عدّله المستخدم لا على صفٍّ لم يلمسه: (١) المدمجة غير المسمّاة باسمها
  // الافتراضي وأسمائها في الشاشات، (٢) المدمجة المسمّاة، (٣) المضافة بترتيبها — فتسمية «نقدي» «شبكة» تُعلَّم على النقدي.
  const names = new Map<string, string>();
  const claim = (label: string, path: string): void => {
    const k = methodLabelKey(label);
    if (!k) return;
    const owner = names.get(k);
    if (owner === undefined) names.set(k, path);
    else if (owner !== path) add(path, PAYMENT_METHODS_ISSUES.labelDuplicate);
  };
  for (const m of BUILTIN_METHODS) {
    if (builtins[m].label !== null) continue;
    for (const name of [DEFAULT_METHOD_LABELS[m], ...(DEFAULT_METHOD_ALIASES[m] ?? [])]) claim(name, `builtins.${m}.label`);
  }
  for (const m of BUILTIN_METHODS) {
    const label = builtins[m].label;
    if (label !== null) claim(label, `builtins.${m}.label`);
  }
  custom.forEach((c, i) => claim(c.label, `custom.${i}.label`));

  if (!MANUAL_BASES.some((m) => builtins[m].active) && !custom.some((c) => c.active)) add('', PAYMENT_METHODS_ISSUES.noneActive);

  if (issues.length) return { ok: false, issues };
  return { ok: true, value: { version: 1, builtins, custom } };
}

/**
 * الانتقال من المحفوظ إلى الجديد: كل مفتاح محفوظ باقٍ، وأساسه كما هو. حفظُ JSON كامل من تبويبٍ قديم كان سيحذف طريقةً
 * أُضيفت من شاشة أخرى (فتفقد سنداتها اسمها) أو يبدّل أساسها (فتختلف قيود سنداتها عمّا يُعرض) — فيُرفض لا يُدمج صامتاً.
 */
export function paymentMethodsTransitionIssues(prev: PaymentMethodsConfigV1 | null, next: PaymentMethodsConfigV1): PaymentMethodsIssue[] {
  if (!prev) return [];
  const out: PaymentMethodsIssue[] = [];
  const nextIndex = new Map(next.custom.map((c, i) => [c.key, i] as const));
  for (const p of prev.custom) {
    const i = nextIndex.get(p.key);
    if (i === undefined) out.push({ path: 'custom', message: PAYMENT_METHODS_ISSUES.keyRemoved });
    else if (next.custom[i].base !== p.base) out.push({ path: `custom.${i}.base`, message: PAYMENT_METHODS_ISSUES.baseChanged });
  }
  return out;
}

/**
 * «استعادة الافتراضي»: الطرق المدمجة بأسمائها الافتراضية مفعّلة كلها — والمخصّصة **تبقى معطّلة** لا تُمحى (سنداتها القديمة
 * تحتاج أسماءها). بلا مخصّصة ⇒ null (سلوك اليوم حرفياً).
 */
export function resetPaymentMethodsConfig(prev: PaymentMethodsConfigV1 | null): PaymentMethodsConfigV1 | null {
  if (!prev || prev.custom.length === 0) return null;
  return { version: 1, builtins: defaultBuiltins(), custom: prev.custom.map((c) => ({ ...c, active: false })) };
}

// ─── القراءة المتسامحة (الخادم عند الإصدار والتقارير، والجهاز أوف‑لاين) ───

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * القيمة المخزّنة ⇒ الإعداد، أو null (= الافتراضي). نسخةٌ غير 1 أو بنيةٌ غير كائن ⇒ null. ومدخلٌ تالف يُهمل وحده لا
 * الإعداد كلّه: اسمٌ غير صالح ⇒ الافتراضي، وأيقونةٌ مجهولة ⇒ الافتراضية، وطريقة مخصّصة بلا مفتاح أو أساس صالح ⇒ تُسقط
 * (سنداتها تُعرض باسم أساسها). حقلٌ زائد أضافه خادمٌ أحدث ضمن v1 يُهمل.
 */
export function readPaymentMethodsConfig(raw: unknown): PaymentMethodsConfigV1 | null {
  if (!isRecord(raw) || raw.version !== PAYMENT_METHODS_CONFIG_VERSION) return null;
  const L = PAYMENT_METHODS_LIMITS;
  const builtins = defaultBuiltins();
  const rb = isRecord(raw.builtins) ? raw.builtins : {};
  for (const m of BUILTIN_METHODS) {
    const b = isRecord(rb[m]) ? rb[m] as Record<string, unknown> : {};
    const label = normalizeMethodLabel(b.label);
    builtins[m] = {
      label: label && charLen(label) <= L.labelMax && label !== DEFAULT_METHOD_LABELS[m] ? label : null,
      active: m === 'ONLINE' ? true : b.active !== false,
    };
  }
  const custom: CustomPaymentMethod[] = [];
  const seen = new Set<string>();
  const list = Array.isArray(raw.custom) ? raw.custom.slice(0, 50) : [];
  for (const c of list) {
    if (!isRecord(c)) continue;
    const key = c.key;
    const label = normalizeMethodLabel(c.label);
    if (typeof key !== 'string' || !CUSTOM_METHOD_KEY_RE.test(key) || seen.has(key)) continue;
    if (!isManualBase(c.base) || !label || charLen(label) > L.labelMax) continue;
    seen.add(key);
    custom.push({ key, label, base: c.base, icon: isMethodIcon(c.icon) ? c.icon : DEFAULT_METHOD_ICON, active: c.active !== false });
  }
  return { version: 1, builtins, custom };
}

// ─── الحلّ: اسم الطريقة وأساسها وأيقونتها لأيّ سند أو اختيار ───

/** وصف طريقة جاهز للعرض والتجميع — مدمجة أو مخصّصة أو قيمة قديمة مجهولة */
export interface ResolvedPaymentMethod {
  /** معرّف العرض والتجميع: رمز المدمجة (CASH…) أو مفتاح المخصّصة (c_…) أو القيمة القديمة كما هي */
  id: string;
  /** ما يُكتب في Receipt.paymentMethod وتعمل عليه القيود */
  base: string;
  /** مفتاح المخصّصة أو null */
  key: string | null;
  custom: boolean;
  /** الاسم المعروض: اسم الشركة، وإلا الافتراضي بالعربية (لمستقبِلٍ بلا قاموس: ERP والتصدير) */
  label: string;
  /** اسم الشركة الخاص وحده، null = الاسم الافتراضي (الواجهة تترجمه بقاموسها) */
  companyLabel: string | null;
  icon: MethodIcon | null;
  active: boolean;
  /** يُختار يدوياً في نموذج السند (كل شيء عدا ONLINE والقيم المجهولة) */
  manual: boolean;
}

function builtinResolved(config: PaymentMethodsConfigV1 | null, m: BuiltinMethod): ResolvedPaymentMethod {
  const companyLabel = config?.builtins[m]?.label ?? null;
  return {
    id: m, base: m, key: null, custom: false,
    label: companyLabel ?? DEFAULT_METHOD_LABELS[m], companyLabel, icon: null,
    active: m === 'ONLINE' ? true : config?.builtins[m]?.active !== false,
    manual: m !== 'ONLINE',
  };
}
function customResolved(c: CustomPaymentMethod): ResolvedPaymentMethod {
  return { id: c.key, base: c.base, key: c.key, custom: true, label: c.label, companyLabel: c.label, icon: c.icon, active: c.active, manual: true };
}

export function findCustomMethod(config: PaymentMethodsConfigV1 | null, key: unknown): CustomPaymentMethod | null {
  if (!config || typeof key !== 'string' || !key) return null;
  return config.custom.find((c) => c.key === key) ?? null;
}

/**
 * سندٌ ⇒ وصف طريقته. المفتاح المعروف يغلب (اسم المخصّصة وأساسها من الإعداد)؛ ومفتاحٌ مجهول (إعدادٌ تالف أو جهاز سبق
 * الخادم) يرجع لأساس السند المخزّن — فلا يسقط سندٌ من أي جدول ولا يتغيّر مجموع.
 */
export function resolvePaymentMethod(config: PaymentMethodsConfigV1 | null, method: string | null | undefined, key?: string | null): ResolvedPaymentMethod {
  const c = findCustomMethod(config, key);
  if (c) return customResolved(c);
  const m = method || 'CASH'; // عمود السند افتراضيه CASH
  if (isBuiltinMethod(m)) return builtinResolved(config, m);
  return { id: m, base: m, key: null, custom: false, label: m, companyLabel: null, icon: null, active: true, manual: false };
}

/** كل الطرق: المدمجة الخمس بترتيبها ثم المخصّصة بترتيب الشركة — المعطّلة معها (لإدارتها وللتقارير) */
export function paymentMethodsList(config: PaymentMethodsConfigV1 | null): ResolvedPaymentMethod[] {
  return [...BUILTIN_METHODS.map((m) => builtinResolved(config, m)), ...(config?.custom ?? []).map(customResolved)];
}

/** ما يعرضه نموذج السند (المندوب أونلاين وأوف‑لاين، واللوحة، و/m): المفعّلة اليدوية وحدها — لا ONLINE */
export function receiptMethodChoices(config: PaymentMethodsConfigV1 | null): ResolvedPaymentMethod[] {
  return paymentMethodsList(config).filter((m) => m.manual && m.active);
}

/** جسم السند لاختيارٍ: الأساس دائماً في paymentMethod، والمفتاح للمخصّصة وحدها */
export function receiptMethodPayload(m: Pick<ResolvedPaymentMethod, 'base' | 'key'>): { paymentMethod: string; paymentMethodKey?: string } {
  return m.key ? { paymentMethod: m.base, paymentMethodKey: m.key } : { paymentMethod: m.base };
}

// ─── إصدار السند: التحقق في الخادم ───

export type ReceiptMethodCode = 'PAYMENT_METHOD_UNKNOWN' | 'PAYMENT_METHOD_DISABLED' | 'PAYMENT_METHOD_KEY_ONLINE';
export type ReceiptMethodResolution =
  | { ok: true; paymentMethod: string; paymentMethodKey: string | null }
  | { ok: false; status: 422; code: ReceiptMethodCode; message: string };

export const RECEIPT_METHOD_MESSAGES = Object.freeze({
  unknown: 'طريقة الدفع المختارة غير معروفة لدى الشركة. حدث الصفحة واختر طريقة أخرى',
  disabled: (label: string) => `طريقة الدفع «${label}» معطلة في الشركة. اختر طريقة أخرى`,
  keyOnline: 'الدفع الإلكتروني يسجل من روابط الدفع وحدها ولا يجتمع مع طريقة مخصصة',
});

/**
 * طريقة سندٍ جديد ⇒ ما يُخزَّن. **الأساس من إعداد الشركة لا من الجهاز** (مفتاحٌ معروف يفرض أساسه أياً كان paymentMethod
 * المُرسَل) — فلا يقيّد جهازٌ قديم أو مكاملٌ خارجي سنداً مخصّصاً على غير أساسه.
 *
 * replay (X-FS-Replay: 1 — رفعٌ مؤجَّل من صندوق العمل دون اتصال): المندوب قبض المال فعلاً، وأيّ 4xx يرفض السند في جهازه
 * نهائياً. فلا رفض هنا بسبب الأسماء أبداً: المعطّلة تُقبل (اختيرت قبل التعطيل)، والمفتاح المجهول يُسقط ويبقى أساس السند.
 * والترويسة يتحكّم بها العميل — فهي تخفّف قواعد العرض هذه وحدها، لا أيّ قاعدة مال (الأساس من الأربعة أو ONLINE يبقى).
 *
 * ONLINE بلا مفتاح يُقبل كما اليوم (المسار ووثائق API تقبلانه — حجبه كسرٌ لمكاملين قائمين؛ قرارٌ للمالك).
 */
export function resolveReceiptMethod(
  config: PaymentMethodsConfigV1 | null,
  input: { paymentMethod: string; paymentMethodKey?: string | null },
  opts: { replay?: boolean } = {},
): ReceiptMethodResolution {
  const replay = opts.replay === true;
  const key = typeof input.paymentMethodKey === 'string' ? input.paymentMethodKey.trim() : '';
  if (key) {
    if (input.paymentMethod === 'ONLINE') {
      return replay
        ? { ok: true, paymentMethod: 'ONLINE', paymentMethodKey: null }
        : { ok: false, status: 422, code: 'PAYMENT_METHOD_KEY_ONLINE', message: RECEIPT_METHOD_MESSAGES.keyOnline };
    }
    const c = findCustomMethod(config, key);
    if (!c) {
      return replay
        ? { ok: true, paymentMethod: input.paymentMethod, paymentMethodKey: null }
        : { ok: false, status: 422, code: 'PAYMENT_METHOD_UNKNOWN', message: RECEIPT_METHOD_MESSAGES.unknown };
    }
    if (!c.active && !replay) return { ok: false, status: 422, code: 'PAYMENT_METHOD_DISABLED', message: RECEIPT_METHOD_MESSAGES.disabled(c.label) };
    return { ok: true, paymentMethod: c.base, paymentMethodKey: c.key };
  }
  if (!replay && isManualBase(input.paymentMethod) && config && !config.builtins[input.paymentMethod].active) {
    const m = builtinResolved(config, input.paymentMethod);
    return { ok: false, status: 422, code: 'PAYMENT_METHOD_DISABLED', message: RECEIPT_METHOD_MESSAGES.disabled(m.label) };
  }
  return { ok: true, paymentMethod: input.paymentMethod, paymentMethodKey: null };
}
