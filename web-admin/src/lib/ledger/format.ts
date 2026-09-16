import { activeLocale } from '../../utils/format';

/**
 * تنسيق مبالغ الدفاتر (§8.3) فوق `utils/format.ts`: الـlocale نفسه (لغة الواجهة +
 * نظام الترقيم المختار للشركة `activeNumerals`)، والسالب **بعلامة لاحقة** «3,210.34-».
 *
 * ⚠️ الناتج نصّ خام اتجاهه ملتبس: داخل فقرة RTL تنتقل `-` اللاحقة يسار الرقم بخوارزمية
 * Bidi. لا يُلصق في جملة عربية — يُعرض دائماً عبر `<LedgerAmount>` الذي يعزله بـ`<bdi dir="ltr">`.
 */

export type NegativeStyle = 'trailing' | 'leading';

export interface LedgerAmountOptions {
  /** منازل العملة (2 أو 3) — من `GlSettings.currencyDecimals` */
  decimals: number;
  /** الافتراضي `trailing` (نمط Odoo والقوائم المالية) */
  negativeStyle?: NegativeStyle;
  /** locale صريح (للاختبار أو التصدير)؛ الافتراضي `activeLocale()` */
  locale?: string;
}

/** قيمة مبلغ: رقم (مخرجات API بـserializeMoney)، أو نص عشري، أو bigint بالمللي. */
export type AmountInput = number | string;

const MINUS = '-';

/** يقرّب نصاً عشرياً إلى `decimals` نصف-لأعلى بعيداً عن الصفر (مطابق money.ts في الخادم) بلا فقد دقة عائم. */
function roundDecimalString(abs: string, decimals: number): string {
  const [intRaw, fracRaw = ''] = abs.split('.');
  const intPart = intRaw.replace(/^0+(?=\d)/, '') || '0';
  const padded = (fracRaw + '0'.repeat(decimals + 1)).slice(0, decimals + 1);
  const scaled = BigInt(intPart + padded.slice(0, decimals));
  const roundUp = Number(padded[decimals] ?? '0') >= 5;
  const v = roundUp ? scaled + 1n : scaled;
  if (decimals === 0) return v.toString();
  const s = v.toString().padStart(decimals + 1, '0');
  return `${s.slice(0, -decimals)}.${s.slice(-decimals)}`;
}

/** يطبّع المدخل إلى {negative, abs نصاً عشرياً}؛ غير الصالح ⇒ صفر. */
function normalize(value: AmountInput): { negative: boolean; abs: string } {
  let s: string;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return { negative: false, abs: '0' };
    // toFixed(6) يكفي لمنازل العملة (≤3) ويتفادى الترميز الأسّي للقيم الصغيرة
    s = Math.abs(value) >= 1e21 ? String(value) : value.toFixed(6);
  } else {
    s = String(value).trim();
  }
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (m[2] === '' && (m[3] ?? '') === '')) return { negative: false, abs: '0' };
  return { negative: m[1] === '-', abs: `${m[2] || '0'}.${m[3] ?? ''}` };
}

/** نتيجة التنسيق مفصّلة — لـ`LedgerAmount` (اللون حسب الإشارة) والاختبار. */
export function ledgerAmountParts(value: AmountInput, opts: LedgerAmountOptions): { text: string; negative: boolean; zero: boolean } {
  const decimals = Math.max(0, Math.min(6, Math.trunc(opts.decimals)));
  const { negative, abs } = normalize(value);
  const rounded = roundDecimalString(abs, decimals);
  const zero = /^[0.]*$/.test(rounded);
  const nf = new Intl.NumberFormat(opts.locale ?? activeLocale(), {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    useGrouping: true,
  });
  // Intl.NumberFormat يقبل النص العشري بدقة كاملة (Intl.NumberFormat v3)؛ الأنواع القديمة لا تعرفه
  const body = (nf.format as (v: unknown) => string)(rounded);
  const neg = negative && !zero; // لا «0.00-»
  if (!neg) return { text: body, negative: false, zero };
  const text = (opts.negativeStyle ?? 'trailing') === 'trailing' ? `${body}${MINUS}` : `${MINUS}${body}`;
  return { text, negative: true, zero };
}

/** «3,210.34-» — بمحارف أرقام اللغة ونظام الترقيم النشط. انظر تحذير رأس الملف عن الاتجاه. */
export function formatLedgerAmount(value: AmountInput, opts: LedgerAmountOptions): string {
  return ledgerAmountParts(value, opts).text;
}

/** مللي (عدد صحيح من الخادم أو نص) ⇒ نص عشري دقيق، لمن يستقبل `*Milli` خاماً. */
export function milliToDecimalString(milli: string | number | bigint): string {
  let b: bigint;
  try { b = BigInt(typeof milli === 'number' ? Math.round(milli) : milli); } catch { return '0'; }
  const neg = b < 0n;
  const s = (neg ? -b : b).toString().padStart(4, '0');
  return `${neg ? '-' : ''}${s.slice(0, -3)}.${s.slice(-3)}`;
}

/**
 * اسم حساب أو دفتر أو ضريبة بلغة العرض (§8.7): ترجمة القالب إن وُجدت، وإلا العربية للعربية
 * و`nameEn` لغيرها. تعديل المستخدم يصفّر `nameI18n` في الخادم فيعلو ما كتبه.
 */
export function ledgerName(
  row: { name: string; nameEn?: string | null; nameI18n?: Partial<Record<string, string>> | null } | null | undefined,
  lang: string,
): string {
  if (!row) return '';
  return row.nameI18n?.[lang] ?? (lang === 'ar' ? row.name : row.nameEn ?? row.name);
}

/**
 * نص مبلغ مُدخل ⇒ مللي bigint (أو null لغير الصالح)، بتقريب نصف-لأعلى إلى `decimals` —
 * لجمع أعمدة MoveLinesGrid بلا أخطاء عائمة. يقبل الأرقام العربية الهندية والفاصلة العشرية العربية.
 */
export function parseAmountToMilli(input: string | number | null | undefined, decimals: number): bigint | null {
  if (input === null || input === undefined) return null;
  let s = String(input).trim();
  if (s === '') return 0n;
  s = s.replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660)).replace(/٫/g, '.').replace(/[٬\s  ]/g, '');
  // الفاصلة: تجميع إن وُجدت نقطة أو تلتها ثلاث خانات («1,234»)، وإلا فاصلة عشرية («3,5»)
  if (s.includes('.') || /,\d{3}(?!\d)/.test(s)) s = s.replace(/,/g, '');
  else s = s.replace(',', '.');
  const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (m[2] === '' && (m[3] ?? '') === '')) return null;
  const rounded = roundDecimalString(`${m[2] || '0'}.${m[3] ?? ''}`, Math.max(0, Math.min(3, decimals)));
  const [i, f = ''] = rounded.split('.');
  const milli = BigInt(i) * 1000n + BigInt((f + '000').slice(0, 3));
  return m[1] === '-' ? -milli : milli;
}
