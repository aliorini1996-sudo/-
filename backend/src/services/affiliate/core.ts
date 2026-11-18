/**
 * أساس برنامج «سفير فيلد سيلز»: الإعدادات والشروط والسجلّ والتشفير.
 *
 * العقد الحاكم: docs/affiliate/CONTRACT.md — والأشكال الدقيقة: docs/affiliate/API.md.
 *
 * لا بذرة في القاعدة: غياب صفّ الإعدادات يعني القيم الافتراضية، وغياب إصدار
 * الشروط الحالي يعني النصّ المدمج أدناه. فالبرنامج يعمل من أوّل نشرٍ دون أن
 * يكتب أحدٌ في القاعدة يدوياً.
 */
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { Prisma } from '@prisma/client';
import prisma from '../../config/database';

type Db = Prisma.TransactionClient | typeof prisma;

// ───────────────────────────── الإعدادات ─────────────────────────────

export interface AffiliateSettingsValue {
  intakeOpen: boolean;
  rateBps: number;
  holdDays: number;
  minPayoutHalalas: number;
  refWindowDays: number;
  claimLockDays: number;
  firstPaymentWithinDays: number;
  currentTermsVersion: string;
  disclosureText: string;
}

/**
 * إصدارات الشروط المدمجة بترتيب نشرها — آخرها هو الافتراضيّ. الإصدار الذي قبله سفيرٌ
 * يبقى نصّه محفوظاً هنا ولو نُسخ، فيُعرض له ما قبله فعلاً.
 * v4 (قرار المالك ١٨ نوفمبر ٢٠٢٦ — docs/affiliate/V2_SPEC.md §4): انضمامٌ فوريّ، حجز ١٠ أيام، تسوية كل ١٠ أيام بحدٍّ أدنى ٥٠ ريالاً.
 */
export const BUILTIN_TERMS_VERSIONS = ['2026-09-v1', '2026-09-v2', '2026-09-v3', '2026-11-v4'] as const;
export const DEFAULT_TERMS_VERSION = BUILTIN_TERMS_VERSIONS[BUILTIN_TERMS_VERSIONS.length - 1];

/**
 * قواعد كلّ إصدارٍ مدمج **مثبّتةٌ بإصداره** — لا تُقرأ من DEFAULT_SETTINGS. كانت `rulesFor` تُعيد الافتراضيات
 * الحالية لكلّ إصدارٍ مدمج، فخفضُ الحجز إلى ١٠ أيام في v4 كان سيسري بأثرٍ رجعيّ على سفيرٍ قبِل نصّاً يقول ٣٠.
 */
const V1_V3_RULES: Readonly<TermsRules> = { rateBps: 3000, holdDays: 30, minPayoutHalalas: 10000, refWindowDays: 90, claimLockDays: 90, firstPaymentWithinDays: 180 };
export const BUILTIN_TERMS_RULES: Readonly<Record<string, Readonly<TermsRules>>> = {
  '2026-09-v1': V1_V3_RULES,
  '2026-09-v2': V1_V3_RULES,
  '2026-09-v3': V1_V3_RULES,
  '2026-11-v4': { rateBps: 3000, holdDays: 10, minPayoutHalalas: 5000, refWindowDays: 90, claimLockDays: 90, firstPaymentWithinDays: 180 },
};

/** قواعد إصدارٍ مدمج (نسخةٌ لا مرجع) — أو null لغير المدمج. لوحة المالك تعرض بها قواعد الإصدارات المدمجة */
export function builtinTermsRules(version: string): TermsRules | null {
  const r = Object.prototype.hasOwnProperty.call(BUILTIN_TERMS_RULES, version) ? BUILTIN_TERMS_RULES[version] : null;
  return r ? { ...r } : null;
}

export const DEFAULT_SETTINGS: AffiliateSettingsValue = {
  intakeOpen: true,
  // القيم الماليّة من قواعد الإصدار الافتراضيّ نفسه — مصدرٌ واحد فلا يختلف النصّ عن القواعد
  ...BUILTIN_TERMS_RULES[DEFAULT_TERMS_VERSION],
  currentTermsVersion: DEFAULT_TERMS_VERSION,
  disclosureText: 'أحصل على عمولة من فيلد سيلز إذا اشتركت عبر رابطي',
};

