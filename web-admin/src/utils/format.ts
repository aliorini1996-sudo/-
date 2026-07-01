import { currencyDecimals } from '../i18n/countries';
import { useLang } from '../i18n/lang';

// الـlocale الحالي حسب لغة الواجهة (لتنسيق الأرقام والتواريخ) — عربي/إنجليزي/فرنسي
function locale(): string {
  const l = useLang.getState().lang;
  return l === 'en' ? 'en-US' : l === 'fr' ? 'fr-FR' : 'ar-SA';
}

// عملة العرض النشطة — تُضبط من إعدادات الشركة عند الإقلاع (افتراضي ر.س السعودي)
let activeCurrency = 'SAR';
export function setActiveCurrency(c?: string | null) { if (c && c.trim()) activeCurrency = c; }
export function getActiveCurrency() { return activeCurrency; }

// ينسّق مبلغًا بعملة الشركة النشطة (أو عملة مُمرَّرة صراحةً) بخاناتها العشرية الصحيحة (٢/٣)
export function formatCurrency(amount: number | string, currency?: string) {
  const cur = currency || activeCurrency;
  const dec = currencyDecimals(cur);
  return new Intl.NumberFormat(locale(), {
    style: 'currency', currency: cur,
    minimumFractionDigits: dec, maximumFractionDigits: dec,
  }).format(Number(amount));
}

export function formatDate(date: string | Date) {
  const d = new Date(date);
  if (isNaN(d.getTime())) return '-';
  return new Intl.DateTimeFormat(locale(), {
    year: 'numeric', month: 'short', day: 'numeric',
  }).format(d);
}

export function formatDateTime(date: string | Date) {
  const d = new Date(date);
  if (isNaN(d.getTime())) return '-';
  return new Intl.DateTimeFormat(locale(), {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(d);
}

export function formatTime(date: string | Date) {
  const d = new Date(date);
  if (isNaN(d.getTime())) return '-';
  return new Intl.DateTimeFormat(locale(), {
    hour: '2-digit', minute: '2-digit',
  }).format(d);
}

export function formatNumber(n: number | string) {
  return new Intl.NumberFormat(locale()).format(Number(n));
}

export const statusLabels: Record<string, string> = {
  ACTIVE: 'نشط', INACTIVE: 'غير نشط', BLOCKED: 'محظور',
  CONFIRMED: 'معتمد', CANCELLED: 'ملغي', DRAFT: 'مسودة',
  CASH: 'نقدي', CREDIT: 'آجل', RETURN: 'مرتجع',
  BANK_TRANSFER: 'تحويل بنكي', POS: 'شبكة', CHEQUE: 'شيك',
};

export const paymentMethodLabels: Record<string, string> = {
  CASH: 'نقدي', BANK_TRANSFER: 'تحويل بنكي', POS: 'شبكة', CHEQUE: 'شيك',
};
