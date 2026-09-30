import { cleanText } from './textClean';

/**
 * زرّ «تنظيف النصوص» في محرّر محتوى الموقع — قرار المالك (٣٠ سبتمبر ٢٠٢٦): يبقى، مقصوراً على النص العادي.
 * كان يطبّق cleanDeep على المسودة كلها فيُتلف صورة الرئيسية وروابط Markdown والكلمات المفتاحية.
 */

// مفاتيح تدلّ أسماؤها على رابط أو صورة أو بريد أو كلمات مفتاحية أو تنسيق — تُترك كما هي
const SKIP_KEY = /url|href|src|image|img|logo|icon|video|link|keywords|kw|email|slug|path|color|css|style|phone|whatsapp/i;
// قيمة هي بأكملها رابط أو مسار أو نطاق
const LOOKS_LIKE_LINK = /^(?:https?:|mailto:|tel:|data:|\/)|www\.|^[\w-]+(?:\.[\w-]+)+(?:\/\S*)?$/i;
// داخل النص الطويل: روابط Markdown وصوره ووسوم HTML والروابط والنطاقات تُحمى ويُنظَّف ما بينها
const KEEP_IN_TEXT = /(!?\[[^\]\n]*\]\([^)\s]*\)|<\/?[a-zA-Z!][^>]*>|(?:https?:\/\/|www\.)[^\s<>"')\]،؛؟!«»…]*[^\s<>"')\]،؛؟!«»….,]|\b[\w-]+(?:\.[\w-]+)*\.[a-zA-Z]{2,}(?:\/[\w\-./?=&%#~]*[\w\-/=&%#~])?)/g;

/**
 * المحميّ يُجمَّد نائباً {…} (يصونه cleanText) ويُنظَّف النص كله مرة واحدة. تقطيعه عند الرابط كان يقصّ مسافة
 * ما بعده فتلتصق الكلمة به («fieldsa.net، ثم» ⇒ «fieldsa.netثم»).
 */
export function cleanPlain(s: string): string {
  const keep: string[] = [];
  const frozen = s.replace(KEEP_IN_TEXT, (m) => `{\u0003${keep.push(m) - 1}}`);
  return cleanText(frozen).replace(/\{\u0003(\d+)\}/g, (_m, i: string) => keep[Number(i)]);
}

export function cleanContent<T>(node: T): { value: T; changed: number } {
  let changed = 0;
  const walk = (n: unknown, key = ''): unknown => {
    if (SKIP_KEY.test(key)) return n;
    if (typeof n === 'string') {
      if (LOOKS_LIKE_LINK.test(n.trim())) return n;
      const out = cleanPlain(n);
      if (out !== n) changed++;
      return out;
    }
    if (Array.isArray(n)) return n.map((v) => walk(v, key));
    if (n && typeof n === 'object') {
      const o: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(n as Record<string, unknown>)) o[k] = walk(v, k);
      return o;
    }
    return n;
  };
  return { value: walk(node) as T, changed };
}