export async function getSettings(db: Db = prisma): Promise<AffiliateSettingsValue> {
  const row = await db.affiliateSettings.findUnique({ where: { id: 'global' } });
  if (!row) return { ...DEFAULT_SETTINGS };
  // صفٌّ حُفظ وإصداره الحالي مدمجٌ أقدم (قبل تحديث النصّ في الشيفرة) يُرقّى للمدمج الأحدث؛
  // الإصدارات التي نشرها المالك من لوحته لا تُمسّ
  const builtinIdx = (BUILTIN_TERMS_VERSIONS as readonly string[]).indexOf(row.currentTermsVersion);
  const currentTermsVersion = builtinIdx >= 0 && builtinIdx < BUILTIN_TERMS_VERSIONS.length - 1 ? DEFAULT_TERMS_VERSION : row.currentTermsVersion;
  // الإصدار الحالي مدمج ⇒ قيمه الماليّة من قواعده المثبّتة لا من أعمدة الصفّ: صفٌّ كُتب أيّام v3 يحمل
  // ٣٠ يوماً و١٠٠ ريال، والترقية إلى v4 بدون هذا كانت ستجعل /terms/public و/me يقولان ٣٠ والنصّ ١٠ (V2_SPEC §4)
  const fixed = builtinTermsRules(currentTermsVersion);
  return {
    intakeOpen: row.intakeOpen,
    rateBps: fixed?.rateBps ?? row.rateBps,
    holdDays: fixed?.holdDays ?? row.holdDays,
    minPayoutHalalas: fixed?.minPayoutHalalas ?? row.minPayoutHalalas,
    refWindowDays: fixed?.refWindowDays ?? row.refWindowDays,
    claimLockDays: fixed?.claimLockDays ?? row.claimLockDays,
    firstPaymentWithinDays: fixed?.firstPaymentWithinDays ?? row.firstPaymentWithinDays,
    currentTermsVersion,
    disclosureText: row.disclosureText,
  };
}

// ───────────────────────────── الشروط ─────────────────────────────

/**
 * نصّ الإصدار الأوّل — يطابق قرارات المالك في CONTRACT §0. أيّ تعديلٍ عليه يُنشر
 * إصداراً جديداً من لوحة المالك (لا تعديلاً هنا)، فالسفير الذي قبل نصّاً يبقى
 * نصّه محفوظاً بإصداره.
 */
/** الإصدار الأوّل كما نُشر (١٣ سبتمبر ٢٠٢٦) — كان يمنع إحالة منشأةٍ يعمل فيها السفير */
const TERMS_V1_BODY = `شروط برنامج «سفير فيلد سيلز» — الإصدار 2026-09-v1

١. الطرفان
فيلد سيلز (منشأة سعودية بسجل تجاري) تدير البرنامج. والسفير فردٌ مستقلّ يسوّق للمنصّة، وليس موظفاً ولا وكيلاً عنها، ولا يحقّ له التعاقد أو الوعد باسمها.

٢. العمولة
- ٣٠٪ من أوّل دفعة مؤكَّدة تدفعها الشركة المُحالة للاشتراك، محسوبةً على المبلغ المدفوع شاملاً ضريبة القيمة المضافة، ولو غطّت الدفعة سنةً مقدّماً.
- عمولةٌ واحدة لكلّ شركة، ولا عمولة على التجديدات أو الدفعات اللاحقة.
- تُحتسب الدفعة إن تمّت خلال ١٨٠ يوماً من تاريخ إسناد الشركة إليك.
- لا عمولة على شركةٍ كانت عميلاً لفيلد سيلز قبل إحالتك.

٣. الإسناد
- رابطك الخاص يُحفظ في متصفّح الزائر ٩٠ يوماً، وآخر رابطٍ فتحه الزائر هو المعتمد.
- يمكن للشركة إدخال رمزك يدوياً عند التسجيل.
- ترشيح شركةٍ بسجلّها التجاري يُراجع، وإن قُبل حُجزت لك ٩٠ يوماً، والأسبق بترشيحٍ مقبول له الأولوية.
- التسجيل ببريدك أو جوالك، أو إحالة منشأةٍ تملكها أو تديرها، إحالةٌ ذاتية لا تستحقّ عمولة.
- لفيلد سيلز القرار النهائي في الإسناد المتنازع عليه.

٤. الاستحقاق والصرف
- تبقى العمولة معلّقة ٣٠ يوماً من تاريخ الدفع، ثم تُعتمد إن بقيت الدفعة قائمة.
- الاسترداد الكامل قبل الصرف يلغي العمولة، والجزئي يخفّضها بقدره، وما يُستردّ بعد الصرف أو بعد تجهيز دفعتك يُخصم من مستحقّاتك القادمة.
- الصرف تحويلٌ بنكي يدوي إلى آيبان سعودي باسمك، متى بلغ رصيدك المعتمد ١٠٠ ريال على الأقل.
- أنت مسؤولٌ عن التزاماتك الضريبية والنظامية المتعلّقة بدخلك من البرنامج.

٥. قواعد التسويق
- يُسمح بالنشر العلني، بشرط أن تحمل ترخيص «موثوق» ساري المفعول، وأن تُظهر وسم «إعلان» بوضوح في كلّ منشور.
- أفصح دائماً أنّك تحصل على عمولة.
- لا رسائل جماعية ولا تواصل بارد مزعج ولا شراء قوائم أرقام، ولا انتحال صفة فيلد سيلز، ولا إعلانات مدفوعة على اسم العلامة.
- لا وعود بمزايا أو أسعار أو خصومات غير منشورة على الموقع الرسمي.
- لا تُرسل لنا بيانات أشخاص. الترشيح اسم منشأة وسجلّها التجاري ومدينتها فقط.

٦. البيانات
نحفظ بياناتك لإدارة حسابك وصرف مستحقّاتك. والآيبان يُخزَّن مشفّراً. ولا ترى من الشركات المُحالة إلا اسمها وحالة اشتراكها.

٧. الإيقاف والتعديل
لفيلد سيلز إيقاف الحساب أو رفض العمولة عند مخالفة هذه الشروط أو الاشتباه بالتحايل، مع ذكر السبب. وتعديل الشروط يُنشر إصداراً جديداً يلزم قبوله لمواصلة المشاركة، ولا يمسّ عمولةً نشأت قبله.`;

