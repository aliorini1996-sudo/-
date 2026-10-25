/**
 * «إدارة طرق الدفع» في الواجهة (طلب المالك ٢٥ أكتوبر ٢٠٢٦) — المساعد المركزي الوحيد الذي تقرأ منه كل شاشة اسم الطريقة
 * واختيارات سند القبض. صرفٌ بلا React ولا DOM: thermal.ts يستورده ويُختبر في node (thermalHtml.test.ts)، وكذلك lib/paymentMethods.
 *
 * المصدر: CompanySettings.paymentMethodsConfig خاماً كما يصل مع GET /api/company — كاش ['company'] في اللوحة، وحالة
 * التطبيق وذاكرة IndexedDB في جهاز المندوب (أوف‑لاين)، وحالة /m. لا يُقرأ إلا عبر readPaymentMethodsConfig (النواة المنسوخة
 * حرفياً من الخادم): نسخةٌ أحدث أو عطب ⇒ null = سلوك ما قبل الميزة حرفياً، فلا يعرض جوالٌ قديم طريقةً لم يفهمها.
 *
 * قاعدة الاسم (حارس الشريط الحراري الذهبي يعتمد عليها):
 *  - مفتاح مخصّص يعرفه الإعداد ⇒ اسم الشركة كما كتبته — **لا يمرّ بـtr**: كلماتها هي، واسمٌ يصادف مفتاحاً في القاموس
 *    («تحويل» مثلاً) كان سيُترجم صامتاً إلى غير ما كتبته الشركة.
 *  - مفتاحٌ مجهول (إعدادٌ أُعيد أو جهازٌ سبق الخادم) ⇒ اسم الأساس الافتراضي، لا «c_xxxx» الخام أبداً.
 *  - طريقة مدمجة سمّتها الشركة ⇒ اسمها كما كتبته (بلا tr أيضاً).
 *  - وإلا الاسم الافتراضي من utils/format (paymentMethodLabels) — يمرّ بـtr إن مُرِّر، وبلا tr في الشريط الكلاسيكي العربي
 *    فيبقى «نقدي» بايتاً ببايت. قيمةٌ غريبة تُعرض كما هي.
 * والافتراضي من utils/format لا من DEFAULT_METHOD_LABELS في النواة عمداً: الإلكتروني هناك «دفع الكتروني» (قاموس الشاشات
 * وترجماته واختباراتها منذ ميسر)، وتبديله هنا يغيّر سطراً مطبوعاً لشركةٍ لم تلمس الإعداد.
 */
import { paymentMethodLabels } from '../utils/format';
import {
  BUILTIN_METHODS, DEFAULT_METHOD_ALIASES, DEFAULT_METHOD_LABELS, MANUAL_BASES, PAYMENT_METHODS_LIMITS, checkPaymentMethodsConfig,
  findCustomMethod, isBuiltinMethod, isDefaultPaymentMethodsConfig, methodLabelKey, normalizeMethodLabel, readPaymentMethodsConfig,
  receiptMethodChoices, receiptMethodPayload,
  type BuiltinMethod, type ManualBase, type MethodIcon, type PaymentMethodsConfigInput, type PaymentMethodsConfigV1,
  type PaymentMethodsIssue,
} from './paymentMethodsCore';

export * from './paymentMethodsCore';

type Tr = (ar: string) => string;
/** أيّ كائن شركة (Company في RepDocuments، ردّ /company في اللوحة و/m) — الحقل خامٌ اختياري */
export type CompanyWithMethods = { paymentMethodsConfig?: unknown } | null | undefined;

// قراءةٌ واحدة لكل قيمة خام: الشاشات تنادي الاسم لكل صفّ في الجدول، والقيمة نفسها (المرجع نفسه من الكاش) تتكرّر
const parsed = new WeakMap<object, PaymentMethodsConfigV1 | null>();

/** إعداد الشركة المقروء، أو null = الافتراضي (ومنه إعدادٌ يساوي الافتراضي حرفياً) */
export function companyMethodsConfig(company: CompanyWithMethods): PaymentMethodsConfigV1 | null {
  const raw = company?.paymentMethodsConfig;
  if (!raw || typeof raw !== 'object') return null;
  const hit = parsed.get(raw);
  if (hit !== undefined) return hit;
  const c = readPaymentMethodsConfig(raw);
  const v = c && !isDefaultPaymentMethodsConfig(c) ? c : null;
  parsed.set(raw, v);
  return v;
}

