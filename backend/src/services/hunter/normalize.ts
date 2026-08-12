/**
 * تطبيع مفاتيح إزالة التكرار لمنصّة الصيد.
 *
 * الوحدة القديمة (leads) كانت تُزيل التكرار بـ`sourceId` وحده، فالشركة الواحدة
 * تُخزَّن مرّتين إن وجدها مصدران مختلفان. هنا نشتقّ ثلاثة مفاتيح مطبَّعة
 * (نطاق/هاتف/اسم+مدينة) ونُفهرسها، فيصير الفحص استعلاماً واحداً لكل حساب.
 */

// لواحق شركات شائعة تُحذف قبل المقارنة («شركة الرواد» = «الرواد للتجارة»)
const COMPANY_SUFFIXES = new Set([
  'llc', 'ltd', 'inc', 'co', 'company', 'corp', 'trading', 'est', 'group',
  'شركة', 'مؤسسة', 'مؤسسه', 'للتجارة', 'التجارية', 'المحدودة', 'المحدوده', 'ذمم',
]);

/** اسم مطبّع: بلا تشكيل ولا رموز ولا لواحق شركات. */
export function normalizeName(name?: string | null): string {
  if (!name) return '';
  let s = String(name).toLowerCase().trim();
  s = s.replace(/[ؐ-ًؚ-ٰٟ]/g, ''); // التشكيل العربي
  s = s.replace(/[^\p{L}\p{N}\s]/gu, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const words = s.split(' ').filter((w) => w && !COMPANY_SUFFIXES.has(w));
  return (words.length ? words : s.split(' ')).join(' ').trim();
}

/** هاتف مطبّع: أرقام فقط مع + إن كان دولياً. أقلّ من ٧ أرقام يُهمَل. */
export function normalizePhone(phone?: string | null): string {
  if (!phone) return '';
  const s = String(phone).trim();
  const intl = s.startsWith('+') || s.startsWith('00');
  const digits = s.replace(/\D/g, '').replace(/^00/, '');
  if (digits.length < 7) return '';
  return (intl ? '+' : '') + digits;
}

/** نطاق الموقع بلا www ولا مسار. */
export function domainOf(website?: string | null): string {
  if (!website) return '';
  try {
    const u = new URL(String(website).startsWith('http') ? String(website) : `https://${website}`);
    return u.hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return String(website).replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase();
  }
}

export interface DedupKeys {
  domainKey: string | null;
  phoneKey: string | null;
  nameCityKey: string | null;
}

/** يشتقّ المفاتيح الثلاثة من عميل خام. الفارغ يصير null فلا يُطابق شيئاً. */
export function dedupKeysOf(lead: {
  name?: string | null; website?: string | null; phone?: string | null; city?: string | null;
}): DedupKeys {
  const domain = domainOf(lead.website);
  const phone = normalizePhone(lead.phone);
  const n = normalizeName(lead.name);
  const city = String(lead.city || '').toLowerCase().trim();
  return {
    domainKey: domain || null,
    phoneKey: phone || null,
    // الاسم وحده لا يكفي (فروع بنفس الاسم)، والمدينة وحدها لا تعني شيئاً
    nameCityKey: n ? `${n}|${city}` : null,
  };
}