/**
 * الإصدار الثاني: إحالة المنشأة التي يعمل فيها السفير أو يملكها **مسموحة** (قرار المالك
 * ١٣ سبتمبر ٢٠٢٦: «الأغلب سيجلب منشأة هو يعمل بها ولا مخالفة قانونية بذلك») ما دامت
 * عميلاً جديداً.
 */
const TERMS_V2_BODY = `شروط برنامج «سفير فيلد سيلز» — الإصدار 2026-09-v2

١. الطرفان
فيلد سيلز (منشأة سعودية بسجل تجاري) تدير البرنامج. والسفير فردٌ مستقلّ يسوّق للمنصّة، وليس موظفاً ولا وكيلاً عنها، ولا يحقّ له التعاقد أو الوعد باسمها.

٢. العمولة
- ٣٠٪ من أوّل دفعة مؤكَّدة تدفعها الشركة المُحالة للاشتراك، محسوبةً على المبلغ المدفوع شاملاً ضريبة القيمة المضافة، ولو غطّت الدفعة سنةً مقدّماً.
- عمولةٌ واحدة لكلّ شركة، ولا عمولة على التجديدات أو الدفعات اللاحقة.
- تُحتسب الدفعة إن تمّت خلال ١٨٠ يوماً من تاريخ إسناد الشركة إليك.
- لا عمولة على شركةٍ كانت عميلاً لفيلد سيلز قبل إحالتك.

٣. الإسناد
- رابطك الخاص يُحفظ في متصفّح الزائر ٩٠ يوماً، وآخر رابطٍ فتحه الزائر هو المعتمد.
- يمكن للشركة إدخال رمزك يدوياً عند التسجيل.
- ترشيح شركةٍ بسجلّها التجاري يُراجع، وإن قُبل حُجزت لك ٩٠ يوماً، والأسبق بترشيحٍ مقبول له الأولوية.
- يجوز لك إحالة المنشأة التي تعمل فيها أو تملكها أو تديرها، ما دامت عميلاً جديداً لم يسبق له الاشتراك في فيلد سيلز.
- لفيلد سيلز القرار النهائي في الإسناد المتنازع عليه.

٤. الاستحقاق والصرف
- تبقى العمولة معلّقة ٣٠ يوماً من تاريخ الدفع، ثم تُعتمد إن بقيت الدفعة قائمة.
- الاسترداد الكامل قبل الصرف يلغي العمولة، والجزئي يخفّضها بقدره، وما يُستردّ بعد الصرف أو بعد تجهيز دفعتك يُخصم من مستحقّاتك القادمة.
- الصرف تحويلٌ بنكي يدوي إلى آيبان سعودي باسمك، متى بلغ رصيدك المعتمد ١٠٠ ريال على الأقل.
- أنت مسؤولٌ عن التزاماتك الضريبية والنظامية المتعلّقة بدخلك من البرنامج.

٥. قواعد التسويق
- يُسمح بالنشر العلني، بشرط أن تحمل ترخيص «موثوق» ساري المفعول، وأن تُظهر وسم «إعلان» بوضوح في كلّ منشور.
- أفصح دائماً أنّك تحصل على عمولة.
- لا رسائل جماعية ولا تواصل بارد مزعج ولا شراء قوائم أرقام، ولا انتحال صفة فيلد سيلز، ولا إعلانات مدفوعة على اسم العلامة.
- لا وعود بمزايا أو أسعار أو خصومات غير منشورة على الموقع الرسمي.
- لا تُرسل لنا بيانات أشخاص. الترشيح اسم منشأة وسجلّها التجاري ومدينتها فقط.

٦. البيانات
نحفظ بياناتك لإدارة حسابك وصرف مستحقّاتك. والآيبان يُخزَّن مشفّراً. ولا ترى من الشركات المُحالة إلا اسمها وحالة اشتراكها.

٧. الإيقاف والتعديل
لفيلد سيلز إيقاف الحساب أو رفض العمولة عند مخالفة هذه الشروط أو الاشتباه بالتحايل، مع ذكر السبب. وتعديل الشروط يُنشر إصداراً جديداً يلزم قبوله لمواصلة المشاركة، ولا يمسّ عمولةً نشأت قبله.`;

/**
 * الإصدار الثالث: الترشيح يحمل **رقم التواصل مع المنشأة** إلزامياً (قرار المالك ١٣ سبتمبر
 * ٢٠٢٦) بدل «لا تُرسل لنا بيانات أشخاص»، مع حصر استعمال الرقم في التواصل بشأن الاشتراك.
 * (كان الافتراضيّ حتى v4 — ترويسته الآن حرفيّة فيبقى النصّ الذي قبله سفراء v3 كما قبلوه حرفاً بحرف)
 */