/** الاسم الافتراضي (قاموس الشاشات) — مترجماً إن مُرِّر tr؛ قيمةٌ غريبة تُعاد كما هي (لا تمرّ بالقاموس) */
export function defaultMethodLabel(method: string, tr?: Tr): string {
  const ar = paymentMethodLabels[method];
  if (!ar) return method;
  return tr ? tr(ar) : ar;
}

/**
 * اسم الشركة الخاص للطريقة وحده (مضافة يعرفها الإعداد، أو مدمجة سمّتها) — null = لا اسم خاص فتعرض الشاشة افتراضيّها.
 * لشاشاتٍ لها قاموسها الافتراضي منذ قبل الميزة (تقرير التحصيل، تقارير /m): تبقى كلماتها لشركةٍ بلا إعداد حرفياً.
 */
export function companyMethodLabelIn(config: PaymentMethodsConfigV1 | null, method: string, key?: string | null): string | null {
  const c = findCustomMethod(config, key);
  if (c) return c.label;
  if (config && isBuiltinMethod(method)) return config.builtins[method]?.label || null;
  return null;
}
export const companyMethodLabel = (company: CompanyWithMethods, method: string, key?: string | null): string | null =>
  companyMethodLabelIn(companyMethodsConfig(company), method, key);

/** اسم طريقة سندٍ بإعدادٍ مقروء (انظر قاعدة الاسم أعلى الملف) */
export function methodLabelIn(config: PaymentMethodsConfigV1 | null, method: string, key?: string | null, tr?: Tr): string {
  return companyMethodLabelIn(config, method, key) ?? defaultMethodLabel(method, tr);
}

/** اسم طريقة سندٍ لشركة — المستعمَل في كل عرضٍ وطباعة وتصدير */
export function methodLabelFor(company: CompanyWithMethods, method: string, key?: string | null, tr?: Tr): string {
  return methodLabelIn(companyMethodsConfig(company), method, key, tr);
}

/** أساس سندٍ لأغراض الألوان والأيقونات (المخصّصة تأخذ لون أساسها) — ومعرّف عرضه */
export function methodIdentity(company: CompanyWithMethods, method: string, key?: string | null): { id: string; base: string; icon: MethodIcon | null; custom: boolean } {
  const c = findCustomMethod(companyMethodsConfig(company), key);
  return c ? { id: c.key, base: c.base, icon: c.icon, custom: true } : { id: method, base: method, icon: null, custom: false };
}

/** وصفٌ حلّه الخادم (كتل تقرير «طرق الدفع» وملخّص التحصيل وGET /company/payment-methods) ⇒ الاسم المعروض */
export function resolvedMethodLabel(r: { id?: string; method?: string; base?: string; companyLabel?: string | null; custom?: boolean; label?: string }, tr?: Tr): string {
  if (r.companyLabel) return r.companyLabel;
  if (r.custom && r.label) return r.label;
  return defaultMethodLabel(r.base || r.id || r.method || '', tr);
}

// ─── اختيارات سند القبض (المندوب أونلاين وأوف‑لاين، واللوحة، و/m) ───

export interface ReceiptMethodChoice {
  /** معرّف الاختيار في الشاشة: رمز المدمجة أو مفتاح المخصّصة */
  id: string;
  /** ما يُرسل في paymentMethod — وعليه تُبنى حقول الشيك/البنك في النموذج */
  base: ManualBase;
  key: string | null;
  label: string;
  icon: MethodIcon | null;
  custom: boolean;
}

export interface ChoicesOptions {
  /** ترتيب المدمجة في هذه الشاشة (كلٌّ له ترتيبه اليوم: المندوب و/m «نقدي، تحويل، شبكة، شيك») — المخصّصة بعدها بترتيب الشركة */
  order?: readonly ManualBase[];
  /** الاسم الافتراضي القصير لهذه الشاشة (أزرار المندوب و/m تقول «تحويل») — لا يمسّ اسماً سمّته الشركة */
  defaultLabels?: Partial<Record<ManualBase, string>>;
}

/**
 * ما يعرضه نموذج السند: المدمجة المفعّلة (بلا ONLINE أبداً — سنده من روابط ميسر وحدها) ثم المخصّصة المفعّلة. شركةٌ لم
 * تُحمَّل بعد (null في أول رسم أو أوف‑لاين بلا ذاكرة) أو بلا إعداد ⇒ الأربع اليوم بأسمائها وترتيبها حرفياً. وقائمةٌ فارغة
 * (لا تقع: الخادم يرفض حفظ إعدادٍ بلا طريقة مفعّلة، لكن قراءةً متسامحة قد تُسقط مخصّصةً تالفة) ⇒ الافتراضي لا نموذجٌ بلا زرّ.
 */
