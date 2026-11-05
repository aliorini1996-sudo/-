/**
 * تمييز العدد بالعربية (مراجعة المخزون S14) — نقيٌّ بلا React، يُختبر وحده (arCount.test.ts).
 *
 * «6 صنفا» و«2 سيارة» و«1 سيارة» تُقرأ خطأً في أبرز أسطر الصفحة. فالعربية وحدها بقاعدتها: ١ «صنف واحد»، ٢ «صنفان»،
 * ٣–١٠ «أصناف»، ١١–٩٩ «صنفاً»، والمئة وما بعدها بآخر جزأيها (١٠٠ «صنف»، ١٠٣ «أصناف»، ١١١ «صنفاً»). واللغات الأخرى
 * «N» وترجمة المعدود كما كانت حرفاً.
 */

/** المعدودات المعروفة — مفتاحها كلمتها في القاموس (tr) */
export type CountNoun = 'صنف' | 'سيارة' | 'فاتورة';

const FORMS: Record<CountNoun, { one: string; two: string; few: string; many: string; hundred: string }> = {
  'صنف': { one: 'صنف واحد', two: 'صنفان', few: 'أصناف', many: 'صنفاً', hundred: 'صنف' },
  'سيارة': { one: 'سيارة واحدة', two: 'سيارتان', few: 'سيارات', many: 'سيارة', hundred: 'سيارة' },
  'فاتورة': { one: 'فاتورة واحدة', two: 'فاتورتان', few: 'فواتير', many: 'فاتورة', hundred: 'فاتورة' },
};

const plain = (n: number) => String(n);

/** العدد ومعدوده بالعربية: «صنف واحد» · «صنفان» · «6 أصناف» · «11 صنفاً» · «100 صنف» */
export function arCountText(n: number, noun: CountNoun, fmt: (n: number) => string = plain): string {
  const f = FORMS[noun];
  const k = Math.abs(Math.trunc(Number(n) || 0));
  if (k === 1) return f.one;
  if (k === 2) return f.two;
  const r = k % 100;
  if (k === 0) return `${fmt(0)} ${f.hundred}`;
  if (r >= 3 && r <= 10) return `${fmt(n)} ${f.few}`;
  if (r >= 11) return `${fmt(n)} ${f.many}`;
  return `${fmt(n)} ${f.hundred}`; // ١٠٠ و٢٠٠ و١٠١ و١٠٢…
}

/** العدد ومعدوده بلغة العرض: العربية بتمييزها، وغيرها «N» وترجمة المعدود كما كان */
export function countText(lang: string, n: number, noun: CountNoun, tr: (ar: string) => string, fmt: (n: number) => string = plain): string {
  return lang === 'ar' ? arCountText(n, noun, fmt) : `${fmt(n)} ${tr(noun)}`;
}

/**
 * عبارةٌ أولها المعدود («صنفا برصيد صفر…»): العربية «6 أصناف برصيد صفر…» (العدد بتمييزه ثم بقية العبارة بعد كلمتها الأولى)،
 * وغيرها «N» وترجمة العبارة كاملةً كما كانت حرفاً. فالمفتاح واحدٌ في القاموس ولا نصّ عربيّ موازٍ له.
 */
export function countLead(lang: string, n: number, noun: CountNoun, key: string, tr: (ar: string) => string, fmt: (n: number) => string = plain): string {
  if (lang !== 'ar') return `${fmt(n)} ${tr(key)}`;
  const rest = key.trim().split(/\s+/).slice(1).join(' ');
  return rest ? `${arCountText(n, noun, fmt)} ${rest}` : arCountText(n, noun, fmt);
}