const TERMS_V3_BODY = `شروط برنامج «سفير فيلد سيلز» — الإصدار 2026-09-v3

١. الطرفان
فيلد سيلز (منشأة سعودية بسجل تجاري) تدير البرنامج. والسفير فردٌ مستقلّ يسوّق للمنصّة، وليس موظفاً ولا وكيلاً عنها، ولا يحقّ له التعاقد أو الوعد باسمها.

٢. العمولة
- ٣٠٪ من أوّل دفعة مؤكَّدة تدفعها الشركة المُحالة للاشتراك، محسوبةً على المبلغ المدفوع شاملاً ضريبة القيمة المضافة، ولو غطّت الدفعة سنةً مقدّماً.
- عمولةٌ واحدة لكلّ شركة، ولا عمولة على التجديدات أو الدفعات اللاحقة.
- تُحتسب الدفعة إن تمّت خلال ١٨٠ يوماً من تاريخ إسناد الشركة إليك.
- لا عمولة على شركةٍ كانت عميلاً لفيلد سيلز قبل إحالتك.

٣. الإسناد
- رابطك الخاص يُحفظ في متصفّح الزائر ٩٠ يوماً، وآخر رابطٍ فتحه الزائر هو المعتمد.
- يمكن للشركة إدخال رمزك يدوياً عند التسجيل.
- ترشيح شركةٍ بسجلّها التجاري يُراجع، وإن قُبل حُجزت لك ٩٠ يوماً، والأسبق بترشيحٍ مقبول له الأولوية.
- يجوز لك إحالة المنشأة التي تعمل فيها أو تملكها أو تديرها، ما دامت عميلاً جديداً لم يسبق له الاشتراك في فيلد سيلز.
- لفيلد سيلز القرار النهائي في الإسناد المتنازع عليه.

٤. الاستحقاق والصرف
- تبقى العمولة معلّقة ٣٠ يوماً من تاريخ الدفع، ثم تُعتمد إن بقيت الدفعة قائمة.
- الاسترداد الكامل قبل الصرف يلغي العمولة، والجزئي يخفّضها بقدره، وما يُستردّ بعد الصرف أو بعد تجهيز دفعتك يُخصم من مستحقّاتك القادمة.
- الصرف تحويلٌ بنكي يدوي إلى آيبان سعودي باسمك، متى بلغ رصيدك المعتمد ١٠٠ ريال على الأقل.
- أنت مسؤولٌ عن التزاماتك الضريبية والنظامية المتعلّقة بدخلك من البرنامج.

٥. قواعد التسويق
- يُسمح بالنشر العلني، بشرط أن تحمل ترخيص «موثوق» ساري المفعول، وأن تُظهر وسم «إعلان» بوضوح في كلّ منشور.
- أفصح دائماً أنّك تحصل على عمولة.
- لا رسائل جماعية ولا تواصل بارد مزعج ولا شراء قوائم أرقام، ولا انتحال صفة فيلد سيلز، ولا إعلانات مدفوعة على اسم العلامة.
- لا وعود بمزايا أو أسعار أو خصومات غير منشورة على الموقع الرسمي.
- الترشيح: اسم المنشأة وسجلّها التجاري ورقم التواصل معها ومدينتها.

٦. البيانات
نحفظ بياناتك لإدارة حسابك وصرف مستحقّاتك. والآيبان يُخزَّن مشفّراً. ورقم التواصل المرسل مع الترشيح لا يُستعمل إلا للتواصل مع المنشأة بشأن اشتراكها. ولا ترى من الشركات المُحالة إلا اسمها وحالة اشتراكها.

٧. الإيقاف والتعديل
لفيلد سيلز إيقاف الحساب أو رفض العمولة عند مخالفة هذه الشروط أو الاشتباه بالتحايل، مع ذكر السبب. وتعديل الشروط يُنشر إصداراً جديداً يلزم قبوله لمواصلة المشاركة، ولا يمسّ عمولةً نشأت قبله.`;

/**
 * الإصدار الرابع (قرار المالك ١٨ نوفمبر ٢٠٢٦ — V2_SPEC §0 و§4): الانضمام فوريّ بلا موافقة، الحجز ١٠ أيام ثم
 * اعتمادٌ تلقائيّ، التسوية كل ١٠ أيام بحدٍّ أدنى ٥٠ ريالاً ويُرحَّل ما دونه، اكتمال الملف شرطٌ للصرف، المطالبة
 * بإحالةٍ فائتة خلال ٣٠ يوماً، وبنود الحماية الناقصة (الادّعاءات المضلّلة، الاسم والشعار، الضرائب، عدم النشاط،
 * مصير المستحقّ عند الإنهاء، التعديل بإشعار، القانون الحاكم). أرقامه تطابق BUILTIN_TERMS_RULES['2026-11-v4']
 * (اختبارٌ يُفشل اختلافهما).
 */