export function receiptChoicesFor(company: CompanyWithMethods, tr?: Tr, opts: ChoicesOptions = {}): ReceiptMethodChoice[] {
  const build = (config: PaymentMethodsConfigV1 | null): ReceiptMethodChoice[] => {
    const all = receiptMethodChoices(config);
    const order = opts.order ?? MANUAL_BASES;
    const builtins = order.map((m) => all.find((c) => !c.custom && c.id === m)).filter((c): c is NonNullable<typeof c> => !!c);
    return [...builtins, ...all.filter((c) => c.custom)].map((c) => {
      const base = c.base as ManualBase;
      const fallback = opts.defaultLabels?.[base] ?? paymentMethodLabels[base] ?? base;
      return {
        id: c.id, base, key: c.key, custom: c.custom, icon: c.icon,
        label: c.companyLabel ?? (tr ? tr(fallback) : fallback),
      };
    });
  };
  const list = build(companyMethodsConfig(company));
  return list.length ? list : build(null);
}

/** ما تعرضه النماذج الثلاثة حين يختفي ما اختاره المستخدم — ويمنع الإصدار حتى يختار من جديد */
export const METHOD_CHOICE_UNAVAILABLE = 'طريقة الدفع المختارة لم تعد متاحة — اختر طريقة الدفع من جديد';

export interface ChoicePick {
  /** الاختيار النافذ — null حين اختفى ما اختاره المستخدم (لا بديل عنه أبداً) */
  chosen: ReceiptMethodChoice | null;
  /** اختار المستخدم طريقةً ثم اختفت بعد تحديث إعداد الشركة (عُطّلت أو سقطت): الإصدار ممنوع حتى يختار من جديد */
  unavailable: boolean;
}

/**
 * الاختيار الحالي. لم يختر المستخدم بعد ⇒ أول الاختيارات (الافتراضي المعروض). اختار ⇒ اختياره ما دام متاحاً، فإن اختفى
 * (تحديث /company كل ٥ دقائق أثناء فتح النموذج) ⇒ لا اختيار ويُمنع الإرسال — **لا يُستبدل به غيره أبداً**: البديل الصامت
 * كان سيقيّد سنداً حُصّل تحويلاً بنكياً على النقدي (عهدة المندوب والقيود على الأساس).
 */
export function pickChoice(choices: ReceiptMethodChoice[], id: string | null | undefined): ChoicePick {
  if (id === null || id === undefined || id === '') return { chosen: choices[0] ?? null, unavailable: false };
  const hit = choices.find((c) => c.id === id);
  return hit ? { chosen: hit, unavailable: false } : { chosen: null, unavailable: true };
}

/** جسم السند لاختيار: الأساس في paymentMethod دائماً، والمفتاح للمخصّصة وحدها (لا حقل زائد لسندٍ مدمج — بصمة clientRef كما اليوم) */
export const choicePayload = (c: Pick<ReceiptMethodChoice, 'base' | 'key'>) => receiptMethodPayload(c);

// ─── مسوّدة شاشة «إدارة طرق الدفع» ───

export interface DraftBuiltin { method: BuiltinMethod; label: string; active: boolean }
export interface DraftCustom {
  /** مفتاح محفوظ، أو null لطريقة جديدة يولّد الخادم مفتاحها عند الحفظ */
  key: string | null;
  /** معرّف الصفّ في الشاشة (المفتاح أو مؤقّت) */
  rowId: string;
  label: string;
  base: ManualBase;
  icon: MethodIcon;
  active: boolean;
}
export interface MethodsDraft { builtins: DraftBuiltin[]; custom: DraftCustom[] }

/** الإعداد المحفوظ (null = الافتراضي) ⇒ مسوّدة تُحرَّر. الاسم الفارغ = الافتراضي */
export function draftFromConfig(config: PaymentMethodsConfigV1 | null): MethodsDraft {
  return {
    builtins: BUILTIN_METHODS.map((m) => ({ method: m, label: config?.builtins[m]?.label ?? '', active: m === 'ONLINE' ? true : config?.builtins[m]?.active !== false })),
    custom: (config?.custom ?? []).map((c) => ({ key: c.key, rowId: c.key, label: c.label, base: c.base, icon: c.icon, active: c.active })),
  };
}

