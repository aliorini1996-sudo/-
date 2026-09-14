import { create } from 'zustand';

// دورة عرض الأسعار في الصفحة التعريفية (شهري ⇄ سنوي) — تُبدَّل يدويًا مثل العملة، ويُحفظ الاختيار محليًا
export type Billing = 'monthly' | 'yearly';
const KEY = 'app_billing';

function initial(): Billing {
  try {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem(KEY);
      if (saved === 'monthly' || saved === 'yearly') return saved;
    }
  } catch { /* تخزينٌ محجوب — الشهري افتراضاً */ }
  return 'monthly';
}

interface BillingState {
  billing: Billing;
  setBilling: (b: Billing) => void;
}

export const useBilling = create<BillingState>((set) => ({
  billing: initial(),
  setBilling: (b) => {
    try { localStorage.setItem(KEY, b); } catch { /* تخزينٌ محجوب */ }
    set({ billing: b });
  },
}));