export const DEFAULT_TERMS_BODY = `شروط برنامج «سفير فيلد سيلز» — الإصدار ${DEFAULT_TERMS_VERSION}

١. الطرفان والانضمام
فيلد سيلز (منشأة سعودية بسجل تجاري) تدير البرنامج. والسفير فردٌ أو منشأةٌ أو صانع محتوى مستقلّ يسوّق للمنصّة، وليس موظفاً ولا وكيلاً عنها، ولا يحقّ له التعاقد أو الوعد باسمها.
- الانضمام فوريّ: يُفتح حسابك ويصلك رابطك الخاص لحظة التسجيل دون انتظار موافقة، ولفيلد سيلز إيقاف الحساب لاحقاً وفق البند ٨.

٢. العمولة
- ٣٠٪ من أوّل دفعة مؤكَّدة تدفعها الشركة المُحالة للاشتراك، محسوبةً على المبلغ المدفوع شاملاً ضريبة القيمة المضافة، ولو غطّت الدفعة سنةً مقدّماً.
- عمولةٌ واحدة لكلّ شركة، ولا عمولة على التجديدات أو الدفعات اللاحقة.
- تُحتسب الدفعة إن تمّت خلال ١٨٠ يوماً من تاريخ إسناد الشركة إليك.
- لا عمولة على شركةٍ كانت عميلاً لفيلد سيلز قبل إحالتك.

٣. الإسناد
- رابطك الخاص يُحفظ في متصفّح الزائر ٩٠ يوماً، وآخر رابطٍ فتحه الزائر هو المعتمد.
- يمكن للشركة إدخال رمزك يدوياً عند التسجيل، ويمكنك أن تفتح من البوابة حساباً تجريبياً لمنشأةٍ طلبته فيُسند إليك.
- ترشيح شركةٍ بسجلّها التجاري يُراجع، وإن قُبل حُجزت لك ٩٠ يوماً، والأسبق بترشيحٍ مقبول له الأولوية.
- إن سجّلت شركةٌ أحلتها دون رابطك أو رمزك فلك أن ترفع «مطالبة بإحالة فائتة» خلال ٣٠ يوماً من تسجيلها، وتُقبل أو تُرفض بعد التحقّق.
- يجوز لك إحالة المنشأة التي تعمل فيها أو تملكها أو تديرها، ما دامت عميلاً جديداً لم يسبق له الاشتراك في فيلد سيلز.
- لفيلد سيلز القرار النهائي في الإسناد المتنازع عليه.

٤. الحجز والاعتماد
- تبقى العمولة معلّقة ١٠ أيام من تاريخ الدفع، ثم تُعتمد تلقائياً إن بقيت الدفعة قائمة ولم تكن العمولة موقوفة للمراجعة.
- الاسترداد الكامل قبل الصرف يلغي العمولة، والجزئي يخفّضها بقدره، وما يُستردّ بعد الصرف أو بعد تجهيز دفعتك يُخصم من مستحقّاتك القادمة.

٥. التسوية والصرف
- تُجرى التسوية كل ١٠ أيام (في الأيام ١ و١١ و٢١ من كلّ شهر) بحدٍّ أدنى ٥٠ ريالاً، ويُرحَّل ما دونه إلى التسوية التالية.
- الصرف تحويلٌ بنكي إلى آيبان سعودي باسمك. ولا يدخل التسوية إلا من اكتمل ملفّه: نوع السفير، والحساب البنكي، وصورة الهوية الوطنية أو الإقامة، والسجل التجاري إن كنت منشأة. ويبقى مستحقّك محفوظاً حتى يكتمل.
- إن تعذّر التحويل لخطأٍ في بيانات الحساب البنكي أُبلغت بذلك، ودخل المبلغ التسوية التالية بعد تصحيحها.
- أنت مسؤولٌ عن الضرائب والالتزامات النظامية المتعلّقة بدخلك من البرنامج.

٦. قواعد التسويق
- النشر العلني مسموح، وعليك الالتزام بالمتطلّبات النظامية للإعلان عبر الحسابات الشخصية، ومنها ترخيص «موثوق» حين يلزم، وإظهار وسم «إعلان» بوضوح في كلّ منشورٍ ترويجي.
- أفصح دائماً أنّك تحصل على عمولة.
- لا رسائل جماعية ولا تواصل مزعج ولا شراء قوائم أرقام، ولا ادّعاءات مضلّلة عن المنصّة أو أسعارها أو مزاياها، ولا وعود بخصوماتٍ غير منشورة على الموقع الرسمي.
- لا تستعمل اسم فيلد سيلز أو شعارها في اسم حسابٍ أو صفحةٍ أو إعلانٍ مدفوع يوحي بأنه رسميّ إلا بإذنٍ كتابيّ منها، ولا تنتحل صفتها.
- الترشيح: اسم المنشأة وسجلّها التجاري ورقم التواصل معها ومدينتها.

٧. البيانات
نحفظ بياناتك ومستنداتك لإدارة حسابك والتحقّق من هويتك وصرف مستحقّاتك. والآيبان والمستندات تُخزَّن مشفّرة ولا يطّلع عليها إلا المخوَّل بذلك. ورقم التواصل المرسل مع الترشيح لا يُستعمل إلا للتواصل مع المنشأة بشأن اشتراكها. ولا ترى من الشركات المُحالة إلا اسمها وحالة اشتراكها.

٨. الإيقاف والإنهاء
- لفيلد سيلز إيقاف الحساب أو رفض العمولة عند مخالفة هذه الشروط أو الاشتباه بالتحايل مع ذكر السبب، ولها إيقاف الحساب بعد عدم نشاطٍ ١٢ شهراً متصلة.
- ولك إنهاء مشاركتك متى شئت.
- عند الإنهاء تُسوّى لك العمولات المستحقّة المشروعة وفق هذه الشروط، وتسقط العمولة الناشئة عن مخالفةٍ أو تحايل.

٩. التعديل والقانون الحاكم
- تعديل الشروط يُنشر إصداراً جديداً يُشعَر به السفير، ويلزم قبوله لمواصلة المشاركة، ولا يمسّ عمولةً نشأت قبله.
- تخضع هذه الشروط لأنظمة المملكة العربية السعودية، وتختصّ محاكمها بأيّ نزاعٍ ينشأ عنها.`;

