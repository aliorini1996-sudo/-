// ═══ «إزالة الضريبة» (طلب المالك ٧ نوفمبر ٢٠٢٦) — مشترك حرفياً ═══
// ملفٌّ نقيّ بلا استيراد، ونسختان **متطابقتان حرفاً** (يثبته اختبارٌ في الطرفين):
//   backend/src/services/taxMode.ts  ⇄  web-admin/src/lib/taxMode.ts
//
// الطلب: «في حال ازالة الضريبة لا يكون لها ذكر في اي سطر في النظام ولا في اي مستند».
// قرارات المالك: يقلبه مدير الشركة من إعداداته بتنبيه وتأكيد؛ يُمنع ما دام ربط المرحلة الثانية مع الهيئة مفعّلاً؛ المستندات السابقة
// تبقى كما صدرت (Invoice.taxFree يختم كل مستند)؛ السعر المكتوب نهائي (لا تعديل آلي لأي سعر)؛ Product.taxPct تبقى مخزّنة فالإعادة ترجع كل شيء.
//
// القاعدة: الشركة «بلا ضريبة» ⇒ النسبة الفعلية لكل بندٍ جديد صفر، ولا يظهر في أي شاشة أو مستند جديد: ضريبة، نسبة، «شامل الضريبة»،
// «قبل الضريبة»، الرقم الضريبي (للبائع أو المشتري)، رمز QR الهيئة أو تعليقه، «فاتورة ضريبية»، «إشعار دائن/مدين». عنوان البيع «فاتورة»
// وعنوان المرتجع «فاتورة مرتجع». ويبقى في الإعدادات المفتاح نفسه وحده لإعادة الضريبة.

/** حقول الشركة التي يقرؤها الوضع (CompanySettings) — الغائب = سلوك اليوم */
export interface TaxModeCompany {
  taxDisabled?: boolean | null;
}

/** هل الشركة «بلا ضريبة»؟ (صريحاً true وحده؛ غيابه أو كاشٌ قديم = سلوك اليوم حرفياً) */
export function isTaxOff(c: TaxModeCompany | null | undefined): boolean {
  return c?.taxDisabled === true;
}

/** النسبة الفعلية لبندٍ جديد: صفر للشركة «بلا ضريبة»، وإلا نسبة الصنف كما هي */
export function effectiveTaxPct(c: TaxModeCompany | null | undefined, productTaxPct: number | string | null | undefined): number {
  if (isTaxOff(c)) return 0;
  const n = Number(productTaxPct);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** المستند كما يقرؤه العرض والطباعة: مختومٌ «بلا ضريبة» (Invoice.taxFree) */
export interface TaxModeDoc {
  taxFree?: boolean | null;
}

/** هل يُعرض المستند ويُطبع بلا أي ذكرٍ للضريبة؟ الختم وحده يحكم — المستند القديم بضريبته كما صدر ولو أُزيلت الضريبة بعده */
export function isDocTaxFree(d: TaxModeDoc | null | undefined): boolean {
  return d?.taxFree === true;
}

/** عنوانا المستند «بلا ضريبة» */
export const TAX_FREE_TITLES = { sale: 'فاتورة', return: 'فاتورة مرتجع' } as const;

/** رموز الرفض ورسائلها (الخادم يردّها، والواجهة تمرّرها بـtr) */
export const TAX_MODE_CODES = {
  /** جهازٌ أرسل نسبة ضريبة لشركةٍ أُزيلت ضريبتها (حزمة أو بيانات قديمة) — إصدارٌ حيّ */
  changed: 'TAX_MODE_CHANGED',
  /** مفتاح API أرسل نسبة ضريبة لشركةٍ بلا ضريبة */
  disabled: 'TAX_DISABLED',
  /** قلب المفتاح ممنوع ما دام ربط المرحلة الثانية مفعّلاً */
  zatcaConflict: 'TAX_MODE_ZATCA_CONFLICT',
  /** تفعيل ربط المرحلة الثانية ممنوع ما دامت الضريبة مزالة */
  blocksZatca: 'TAX_OFF_BLOCKS_ZATCA',
} as const;

export const TAX_MODE_MESSAGES = {
  TAX_MODE_CHANGED: 'تغيرت إعدادات الشركة حدث الصفحة ثم أعد الإصدار',
  TAX_DISABLED: 'الضريبة مزالة لهذه الشركة أرسل taxPct صفرا أو احذفه',
  TAX_MODE_ZATCA_CONFLICT: 'لا يمكن إزالة الضريبة ما دام ربط الفوترة الإلكترونية (المرحلة الثانية) مفعلا للشركة',
  TAX_OFF_BLOCKS_ZATCA: 'الضريبة مزالة لهذه الشركة أعدها أولا من إعدادات الشركة قبل ربط الفوترة الإلكترونية',
} as const;

/** نصّا المفتاح في الإعدادات (يبقى وحده ظاهراً لإعادة الضريبة) */
export const TAX_MODE_LABEL = 'إزالة الضريبة';
export const TAX_MODE_HINT = 'للمنشأة غير المسجلة في ضريبة القيمة المضافة: لا ضريبة ولا رقم ضريبي ولا رمز QR في أي شاشة أو مستند جديد والسعر المكتوب للصنف هو ما يدفعه العميل والمستندات السابقة تبقى كما صدرت';
export const TAX_MODE_CONFIRM_OFF = 'إزالة الضريبة تعني أن منشأتك غير مسجلة في ضريبة القيمة المضافة فلا تحصل ضريبة ولا تظهر في أي مستند جديد — أتتابع؟';
