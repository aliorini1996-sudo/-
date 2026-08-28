import { currencyDecimals } from '../i18n/countries';
import { useLang } from '../i18n/lang';

/**
 * شكل الأرقام المختار للشركة: arabic = ٠١٢٣ · latin = 0123.
 * يُضبط عند الإقلاع من إعدادات الشركة (كما تُضبط العملة).
 */
let activeNumerals: 'arabic' | 'latin' = 'arabic';
export function setActiveNumerals(v?: string | null) {
  if (v === 'arabic' || v === 'latin') activeNumerals = v;
}
export function getActiveNumerals() { return activeNumerals; }

/**
 * الـlocale الحالي للتنسيق — لغة الواجهة + **نظام الترقيم المختار**.
 *
 * إلحاق `-u-nu-latn` أو `-u-nu-arab` هو المفتاح: Intl يطبّقه على الأرقام
 * والتواريخ والعملات معاً، فيسري خيار الشركة على كل رقم في المنصة من نقطة
 * واحدة بدل مطاردته في عشرات الشاشات.
 *
 * اللغات اللاتينية تبقى لاتينية دائماً — «أرقام عربية» في واجهة إنجليزية
 * قراءة لا يريدها أحد، والخيار مقصود به الواجهة العربية.
 */
function locale(): string {
  const l = useLang.getState().lang;
  if (l === 'en') return 'en-US';
  if (l === 'fr') return 'fr-FR';
  if (l === 'tr') return 'tr-TR';
  return activeNumerals === 'latin' ? 'ar-SA-u-nu-latn' : 'ar-SA-u-nu-arab';
}

/** الـlocale نفسه للاستعمال خارج هذا الملف (شاشات تنسّق بنفسها) */
export function activeLocale(): string { return locale(); }

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
  CASH: 'نقدي', BANK_TRANSFER: 'تحويل بنكي', POS: 'شبكة', CHEQUE: 'شيك', ONLINE: 'دفع الكتروني',
};