const BUILTIN_TERMS_BODIES: Record<string, string> = {
  '2026-09-v1': TERMS_V1_BODY, '2026-09-v2': TERMS_V2_BODY, '2026-09-v3': TERMS_V3_BODY, '2026-11-v4': DEFAULT_TERMS_BODY,
};

export function builtinTermsBody(version: string): string | null {
  return Object.prototype.hasOwnProperty.call(BUILTIN_TERMS_BODIES, version) ? BUILTIN_TERMS_BODIES[version] : null;
}

export async function getTerms(version: string, db: Db = prisma): Promise<{ version: string; body: string } | null> {
  const row = await db.affiliateTerms.findUnique({ where: { version } });
  if (row) return { version: row.version, body: row.body };
  const body = builtinTermsBody(version);
  if (body) return { version, body };
  return null;
}

/**
 * القيم الماليّة التي **تنصّ عليها الشروط** — لا تتغيّر إلا بنشر إصدارٍ جديد
 * (الشروط §٧: التعديل يُنشر إصداراً يلزم قبوله). تعديلها من الإعدادات مباشرةً
 * كان سيطبّق ٢٠٪ على سفيرٍ قبِل نصّاً يقول ٣٠٪.
 */
export const TERMS_RULE_KEYS = ['rateBps', 'holdDays', 'minPayoutHalalas', 'refWindowDays', 'claimLockDays', 'firstPaymentWithinDays'] as const;
export type TermsRuleKey = typeof TERMS_RULE_KEYS[number];
export type TermsRules = Record<TermsRuleKey, number>;

export const TERMS_RULE_RANGES: Record<TermsRuleKey, [number, number]> = {
  rateBps: [0, 10000],
  holdDays: [0, 365],
  minPayoutHalalas: [0, 100_000_000],
  refWindowDays: [1, 365],
  claimLockDays: [1, 365],
  firstPaymentWithinDays: [1, 730],
};

/** قراءة قواعد مخزَّنة بتسامح: قيمةٌ ناقصة أو خارج مداها تعود للاحتياط */
export function parseTermsRules(json: unknown, fallback: TermsRules): TermsRules {
  const src = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
  const out = { ...fallback };
  for (const k of TERMS_RULE_KEYS) {
    const v = src[k];
    const [lo, hi] = TERMS_RULE_RANGES[k];
    if (typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi) out[k] = v;
  }
  return out;
}

export function pickRules(s: AffiliateSettingsValue): TermsRules {
  return Object.fromEntries(TERMS_RULE_KEYS.map(k => [k, s[k]])) as TermsRules;
}

/**
 * قواعد الإصدار الذي قبله السفير — بها يُسند إليه ويُحتسب له. الإصدار المدمج من خريطته المثبّتة
 * (BUILTIN_TERMS_RULES) **لا من الافتراضيات**: سفيرٌ على v1–v3 يبقى بحجز ٣٠ وحدّ ١٠٠ ريال كما قبِل،
 * وتغيير الافتراضيات في إصدارٍ لاحق لا يمسّه بأثرٍ رجعيّ (V2_SPEC §4).
 */
export async function rulesFor(termsVersion: string, db: Db = prisma): Promise<TermsRules> {
  const row = await db.affiliateTerms.findUnique({ where: { version: termsVersion }, select: { rulesJson: true } });
  if (row) return parseTermsRules(row.rulesJson, pickRules(DEFAULT_SETTINGS));
  const fixed = builtinTermsRules(termsVersion);
  if (fixed) return fixed;
  return pickRules(await getSettings(db));
}

// ───────────────────────────── السجلّ ─────────────────────────────

export interface EventInput {
  // v2: missed_claim (المطالبة بإحالة فائتة) · document (مستندات الملف) · material (المواد التسويقية)
  entity: 'user' | 'claim' | 'attribution' | 'commission' | 'payout' | 'adjustment' | 'settings' | 'terms' | 'mail' | 'payment'
    | 'missed_claim' | 'document' | 'material';
  entityId: string;
  action: string;
  fromState?: string | null;
  toState?: string | null;
  actorType: 'system' | 'affiliate' | 'owner' | 'staff' | 'company';
  actorId?: string | null;
  reason?: string | null;
  meta?: Prisma.InputJsonValue;
}

/** منفّذ لوحة المنصة في سجلّ السفراء: المالك 'owner'، وموظف المنصة 'staff' بمعرّفه — وإلا نُسب فعل الموظف إلى المالك */
export interface PlatformActor { actorType: 'owner' | 'staff'; actorId: string }

