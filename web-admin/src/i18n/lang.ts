import { create } from 'zustand';
import { i18nPageAt } from './i18nPublished';
import { uiLangFor } from './i18nRoutes.mjs';

export type Lang = 'ar' | 'en' | 'fr' | 'tr' | 'zh'; // العربية وحدها RTL، وما عداها LTR
const KEY = 'app_lang';

// مسارات التطبيق (لا SEO): الدخول/التسجيل/اللوحة/المندوب/المالك — تدعم اختيار اللغة يدويًا (بما فيها الفرنسية)
export function isAppRoute(p: string): boolean {
  // `m` بحدّ نهاية: كي لا يلتقط /maghreb أو أي مسار تسويقيّ يبدأ بالحرف نفسه
  // `owner` هنا إلزاماً: /platform يحوّل إليه، وغيابه يجعل LocaleSync يشتقّ اللغة
  // من المسار فتُفرض العربية على شاشة دخول المالك مهما اختار المستخدم.
  // `ax` (بوابة السفير) بحدّ نهاية: متعدّدة اللغات بمبدّل التطبيق نفسه وتتبع لغته
  // المحفوظة — فلا يدهس LocaleSync اختيار السفير باشتقاق اللغة من المسار.
  // `activate` (تفعيل حساب شركةٍ فتحه سفير) بحدّ نهاية: مبدّل اللغة فيها يضبط اللغة بلا تنقّل
  // إلى /en… — فالرمز المحفوظ في الذاكرة لا يضيع بإعادة تحميل.
  // `staff` (لوحة موظف المنصة ودخوله) بحدّ نهاية: غيابه كان يقذف مبدّل اللغة إلى /en/staff (٤٠٤) ويفرض LocaleSync العربية.
  return /^\/(app|rep|pos|kds|platform|owner|login|signup|verify)/.test(p) || /^\/(m|ax|activate|staff)(\/|$)/.test(p);
}

/**
 * مسارا التحويل من صفحة «سفراء فيلد سيلز» إلى البوابة (`/ambassadors/join` و`/ambassadors/login`، App.tsx):
 * ليسا مسار تطبيق (isAppRoute منسوخٌ نصّاً في i18nRoutes.mjs) لكنّهما **يتبعان اللغة المحفوظة** مثله —
 * فتحهما بتحميلٍ كامل (تبويبٌ جديد، ضغطٌ مطوّل) من /en/ambassadors أو /fr/ambassadors كان يشتقّ العربية
 * من المسار (بلا بادئة) فتفتح البوابة عربيةً، مع أنّ LocaleSync حفظ لغة الصفحة عند زيارتها.
 */
export const AMBASSADORS_REDIRECT = /^\/ambassadors\/(join|login)\/?$/;

/** لغة الإقلاع لمسارٍ ولغةٍ محفوظة — نقيّة (initial() يمرّر الموقع وlocalStorage) */
const isLang = (v: string | null): v is Lang => v === 'ar' || v === 'en' || v === 'fr' || v === 'tr' || v === 'zh';

/** ‎?lang=‎ على مساري التحويل إلى بوابة السفير وحدهما (أزرار الصفحة العلنية بلغتها) — وإلا null */
export function redirectLangParam(p: string, search: string): Lang | null {
  if (!AMBASSADORS_REDIRECT.test(p)) return null;
  try { const v = new URLSearchParams(search).get('lang'); return isLang(v) ? v : null; } catch { return null; }
}

export function initialLangFor(p: string, saved: string | null, search = ''): Lang {
  // زرّا صفحة السفراء يحملان لغتها صراحةً — مقدَّمةً على المحفوظ (زائرٌ أول لا لغة محفوظة له)
  const explicit = redirectLangParam(p, search);
  if (explicit) return explicit;
  // داخل التطبيق (ومسارا التحويل إلى بوابة السفير): تُحترم اللغة المحفوظة يدويًا — تدعم الفرنسية أيضًا
  if (isAppRoute(p) || AMBASSADORS_REDIRECT.test(p)) {
    if (saved === 'ar' || saved === 'en' || saved === 'fr' || saved === 'tr' || saved === 'zh') return saved;
  }
  // صفحات الطبقة متعددة اللغات (/es/ و/languages/…): لغة الواجهة من الخمس — الإنجليزية لغيرها
  const i = i18nPageAt(p);
  if (i) return uiLangFor(i.code);
  // على صفحات التسويق: اللغة مشتقّة من المسار (/en · /fr) لتطابق الفهرسة الدولية بلا وميض
  if (p === '/en' || p.startsWith('/en/')) return 'en';
  if (p === '/fr' || p.startsWith('/fr/')) return 'fr';
  if (p === '/tr' || p.startsWith('/tr/')) return 'tr';
  if (p === '/zh' || p.startsWith('/zh/')) return 'zh';
  return 'ar';
}

function savedLang(): string | null {
  try { return localStorage.getItem(KEY); } catch { return null; }
}

function initial(): Lang {
  if (typeof window !== 'undefined') {
    const { pathname, search } = window.location;
    const explicit = redirectLangParam(pathname, search);
    // تُحفظ فتبقى البوابة بلغة الصفحة بعد التحويل وإعادة التحميل
    if (explicit) { try { localStorage.setItem(KEY, explicit); } catch { /* تخزينٌ محجوب */ } }
    return initialLangFor(pathname, savedLang(), search);
  }
  return 'ar';
}

// يضبط لغة واتجاه المستند (يؤثّر على عناصر تعتمد على html[dir])
// لا يمسّهما على صفحات الطبقة متعددة اللغات: prerender كتب lang وdir الصحيحين (es/ltr، ur/rtl…) والصفحة تتولاهما —
// ولغة الواجهة هناك («en» لـ/es/) ليست لغة المستند.
function applyDoc(lang: Lang) {
  if (typeof window !== 'undefined' && window.location && i18nPageAt(window.location.pathname)) return;
  if (typeof document !== 'undefined') {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  }
}

interface LangState {
  lang: Lang;
  setLang: (l: Lang) => void;
  toggle: () => void;
}

export const useLang = create<LangState>((set, get) => ({
  lang: initial(),
  setLang: (l) => { localStorage.setItem(KEY, l); applyDoc(l); set({ lang: l }); },
  toggle: () => get().setLang(get().lang === 'ar' ? 'en' : 'ar'),
}));

// تطبيق الاتجاه عند أول إقلاع
applyDoc(initial());

// اتجاه الكتابة المشتق من اللغة الحالية
export function useDir(): 'rtl' | 'ltr' {
  return useLang((s) => s.lang) === 'ar' ? 'rtl' : 'ltr';
}