/** المسوّدة ⇒ جسم PUT: الطرق المدمجة الخمس كاملة، والمخصّصة الجديدة بلا key (الخادم يولّده) */
export function draftToInput(d: MethodsDraft): PaymentMethodsConfigInput {
  const builtins: Record<string, { label: string | null; active: boolean }> = {};
  for (const b of d.builtins) builtins[b.method] = { label: b.label.trim() ? b.label : null, active: b.method === 'ONLINE' ? true : b.active };
  return {
    version: 1,
    builtins: builtins as PaymentMethodsConfigInput['builtins'],
    custom: d.custom.map((c) => ({ ...(c.key ? { key: c.key } : {}), label: c.label, base: c.base, icon: c.icon, active: c.active })),
  };
}

/**
 * فحص المسوّدة بقاعدة الخادم نفسها قبل الإرسال (الاسم والتكرار وطريقةٌ مفعّلة واحدة على الأقل…). المفاتيح المؤقّتة
 * للجديدة تُمرَّر كي لا يُشكى من غيابها — الخادم يولّد الحقيقية.
 */
export function draftIssues(d: MethodsDraft): PaymentMethodsIssue[] {
  let n = 0;
  const r = checkPaymentMethodsConfig(draftToInput(d), { newKey: () => `c_tmp${(n++).toString(36).padStart(4, '0')}` });
  return r.ok ? [] : r.issues;
}

/** تحذير النافذة (لا رفض) لاسمٍ يطابق اسم طريقة أساسية بلغة الواجهة الحالية */
export const LABEL_MATCHES_TRANSLATED_DEFAULT = 'هذا الاسم يطابق اسم طريقة أساسية بلغة الواجهة الحالية فيظهر زران بالاسم نفسه — اختر اسما آخر';

/**
 * مسارات (بصيغة النواة: builtins.X.label / custom.N.label) لأسماءٍ كتبتها الشركة تطابق — **بلغة الواجهة الحالية** — اسماً
 * تعرضه الشاشات لطريقةٍ مدمجة أخرى غير مسمّاة (الافتراضي واسم الشاشات القصير «تحويل»). النواة تحجز الأسماء العربية وحدها
 * (الخادم بلا قاموس)، فمضافةٌ باسم «Cash» تمرّ بينما يرى من يعمل بالإنجليزية زرّين «Cash» بأساسين مختلفين — فتحذّر النافذة.
 */
export function draftLabelWarnings(d: MethodsDraft, tr: Tr): string[] {
  // اسمٌ يساوي الافتراضي ليس تسميةً (النواة تحفظه null) — فالطريقة تبقى تعرض افتراضيّها المترجم
  const named = (b: DraftBuiltin): boolean => {
    const l = normalizeMethodLabel(b.label);
    return !!l && l !== DEFAULT_METHOD_LABELS[b.method];
  };
  const shown = new Map<string, BuiltinMethod>();
  for (const b of d.builtins) {
    if (named(b)) continue;
    for (const ar of [defaultMethodLabel(b.method), DEFAULT_METHOD_LABELS[b.method], ...(DEFAULT_METHOD_ALIASES[b.method] ?? [])]) {
      const k = methodLabelKey(tr(ar));
      if (k && !shown.has(k)) shown.set(k, b.method);
    }
  }
  const out: string[] = [];
  for (const b of d.builtins) {
    if (!named(b)) continue;
    const owner = shown.get(methodLabelKey(b.label));
    if (owner && owner !== b.method) out.push(`builtins.${b.method}.label`);
  }
  d.custom.forEach((c, i) => { if (shown.has(methodLabelKey(c.label))) out.push(`custom.${i}.label`); });
  return out;
}

/** هل تجاوزت المسوّدة حدّ الطرق المضافة؟ (المعطّلة تُعدّ — لا تُحذف) */
export const canAddCustom = (d: MethodsDraft): boolean => d.custom.length < PAYMENT_METHODS_LIMITS.maxCustom;

/** تساوي مسوّدتين (زرّ الحفظ لا يعمل بلا تغيير) */
export function draftsEqual(a: MethodsDraft, b: MethodsDraft): boolean {
  return JSON.stringify(draftToInput(a)) === JSON.stringify(draftToInput(b));
}
