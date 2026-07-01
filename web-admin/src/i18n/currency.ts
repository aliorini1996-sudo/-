import { create } from 'zustand';

// عملة عرض الأسعار في الصفحة التعريفية — تُبدَّل يدويًا مثل اللغة، ويُحفظ الاختيار محليًا
export type Currency = 'sar' | 'usd';
const KEY = 'app_currency';

function initial(): Currency {
  if (typeof window !== 'undefined') {
    const saved = localStorage.getItem(KEY);
    if (saved === 'usd' || saved === 'sar') return saved;
  }
  return 'sar';
}

interface CurrencyState {
  currency: Currency;
  setCurrency: (c: Currency) => void;
  toggle: () => void;
}

export const useCurrency = create<CurrencyState>((set, get) => ({
  currency: initial(),
  setCurrency: (c) => { localStorage.setItem(KEY, c); set({ currency: c }); },
  toggle: () => get().setCurrency(get().currency === 'sar' ? 'usd' : 'sar'),
}));
