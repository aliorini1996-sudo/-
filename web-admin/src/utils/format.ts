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
  if (l === 'en') return 'en-US-u-ca-gregory';
  if (l === 'fr') return 'fr-FR-u-ca-gregory';
  if (l === 'tr') return 'tr-TR-u-ca-gregory';
  if (l === 'zh') return 'zh-CN-u-ca-gregory';
  // `ca-gregory` صريحاً (طلب المالك ١٣ نوفمبر ٢٠٢٦: «التاريخ الميلادي في جميع الصفحات بلا استثناء، وأزل الهجري نهائياً»):
  // ar-SA تقويمه الافتراضي في Safari/iOS وبعض WebView أندرويد أمّ القرى الهجري، فبلا المفتاح يظهر «١٤٤٨ هـ» على جوالات المناديب
  return activeNumerals === 'latin' ? 'ar-SA-u-ca-gregory-nu-latn' : 'ar-SA-u-ca-gregory-nu-arab';
}

/**
 * locale بتقويمٍ ميلادي صريح — لكل تنسيق تاريخ أو وقت خارج هذا الملف (toLocaleDateString/toLocaleTimeString/Intl.DateTimeFormat
 * و toLocaleString على تاريخ). يضع `ca-gregory` في امتداد -u- ويستبدل أي تقويمٍ آخر (islamic-umalqura وأمثاله)، ويحفظ ما سواه
 * (نظام الترقيم nu). وبلا locale (لغة الجهاز): لغة الجهاز نفسها بتقويمٍ ميلادي — فإعداد «التقويم الهجري» في الجوال لا يتسرّب.
 */
export function gregorianLocale(loc?: string | null): string {
  let base = (loc ?? '').trim();
  if (!base) {
    try { base = new Intl.DateTimeFormat().resolvedOptions().locale || 'ar'; } catch { base = 'ar'; }
  }
  const i = base.toLowerCase().indexOf('-u-');
  if (i < 0) return `${base}-u-ca-gregory`;
  const head = base.slice(0, i);
  // مفاتيح الامتداد أزواج «مفتاح-قيمة(ـقيم)»: يُسقط ca بقيمه ثم يوضع ca-gregory أولاً
  const parts = base.slice(i + 3).split('-');
  const kept: string[] = [];
  for (let k = 0; k < parts.length; k++) {
    if (parts[k].toLowerCase() === 'ca') { while (k + 1 < parts.length && parts[k + 1].length > 2) k++; continue; }
    kept.push(parts[k]);
  }
  return `${head}-u-ca-gregory${kept.length ? `-${kept.join('-')}` : ''}`;
}

/** الـlocale نفسه للاستعمال خارج هذا الملف (شاشات تنسّق بنفسها) */
export function activeLocale(): string { return locale(); }

// عملة العرض النشطة — تُضبط من إعدادات الشركة عند الإقلاع (افتراضي ر.س السعودي)
let activeCurrency = 'SAR';
export function setActiveCurrency(c?: string | null) { if (c && c.trim()) activeCurrency = c; }
export function getActiveCurrency() { return activeCurrency; }

/**
 * ينسّق مبلغًا بعملة الشركة النشطة (أو عملة مُمرَّرة صراحةً) بخاناتها العشرية (٢/٣).
 *
 * `maxDecimals` لسعرِ **وحدة** لا لمبلغ: تكلفة الوحدة تُخزَّن بأربع خانات
 * (شراء ٣ حبّات بريال = ٠٫٣٣٣٣)، فعرضها بخانتين يجعل «المتوسّط × الكمية»
 * لا يساوي القيمة المعروضة بجانبه فيبدو النظام متناقضاً وهو سليم.
 */
export function formatCurrency(amount: number | string, currency?: string, maxDecimals?: number) {
  const cur = currency || activeCurrency;
  const base = currencyDecimals(cur);
  const dec = maxDecimals != null ? Math.max(base, maxDecimals) : base;
  return new Intl.NumberFormat(locale(), {
    style: 'currency', currency: cur,
    minimumFractionDigits: base, maximumFractionDigits: dec,
  }).format(Number(amount));
}