/** الدالة الواحدة لكل أفعال لوحة المنصة في السجلّ (affiliateAdmin.ts وربط الدفعة في payments.ts) — platformGate يضع platformStaff */
export function platformActor(req: { user?: { id: string }; platformStaff?: { id: string } }): PlatformActor {
  return req.platformStaff ? { actorType: 'staff', actorId: req.platformStaff.id } : { actorType: 'owner', actorId: req.user!.id };
}

export async function logEvent(db: Db, e: EventInput): Promise<void> {
  await db.affiliateEvent.create({
    data: {
      entity: e.entity, entityId: e.entityId, action: e.action,
      fromState: e.fromState ?? null, toState: e.toState ?? null,
      actorType: e.actorType, actorId: e.actorId ?? null, reason: e.reason ?? null,
      ...(e.meta !== undefined ? { meta: e.meta } : {}),
    },
  });
}

/** السجلّ لا يُسقط العملية التي يوثّقها */
export function logEventSafe(e: EventInput): void {
  logEvent(prisma, e).catch(err => console.error('[affiliate] event log failed:', (err as Error).message));
}

// ───────────────────────────── ترقية الإرث (v2) ─────────────────────────────

/**
 * حالتا الانتظار القديمتان — **إرثٌ** بعد الانضمام الفوريّ (قرار المالك ١٨ نوفمبر ٢٠٢٦، V2_SPEC §3): لا يُنشأ عليهما
 * حسابٌ بعد اليوم، وكلٌّ منهما يُرقّى إلى approved مرّةً عند الإقلاع وعند أيّ دخولٍ ناجح لصاحبه.
 */
export const LEGACY_PENDING_STATUSES = ['pending_email', 'pending_review'] as const;
export const INSTANT_PROMOTION_MARKER = 'ax-v2-instant';

/**
 * ترقية الإرث **مرّةً واحدة** عند الإقلاع: علامة OpsMarker `ax-v2-instant` تُحجز ذرّياً (نسختان تقلعان معاً لا ترقّيان
 * مرّتين)، ثمّ updateMany لكلّ pending_* ⇒ approved وحدثٌ ملخّص `system` بالعدد. الفشل يحرّر العلامة فيُعاد في الإقلاع
 * التالي (والدخول يرقّي صاحبه في الأثناء). **لا ترمي أبداً** — آمنةٌ في مسار الإقلاع.
 *
 * يوصلها الوكيل B في index.ts بعد الإقلاع: `void promoteLegacyPendingAffiliates();` — تُعيد عدد المرقَّين، أو null إن
 * سبقتها نسخةٌ أو إقلاعٌ سابق أو فشلت.
 */
export async function promoteLegacyPendingAffiliates(): Promise<number | null> {
  try {
    const won = await prisma.opsMarker.create({ data: { key: INSTANT_PROMOTION_MARKER, value: 'running' } }).then(() => true, () => false);
    if (!won) return null;
    try {
      const count = await prisma.$transaction(async tx => {
        const r = await tx.affiliateUser.updateMany({
          where: { status: { in: [...LEGACY_PENDING_STATUSES] } },
          data: { status: 'approved', reviewedAt: new Date(), reviewedBy: 'system' },
        });
        await logEvent(tx, {
          entity: 'user', entityId: INSTANT_PROMOTION_MARKER, action: 'legacy_pending_promoted', toState: 'approved',
          actorType: 'system', reason: 'الانضمام فوريّ (v2)', meta: { count: r.count },
        });
        return r.count;
      });
      await prisma.opsMarker.update({ where: { key: INSTANT_PROMOTION_MARKER }, data: { value: `done:${count}` } });
      if (count) console.log(`[affiliate] v2: promoted ${count} legacy pending ambassadors to approved`);
      return count;
    } catch (e) {
      await prisma.opsMarker.delete({ where: { key: INSTANT_PROMOTION_MARKER } }).catch(() => { /* يبقى للإقلاع التالي أن يحاول */ });
      throw e;
    }
  } catch (e) {
    console.error('[affiliate] legacy promotion failed:', (e as Error).message);
    return null;
  }
}

/** ترقية صاحب الحساب نفسه عند دخوله الناجح (أو استعادته كلمة المرور) — مشروطةٌ بحالته فلا تكتب فوق إيقافٍ متزامن */
export async function promoteLegacyAffiliate(id: string, fromStatus: string): Promise<boolean> {
  if (!(LEGACY_PENDING_STATUSES as readonly string[]).includes(fromStatus)) return false;
  const won = await prisma.affiliateUser.updateMany({
    where: { id, status: fromStatus },
    data: { status: 'approved', reviewedAt: new Date(), reviewedBy: 'system' },
  });
  if (won.count !== 1) return false;
  logEventSafe({ entity: 'user', entityId: id, action: 'legacy_pending_promoted', fromState: fromStatus, toState: 'approved', actorType: 'system', reason: 'الانضمام فوريّ (v2)' });
  return true;
}

// ───────────────────────────── المصادقة ─────────────────────────────

