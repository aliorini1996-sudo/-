// تعريفات الأنواع لبيانات صفحات الميزات (features.mjs) — ليقبله الفحص الصارم tsc.
// المصدر واحد: البيانات في features.mjs يقرأها كلٌّ من مكوّن React والتصيير المسبق
// وخريطة الموقع. لا نسخة ثانية — فالمصدر المزدوج فخّ دفعنا ثمنه في التصيير المسبق.

export interface FeatureBlock { title: string; body: string }
export interface FeatureFaq { q: string; a: string }

export interface Feature {
  id: string;
  /** مسار عربي — الكلمة المفتاحية داخل الرابط نفسه */
  slug: string;
  /** اسم الميزة كما يسمّيها المشتري لا كما نسمّيها داخلياً */
  name: string;
  /** H1 — العبارة الشرائية حرفياً */
  h1: string;
  /** سطر الألم: المشكلة قبل الحل، بلغة الميدان */
  pain: string;
  /** مشهد اليوم الواقعي الذي تعيشه هذه الميزة */
  scene: string;
  /** كيف تعمل فعلاً — مكتوبة من قراءة الكود لا من التسويق */
  how: FeatureBlock[];
  /** ما لا تفعله هذه القدرة — إلزاميّ في كل ميزة */
  limits: string[];
  faq: FeatureFaq[];
  /** ملفات الكود التي تُثبت كل ما سبق (للمراجعة لا للعرض) */
  proof: string[];
  /** المقال المقترن (زوج هبوط + مقال) */
  pairSlug?: string;
  /** النموذج المقترن في بنك النماذج */
  templateSlug?: string;
}

export const FEATURES: Feature[];
export function featureBySlug(slug: string): Feature | undefined;