/**
 * تاريخُ **لحظة**. `timeZone` اختياري: حين يُمرَّر تُعرض اللحظة بمنطقةٍ بعينها لا بمنطقة المتصفّح.
 *
 * كشف الحساب يُرشَّح على الخادم بأيام **الشركة** (البند 22)، فحركةُ أول يناير المخزَّنة
 * 2025-12-31T21:00:00Z تدخل كشف يناير؛ وعرضها بمنطقة القارئ يكتب بجانبها «٣١ ديسمبر»
 * فيبدو الكشف مبدوءاً بيوم الجار. تمريرُ منطقة الشركة يُبقي المعروض والمُرشَّح يوماً واحداً.
 * (المعامل اختياري فلا يتغيّر شيء في النداءات القائمة.)
 *
 * و`null` قيمةٌ مشروعة لا خطأ: الخادم يعيد `timezone: null` حين لا تكون للشركة منطقةٌ
 * مضبوطة، فيرتدّ العرض إلى منطقة المتصفّح **ارتداداً صريحاً**. وقبولها في التوقيع
 * يمنع كسر `tsc` عند كل شاشةٍ تمرّر ما وصلها من الخادم كما وصل.
 */
export function formatDate(date: string | Date, timeZone?: string | null) {
  const d = new Date(date);
  if (isNaN(d.getTime())) return '-';
  const opts: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'short', day: 'numeric' };
  // منطقة غير صالحة ترمي RangeError وتُسقط الشاشة كلها: العرض بمنطقة المتصفّح أهون من صفحة بيضاء
  if (timeZone) {
    try { return new Intl.DateTimeFormat(locale(), { ...opts, timeZone }).format(d); } catch { /* ارتداد */ }
  }
  return new Intl.DateTimeFormat(locale(), opts).format(d);
}

/**
 * تاريخٌ رقميّ مضغوط (يوم/شهر/سنة) — لأعمدة ضيّقة على عرض الجوال حيث لا يتّسع
 * اسم الشهر. نفس الـlocale ونظام الترقيم الذي تختاره الشركة.
 */
export function formatDateShort(date: string | Date | null | undefined) {
  if (!date) return '-';
  const d = new Date(date);
  if (isNaN(d.getTime())) return '-';
  return new Intl.DateTimeFormat(locale(), {
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

/**
 * تاريخُ **يومٍ خالص** (لا لحظة): يُقرأ بأجزائه النصّية لا بمنطقة القارئ.
 *
 * deliveryDate يُخزَّن منتصف ليل UTC، وformatDate تعرضه بتوقيت المتصفّح —
 * فمتصفّحٌ غرب غرينتش يعرض اليوم السابق: موعد تسليمٍ في ٧ سبتمبر يقرؤه
 * المحاسب في الرياض صحيحاً ويقرؤه شريكٌ في نيويورك «٦ سبتمبر». وهو يومٌ
 * اتُّفق عليه مع العميل لا لحظةٌ زمنية، فلا معنى لإزاحته بمنطقة أحد.
 */
export function formatDayOnly(v: string | Date | null | undefined) {
  if (!v) return '-';
  const iso = typeof v === 'string' ? v : new Date(v).toISOString();
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return formatDate(iso as string);
  // يُبنى بمنطقة المتصفّح من الأجزاء نفسها، فلا إزاحة ولا انزلاق
  return new Intl.DateTimeFormat(locale(), { year: 'numeric', month: 'short', day: 'numeric' })
    .format(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
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

/**
 * يومُ لحظةٍ بالنسبة لليوم الحالي على الجهاز: '' لليوم، و«أمس» (بلغة الواجهة)، وإلا تاريخ مختصر.
 *
 * عرضُ الساعة وحدها للحظةٍ من يوم سابق يوهم أنها في المستقبل: «آخر ظهور ١٠:٤٧ م» تُقرأ صباحاً وقتاً
 * لم يأتِ بعد وهي أمس ليلاً، و«أنت في العمل منذ ١٠:٥٤ ص» لنوبة فُتحت أمس ولم تُغلق تبدو ساعةً قادمة.
 */
export function dayLabel(date: string | Date): string {
  const d = new Date(date);
  if (isNaN(d.getTime())) return '';
  const now = new Date();
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((startOf(now) - startOf(d)) / 86400000);
  if (diff === 0) return '';
  if (diff === 1) {
    try { return new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' }).format(-1, 'day'); } catch { /* ارتداد للتاريخ */ }
  }
  return new Intl.DateTimeFormat(locale(), { month: 'short', day: 'numeric' }).format(d);
}

/** الساعة، ويسبقها يومها إن لم تكن من اليوم: «١٠:٤٧ م» أو «أمس ١٠:٤٧ م» أو «٢٥ سبتمبر ١٠:٤٧ م». */
export function formatMoment(date: string | Date): string {
  const d = new Date(date);
  if (isNaN(d.getTime())) return '-';
  const time = new Intl.DateTimeFormat(locale(), { hour: '2-digit', minute: '2-digit' }).format(d);
  const day = dayLabel(d);
  return day ? `${day} ${time}` : time;
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
