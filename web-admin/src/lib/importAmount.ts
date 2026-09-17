// محلّل المبالغ الموحّد لاستيراد البيانات: أي نص غير فارغ لا يُفهم خطأ صف ظاهر بقيمته — لا صفر صامت.
// يقبل الأرقام العربية/الهندية، والفاصلين العربيين «٫» و«٬»، ورموز العملة، والسالب المحاسبي (x) وx- وCr/دائن.

export type AmountParse =
  | { ok: true; value: number | undefined }
  /** reason 'ambiguous': فاصل ملتبس («1.500») لم يحسمه سياق العمود */
  | { ok: false; raw: string; reason?: 'ambiguous' };

/** نمط الفاصل العشري لعمود كامل: '.' (1,234.56) أو ',' (1.234,56)، وundefined حين لا دليل أو تعارضت الأدلة */
export type DecimalStyle = '.' | ',' | undefined;

/** الأرقام العربية (٠-٩) والهندية/الفارسية (۰-۹) ⇒ لاتينية */
export const toAsciiDigits = (s: string): string => s
  .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660))
  .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06f0));

// حرف (لاتيني أو عربي) — حدود «الكلمة الكاملة» لرموز العملة وكلمات الإشارة (\b لا يعمل مع العربية)
const L = 'A-Za-z\\u0600-\\u06FF';
const word = (alts: string[]) => new RegExp(`(?<![${L}])(?:${alts.join('|')})(?![${L}])`, 'giu');
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// العبارات الكاملة قبل كلماتها المفردة («ريال سعودي» قبل «ريال») — تُرتَّب الأطول أولاً
const CURRENCIES = [
  'ريال سعودي', 'ريال يمني', 'ريال قطري', 'ريال عماني', 'جنيه مصري', 'درهم إماراتي', 'درهم اماراتي', 'دينار كويتي', 'دينار بحريني',
  'ر.س', 'رس', 'ريال', 'ر.ي', '﷼', 'SAR', 'SR', 'AED', 'د.إ', 'درهم', 'KWD', 'د.ك', 'دينار', 'QAR', 'ر.ق',
  'BHD', 'د.ب', 'OMR', 'ر.ع', 'YER', 'EGP', 'ج.م', 'جنيه', 'USD', 'EUR', 'GBP', 'TRY', 'MAD', 'DZD', 'TND', 'JOD', '€', '£',
  // اختصارات لاتينية شائعة غير ثلاثية كان المحلل القديم يقبلها: دينار كويتي/بحريني/أردني، ريال عماني/قطري، درهم، جنيه مصري
  'KD', 'BD', 'RO', 'QR', 'Dh', 'Dhs', 'JD', 'LE', 'L.E', 'دينار أردني', 'د.أ',
].sort((a, b) => b.length - a.length);
// الاختصارات المنقوطة واللاتينية قد تُختم بنقطة («ر.س.» و«SR.» و«Dhs.»)، والمسافة داخل العبارة مرنة
const CURRENCY_RE = word(CURRENCIES.map((c) => (c.includes('.') || /^[A-Za-z]+$/.test(c) ? `${esc(c)}\\.?` : esc(c).replace(/ /g, '\\s+'))));
// عملات المنازل الثلاث (دينار كويتي/بحريني/أردني وريال عماني): رمزها في الخلية يحسم «12.500» عشرياً لا ألفاً
const DEC3_RE = word(['KWD', 'BHD', 'OMR', 'JOD', 'KD', 'BD', 'RO', 'JD', 'د\\.ك', 'د\\.ب', 'ر\\.ع', 'د\\.أ', 'دينار', 'ريال\\s+عماني']);
// «1500 Cr.» و«Dr.»: نقطة اختيارية بعد الاختصار
const CREDIT_RE = word(['cr\\.?', 'دائن']);
const DEBIT_RE = word(['dr\\.?', 'مدين']);
// رمز عملة ISO ثلاثي بأحرف كبيرة غير مدرج (مثل CHF) كلمةً مستقلة — بعد كلمات الإشارة
const ISO_RE = /(?<![A-Za-z\d])[A-Z]{3}(?![A-Za-z\d])/g;
// «٬» فاصل آلاف عربي: يُستبدل بعلامة خاصة تُتحقق مجموعاتها لاحقاً (لا حذف صامت: «15٬00» خطأ)
const AR_THOU = '';

