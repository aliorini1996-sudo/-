/**
 * «احجز اجتماع» (طلب المالك ٨ نوفمبر ٢٠٢٦) — منطق صرف لصفحة الحجز: الجوال الدولي من أي دولة في العالم.
 *
 * الرقم يُكتب كما يعرفه صاحبه (بصفرٍ في أوله أو بلا صفر، بأرقام عربية أو لاتينية، بمسافات أو شرطات)، ويُرسل بصيغة
 * دولية كاملة: +<مفتاح الدولة><الرقم بلا صفر البداية> — E.164 لا يتجاوز ١٥ رقماً. والخادم يتحقق بالنمط نفسه.
 */
import { ALL_DIAL, ARAB_DIAL, WORLD_DIAL, type DialCountry } from '../i18n/dialCodes';

/** أرقام عربية-هندية وفارسية ⇐ لاتينية، وحذف كل ما ليس رقماً */
export function phoneDigits(raw: string): string {
  return String(raw ?? '')
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/\D/g, '');
}

/** الجوال الدولي الكامل أو null إن لم يصح: الرقم المحلي ٤–١٤ رقماً بعد حذف أصفار البداية، والمجموع ≤ ١٥ */
export function internationalPhone(dial: string, raw: string): string | null {
  const cc = phoneDigits(dial);
  if (!/^[1-9]\d{0,3}$/.test(cc)) return null;
  let national = phoneDigits(raw).replace(/^0+/, '');
  // من كتب المفتاح نفسه في أول الرقم (966512… مع +966) لا يُكرَّر
  if (national.startsWith(cc) && national.length - cc.length >= 6) national = national.slice(cc.length);
  if (national.length < 4 || national.length > 14) return null;
  if (cc.length + national.length > 15 || cc.length + national.length < 7) return null;
  return `+${cc}${national}`;
}

/** اسم الدولة بلغة الواجهة (العربية بالعربي، وغيرها بالإنجليزي — القائمة تحمل اللغتين) */
export function countryLabel(c: DialCountry, lang: string): string {
  return lang === 'ar' ? c.ar : c.en;
}

/** قائمة الاختيار: العربية أولاً ثم كل دول العالم مرتبةً بلغة الواجهة، مفلترةً بالبحث (الاسم بلغتيه أو المفتاح أو الرمز) */
export function filterDialCountries(query: string, lang: string): DialCountry[] {
  const q = phoneDigitsOrText(query);
  const world = [...WORLD_DIAL].sort((a, b) => countryLabel(a, lang).localeCompare(countryLabel(b, lang), lang === 'ar' ? 'ar' : 'en'));
  const all = [...ARAB_DIAL, ...world];
  if (!q) return all;
  return all.filter((c) => {
    if (q.digits && phoneDigits(c.dial).startsWith(q.digits)) return true;
    const t = q.text;
    return !!t && (c.ar.includes(t) || c.en.toLowerCase().includes(t) || c.code.toLowerCase() === t);
  });
}

function phoneDigitsOrText(query: string): { digits: string; text: string } | null {
  const s = String(query ?? '').trim();
  if (!s) return null;
  const digits = /^[+\d٠-٩۰-۹\s]+$/.test(s) ? phoneDigits(s) : '';
  return { digits, text: digits ? '' : s.toLowerCase() };
}

/** الدولة برمزها (SA الافتراضية) */
export function dialCountryOf(code: string | null | undefined): DialCountry {
  return ALL_DIAL.find((c) => c.code === code) ?? ARAB_DIAL[0];
}