/** سرّ مشتقّ — توكن لوحة الشركة لا يُفكّ هنا، وتوكن السفير لا يُفكّ هناك */
export function affiliateSecret(): string {
  const base = process.env.JWT_SECRET;
  if (!base) throw new Error('JWT_SECRET غير مضبوط');
  return process.env.AFFILIATE_JWT_SECRET || `${base}::affiliate`;
}

export interface AffiliateSession { uid: string; kind: 'affiliate'; tv: number }
// 'ax-verify' إرث: لا يُوقَّع بعد الانضمام الفوريّ (v2)، ويبقى في النوع ليُرفض صراحةً أينما قُدِّم
type Purpose = 'ax-verify' | 'ax-reset';

export function signSession(uid: string, tokenVersion: number): string {
  return jwt.sign({ uid, kind: 'affiliate', tv: tokenVersion }, affiliateSecret(), { expiresIn: '7d' });
}

export function verifySession(token: string): AffiliateSession | null {
  try {
    const p = jwt.verify(token, affiliateSecret()) as Partial<AffiliateSession> & { purpose?: string };
    if (p.kind !== 'affiliate' || typeof p.uid !== 'string' || typeof p.tv !== 'number' || p.purpose) return null;
    return { uid: p.uid, kind: 'affiliate', tv: p.tv };
  } catch { return null; }
}

/** رموز الغرض الواحد (تأكيد البريد/الاستعادة) — لا تصلح جلسةً ولا العكس */
export function signPurpose(purpose: Purpose, uid: string, tokenVersion: number, expiresIn: string): string {
  return jwt.sign({ uid, purpose, tv: tokenVersion }, affiliateSecret(), { expiresIn } as jwt.SignOptions);
}

export function verifyPurpose(purpose: Purpose, token: string): { uid: string; tv: number } | null {
  try {
    const p = jwt.verify(token, affiliateSecret()) as { uid?: string; purpose?: string; tv?: number; kind?: string };
    if (p.purpose !== purpose || typeof p.uid !== 'string' || typeof p.tv !== 'number' || p.kind) return null;
    return { uid: p.uid, tv: p.tv };
  } catch { return null; }
}

/** scrypt: `salt:hash` — النمط نفسه في منصّة الصيد */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`;
}

const DUMMY_HASH = hashPassword(crypto.randomBytes(12).toString('hex'));

/** يستهلك الزمن نفسه وإن لم يوجد الحساب — لا قناة زمنية لتعداد البُرُد */
export function verifyPassword(password: string, stored: string | null | undefined): boolean {
  const [salt, hash] = String(stored || DUMMY_HASH).split(':');
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  const ok = candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
  return ok && !!stored;
}

export function ipHash(ip: string | undefined): string | null {
  if (!ip) return null;
  return crypto.createHash('sha256').update(ip + (process.env.IP_SALT || 'fieldsa-visits')).digest('hex').slice(0, 16);
}

// ───────────────────────────── تشفير الآيبان ─────────────────────────────

function ibanKey(): Buffer {
  const raw = process.env.AFFILIATE_IBAN_KEY;
  if (raw) {
    const k = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
    if (k.length === 32) return k;
  }
  return crypto.createHash('sha256').update(`${affiliateSecret()}::iban`).digest();
}

/** AES-256-GCM: `iv:tag:cipher` بـhex */
export function encryptIban(iban: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', ibanKey(), iv);
  const enc = Buffer.concat([c.update(iban, 'utf8'), c.final()]);
  return `${iv.toString('hex')}:${c.getAuthTag().toString('hex')}:${enc.toString('hex')}`;
}

export function decryptIban(stored: string): string | null {
  try {
    const [iv, tag, enc] = stored.split(':');
    const d = crypto.createDecipheriv('aes-256-gcm', ibanKey(), Buffer.from(iv, 'hex'));
    d.setAuthTag(Buffer.from(tag, 'hex'));
    return Buffer.concat([d.update(Buffer.from(enc, 'hex')), d.final()]).toString('utf8');
  } catch { return null; }
}

// ───────────────────────────── مساعدات ─────────────────────────────

export function frontendBase(): string {
  return (process.env.FRONTEND_URL || 'https://fieldsa.net').split(',')[0].trim().replace(/\/$/, '');
}

/**
 * رابط السفير **مباشرةً إلى صفحة التسجيل** (V2_SPEC §6.1، قرار المالك ١٨ نوفمبر ٢٠٢٦): `refFromSearch` في الواجهة
 * يلتقط `?ref=` من أيّ مسار، والزائر يصل نموذج التسجيل بلا خطوة «جرّب مجاناً».
 */
export function referralLink(code: string): string {
  return `${frontendBase()}/signup?ref=${code}`;
}

/** اليوم بتوقيت الرياض (+٣ بلا توقيت صيفي) */
export function riyadhDay(d: Date = new Date()): string {
  return new Date(d.getTime() + 3 * 3600_000).toISOString().slice(0, 10);
}

export function escapeHtml(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));
}

export function isUniqueViolation(e: unknown, field?: string): boolean {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== 'P2002') return false;
  if (!field) return true;
  const target = (e.meta as { target?: unknown } | undefined)?.target;
  return Array.isArray(target) ? target.includes(field) : String(target ?? '').includes(field);
}

export const DAY_MS = 24 * 3600_000;
