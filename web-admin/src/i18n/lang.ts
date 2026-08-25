import { create } from 'zustand';

export type Lang = 'ar' | 'en' | 'fr' | 'tr'; // الفرنسية للمغرب العربي، والتركية لسوق تركيا — كلتاهما LTR
const KEY = 'app_lang';

// مسارات التطبيق (لا SEO): الدخول/التسجيل/اللوحة/المندوب/المالك — تدعم اختيار اللغة يدويًا (بما فيها الفرنسية)
export function isAppRoute(p: string): boolean {
  // `m` بحدّ نهاية: كي لا يلتقط /maghreb أو أي مسار تسويقيّ يبدأ بالحرف نفسه
  return /^\/(app|rep|pos|kds|platform|login|signup|verify)/.test(p) || /^\/m(\/|$)/.test(p);
}

function initial(): Lang {
  if (typeof window !== 'undefined') {
    const p = window.location.pathname;
    // داخل التطبيق: تُحترم اللغة المحفوظة يدويًا — تدعم الفرنسية أيضًا
    if (isAppRoute(p)) {
      const saved = localStorage.getItem(KEY);
      if (saved === 'ar' || saved === 'en' || saved === 'fr' || saved === 'tr') return saved;
    }
    // على صفحات التسويق: اللغة مشتقّة من المسار (/en · /fr) لتطابق الفهرسة الدولية بلا وميض
    if (p === '/en' || p.startsWith('/en/')) return 'en';
    if (p === '/fr' || p.startsWith('/fr/')) return 'fr';
    if (p === '/tr' || p.startsWith('/tr/')) return 'tr';
    return 'ar';
  }
  return 'ar';
}

// يضبط لغة واتجاه المستند (يؤثّر على عناصر تعتمد على html[dir])
function applyDoc(lang: Lang) {
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