const fail = (raw: string, reason?: 'ambiguous'): AmountParse => (reason ? { ok: false, raw, reason } : { ok: false, raw });

/** النص الرقمي المجرد (بلا عملة ولا إشارة) مع عدد علامات السالب، أو null حين لا يصلح */
interface Core {
  s: string; neg: number;
  /** الفاصل العشري العربي «٫» صريح: القيمة محسومة (s بنقطة عشرية) ولا تُقرأ بنمط العمود */
  explicit: boolean;
  /** رمز عملة بثلاث منازل في الخلية */
  dec3: boolean;
}
function coreOf(raw: string): Core | 'empty' | null {
  let s = toAsciiDigits(raw.trim())
    .replace(/٬/g, AR_THOU).replace(/−/g, '-')
    .replace(/[\s  -​  　﻿‎‏؜]+/gu, ' ')
    .trim();
  if (!s || /^[-—–]$/.test(s)) return 'empty';
  // بادئة Excel النصية («'1500») أو صيغة («= 1500»، «="1500"»)
  s = s.replace(/^[='‘’]+\s*/, '').replace(/^"(.*)"$/, '$1').trim();
  if (!s) return 'empty';

  const dec3 = s.search(DEC3_RE) >= 0;
  s = s.replace(CURRENCY_RE, ' ').replace(/\$/g, ' ');
  let neg = 0;
  s = s.replace(CREDIT_RE, () => { neg++; return ' '; });
  let dr = 0;
  s = s.replace(DEBIT_RE, () => { dr++; return ' '; });
  if (dr && neg) return null; // «مدين» و«دائن» معاً
  s = s.replace(ISO_RE, ' ');
  // المسافة بين الأرقام فاصل آلاف بمجموعات ثلاثية فقط («1 500 000»)؛ «VAT 2023 15» لا تصير 202315
  const spaced = s.trim().replace(/^[(+\-\s]+|[)\-\s]+$/g, '');
  if (/\d\s+\d/.test(spaced) && !/^\d{1,3}(\s\d{3})+([.,]\d+)?$/.test(spaced)) return null;
  s = s.replace(/\s+/g, '');
  if (!s) return null;

  const paren = s.match(/^\((.*)\)$/);
  if (paren) { neg++; s = paren[1]; }
  if (s.startsWith('-')) { neg++; s = s.slice(1); } else if (s.startsWith('+')) s = s.slice(1);
  if (s.endsWith('-')) { neg++; s = s.slice(0, -1); }
  if (neg > 1) return null;
  // نقطة ختامية بلا كسور («1500.») كما يصدّرها بعض الأنظمة
  s = s.replace(/(\d)\.$/, '$1');
  // «٫» عشري عربي صريح لا يلتبس: الجزء الصحيح بلا فاصل أو بفواصل آلاف صحيحة، والكسر أرقام
  const arDec = (s.match(/٫/g) || []).length;
  let frac: string | null = null;
  if (arDec > 1) return null;
  if (arDec === 1) {
    const i = s.indexOf('٫');
    frac = s.slice(i + 1);
    s = s.slice(0, i);
    if (!/^\d+$/.test(frac) || !s) return null;
  }
  if (s.includes(AR_THOU)) {
    // «٬» آلاف فقط بمجموعات ثلاثية صحيحة، ولا يجتمع مع «,»
    if (!/^\d{1,3}(\d{3})+(\.\d+)?$/.test(s)) return null;
    s = s.split(AR_THOU).join('');
  }
  if (frac !== null) {
    let int: string | null = null;
    if (/^\d+$/.test(s)) int = s;
    else if (!s.includes('.') && (groupsOk(s, ',') || indianOk(s))) int = s.split(',').join('');
    else if (!s.includes(',') && groupsOk(s, '.')) int = s.split('.').join('');
    if (int === null) return null;
    return { s: `${int}.${frac}`, neg, explicit: true, dec3 };
  }
  return { s, neg, explicit: false, dec3 };
}

function groupsOk(intPart: string, sep: string): boolean {
  const g = intPart.split(sep);
  return /^\d{1,3}$/.test(g[0]) && g.slice(1).every((x) => /^\d{3}$/.test(x));
}
/** التجميع الهندي «1,50,000» و«12,34,567» (آخر مجموعة ثلاثية وما قبلها ثنائية) */
function indianOk(intPart: string): boolean {
  return /^\d{1,2}(,\d{2})+,\d{3}$/.test(intPart);
}
/** نقطة مفردة بعدها ثلاثة أرقام وقبلها 1-3 أرقام بلا صفر أول: «1.500» ألف وخمسمئة أم واحد ونصف؟ */
const AMBIGUOUS_DOT = /^[1-9]\d{0,2}\.\d{3}$/;

/** دليل الخلية على نمط الفاصل العشري، أو undefined حين لا تحسم وحدها */
function styleOf(c: Core): DecimalStyle {
  const { s } = c;
  if (c.explicit) return undefined; // «٫» لا يقول شيئاً عن «.» و«,» في بقية العمود
  const commas = (s.match(/,/g) || []).length;
  const dots = (s.match(/\./g) || []).length;
  if (commas && dots) return s.lastIndexOf(',') > s.lastIndexOf('.') ? ',' : '.';
  if (dots > 1) return groupsOk(s, '.') ? ',' : undefined;       // 1.500.000
  if (commas > 1) return groupsOk(s, ',') || indianOk(s) ? '.' : undefined; // 1,500,000 و1,50,000
  if (commas === 1) {
    const [a, b] = s.split(',');
    if (/^\d{1,2}$/.test(b) && /^\d+$/.test(a)) return ',';      // 12,5
    return undefined;
  }
  if (dots === 1) {
    const [a, b] = s.split('.');
    if (/^\d*$/.test(a) && /^\d+$/.test(b) && !AMBIGUOUS_DOT.test(s)) return '.'; // 12.5 و0.500 و1234.500
    if (c.dec3 && AMBIGUOUS_DOT.test(s)) return '.';              // «12.500 KWD»: منازل الدينار الثلاث
  }
  return undefined;
}

/**
 * نمط الفاصل العشري لعمود من أدلة خلاياه النصية الصريحة: «1.500.000» أو «2.750,00» أو «12,5» ⇒ ','،
 * و«1,500,000» أو «1,234.56» أو «12.5» أو «12.500 KWD» ⇒ '.'. التعارض ⇒ undefined.
 * غياب الدليل ⇒ fallback (نمط عملة الشركة: '.' لعملات المنازل الثلاث حيث «12.500» اثنا عشر ونصف)، وإلا undefined.
 */
export function columnDecimalStyle(raws: readonly unknown[], fallback?: DecimalStyle): DecimalStyle {
  let dot = false; let comma = false;
  for (const r of raws) {
    if (typeof r !== 'string') continue;
    const c = coreOf(r);
    if (!c || c === 'empty') continue;
    const st = styleOf(c);
    if (st === '.') dot = true; else if (st === ',') comma = true;
    if (dot && comma) return undefined;
  }
  return dot ? '.' : comma ? ',' : fallback;
}

/** نمط الفاصل الافتراضي لعملة الشركة: منازلها الثلاث ⇒ '.'، وإلا بلا افتراض */
export const currencyDecimalFallback = (decimals: number | null | undefined): DecimalStyle => (decimals === 3 ? '.' : undefined);

/** الفواصل ⇒ رقم عشري بنقطة، أو null حين الصيغة غير صحيحة، أو 'ambiguous' حين لم يحسمها السياق */
function resolveSeparators(s: string, style: DecimalStyle): string | null | 'ambiguous' {
  const commas = (s.match(/,/g) || []).length;
  const dots = (s.match(/\./g) || []).length;
  if (commas && dots) {
    const lastComma = s.lastIndexOf(','); const lastDot = s.lastIndexOf('.');
    const [dec, thou] = lastComma > lastDot ? [',', '.'] : ['.', ','];
    if ((dec === ',' ? commas : dots) !== 1) return null;
    const i = s.lastIndexOf(dec);
    const intPart = s.slice(0, i); const frac = s.slice(i + 1);
    if (!/^\d+$/.test(frac) || !(groupsOk(intPart, thou) || (thou === ',' && indianOk(intPart)))) return null;
    return `${intPart.split(thou).join('')}.${frac}`;
  }
  if (commas > 1) return groupsOk(s, ',') || indianOk(s) ? s.split(',').join('') : null;
  if (dots > 1) return groupsOk(s, '.') ? s.split('.').join('') : null; // 1.234.567
  if (commas === 1) {
    const [a, b] = s.split(',');
    if (style === ',') return /^\d+$/.test(a) && /^\d+$/.test(b) ? `${a}.${b}` : null; // عمود أوروبي: الفاصلة عشرية
    if (/^\d{3}$/.test(b) && /^[1-9]\d{0,2}$/.test(a)) return a + b;   // 1,234 = 1234
    if (/^\d{1,2}$/.test(b)) return `${a}.${b}`;                      // 12,5 = 12.5
    return null;
  }
  if (dots === 1 && AMBIGUOUS_DOT.test(s)) {
    if (style === ',') return s.replace('.', '');  // عمود أوروبي: 1.500 = 1500
    if (style === '.') return s;                   // عمود بنقطة عشرية صريحة: 1.500 = 1.5
    return 'ambiguous';
  }
  if (dots === 1 && style === ',') return null; // «12.5» في عمود فاصلته عشرية: تعارض
  return s;
}

/**
 * مبلغ من خلية الملف:
 * - رقم حقيقي منتهٍ ⇒ كما هو. null/''/شرطة وحدها ⇒ undefined.
 * - نص ⇒ أرقام لاتينية، «٫» عشري صريح (لا يلتبس ولا يتأثر بنمط العمود) و«٬» آلاف (بمجموعات ثلاثية)، حذف المسافات،
 *   بادئة Excel «'» أو «=»، إزالة رموز العملة كلمةً كاملة، (x) وx- و-x وCr/دائن ⇒ سالب، Dr/مدين ⇒ موجب، علامتا سالب معاً ⇒ خطأ،
 *   الصيغة العلمية (1.5E+3)، والتجميع الهندي (1,50,000)، والنقطة الختامية (1500.)، ثم الفواصل بقواعد صريحة.
 * - «1.500» ملتبسة: تُحسم برمز عملة بثلاث منازل في الخلية، ثم بنمط العمود (style)، وإلا خطأ صف reason:'ambiguous'.
 * - غير ذلك ⇒ {ok:false, raw}.
 */
export function parseAmount(raw: unknown, style?: DecimalStyle): AmountParse {
  if (raw == null) return { ok: true, value: undefined };
  if (typeof raw === 'number') return Number.isFinite(raw) ? { ok: true, value: raw } : fail(String(raw));
  if (typeof raw !== 'string') return fail(String(raw));
  const original = raw.trim();
  const core = coreOf(original);
  if (core === 'empty') return { ok: true, value: undefined };
  if (!core) return fail(original);
  const { s, neg } = core;

  let n: string;
  if (core.explicit) n = s;
  else if (/^\d+(\.\d+)?[eE][+-]?\d+$/.test(s)) n = s; // تصدير CSV من Excel: 1.5E+3
  else {
    const cellStyle = core.dec3 && AMBIGUOUS_DOT.test(s) ? '.' : style;
    const num = resolveSeparators(s, cellStyle);
    if (num === 'ambiguous') return fail(original, 'ambiguous');
    if (num == null) return fail(original);
    n = num.startsWith('.') ? `0${num}` : num;
    if (!/^\d+(\.\d+)?$/.test(n)) return fail(original);
  }
  const value = Number(n);
  if (!Number.isFinite(value)) return fail(original);
  return { ok: true, value: neg && value !== 0 ? -value : value };
}

// أسماء الضريبة المعفاة والصفرية بلا رقم («Exempt»، «معفى»، «Zero Rated») ⇒ 0، بعد حذف كلمات الحشو (VAT/ضريبة…)
const normTax = (s: string): string => s.toLowerCase()
  .replace(/[ً-ْـ]/g, '').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
  .replace(/[\s_\-.,:;()[\]/%٪]+/g, ' ').trim();
const TAX_FILLER = new Set(['vat', 'tax', 'taxes', 'rate', 'category', 'ضريبه', 'الضريبه', 'ضريبة', 'القيمه', 'المضافه', 'نسبه', 'فئه']);
const TAX_ZERO = new Set([
  'exempt', 'exempted', 'tax exempt', 'zero', 'zero rated', 'zerorated', 'zero rate', 'nil', 'nil rated', 'none', 'no', 'no tax',
  'non taxable', 'nontaxable', 'not taxable', 'out of scope', 'outside scope', 'e', 'z', 'o',
  'معفي', 'معفيه', 'معفاه', 'معفا', 'اعفاء', 'صفر', 'صفري', 'صفريه', 'خاضع للصفر', 'خاضعه للصفر', 'خاضع لنسبه صفر', 'خاضعه لنسبه صفر',
  'بدون', 'بلا', 'لا يوجد', 'غير خاضع', 'غير خاضعه', 'خارج النطاق',
].map(normTax));
const taxZeroName = (t: string): boolean => {
  const words = normTax(t).split(' ').filter((w) => w && !TAX_FILLER.has(w));
  return words.length > 0 && TAX_ZERO.has(words.join(' '));
};

/**
 * نسبة: مثل parseAmount مع قبول «%» أو «٪» لاحقةً (أو بادئةً) — «15%» ⇒ 15.
 * اسم ضريبة يحمل رقماً واحداً ملاصقاً لعلامة النسبة («VAT 15%»، «15% S»، «ضريبة 15٪»، «VAT 5% 2018») ⇒ ذلك الرقم؛
 * اسم معفاة أو صفرية بلا رقم («Exempt»، «معفى»، «Zero Rated») ⇒ 0؛
 * بلا رقم أو بأكثر من رقم بعلامة نسبة («5% + 15%») أو بلا علامة نسبة («VAT15») ⇒ خطأ.
 */
export function parsePercent(raw: unknown, style?: DecimalStyle): AmountParse {
  if (typeof raw !== 'string') return parseAmount(raw, style);
  const t = raw.trim();
  const stripped = t.replace(/^[%٪]\s*|\s*[%٪]$/u, '');
  const r = parseAmount(stripped, style);
  if (r.ok) return r;
  const ascii = toAsciiDigits(t).replace(/٫/g, '.');
  const pcts = [...ascii.matchAll(/(\d+(?:[.,]\d+)?)\s*[%٪]/gu)];
  if (pcts.length === 1) {
    const v = parseAmount(pcts[0][1].replace(',', '.'));
    if (v.ok && v.value !== undefined) return v;
  }
  if (!/\d/.test(ascii) && taxZeroName(t)) return { ok: true, value: 0 };
  return fail(t);
}

/** هل النص يحمل علامة نسبة صريحة (فلا يُضرب في 100) */
export const hasPercentSign = (raw: unknown): boolean => typeof raw === 'string' && /[%٪]/.test(raw);
