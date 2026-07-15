// قنوات البيع (تصنيف مؤسسي للعملاء) — مصدر واحد للنموذج والفلترة والتقارير.
// القيم تُخزَّن كأكواد ثابتة؛ التسميات ثنائية اللغة للعرض.
export type SalesChannel = 'MT' | 'WHOLESALE' | 'TT' | 'DISCOUNTER' | 'CASH_VAN' | 'ECOMMERCE';

export const SALES_CHANNELS: { code: SalesChannel; ar: string; en: string }[] = [
  { code: 'MT',         ar: 'التجارة الحديثة',      en: 'Modern Trade' },
  { code: 'WHOLESALE',  ar: 'الجملة',               en: 'Wholesale' },
  { code: 'TT',         ar: 'التجارة التقليدية',    en: 'Traditional Trade' },
  { code: 'DISCOUNTER', ar: 'متاجر التخفيضات',      en: 'Discounters' },
  { code: 'CASH_VAN',   ar: 'البيع النقدي المتنقّل', en: 'Cash Van' },
  { code: 'ECOMMERCE',  ar: 'التجارة الإلكترونية',  en: 'E-Commerce' },
];

// تسمية القناة حسب اللغة (يرجع الكود نفسه إن كان غير معروف/فارغاً)
export function channelLabel(code?: string | null, lang: 'ar' | 'en' = 'ar'): string {
  if (!code) return '—';
  const c = SALES_CHANNELS.find((x) => x.code === code);
  return c ? c[lang] : code;
}
