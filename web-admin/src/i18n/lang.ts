import { create } from 'zustand';

export type Lang = 'ar' | 'en';
const KEY = 'app_lang';

function initial(): Lang {
  return localStorage.getItem(KEY) === 'en' ? 'en' : 'ar';
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
