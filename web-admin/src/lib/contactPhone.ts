/**
 * رقم تواصل ترشيحٍ كما يخزّنه الخادم — أرقامٌ مطبَّعة بلا «+» (backend/src/services/affiliate/rules.ts
 * normContactPhone): جوال سعودي `9665XXXXXXXX`، ودولي بلا + أو 00 (`971501234567`)، وثابت
 * يبدأ بصفر (`0112345678`)، وموحّد قصير (`920012345`).
 *
 * نقيّ بلا React — تستعمله بوابة السفير («ترشيحاتي») ولوحة المالك (رابط `tel:`).
 */

function digitsOf(raw: string | null | undefined): { plus: boolean; digits: string } {
  const s = String(raw ?? '')
    .normalize('NFKC')
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .trim();
  return { plus: s.startsWith('+'), digits: s.replace(/\D/g, '') };
}

/**
 * هل الرقم دوليٌّ يحتاج «+»؟ جاء بـ«+» أصلاً، أو أرقامٌ لا تبدأ بصفر وطولها 11 فأكثر
 * (رمز دولة + رقم وطني). ما يبدأ بصفر أو يقصر (ثابتٌ محلّي، 9200) يُترك كما هو.
 */
function isInternational(p: { plus: boolean; digits: string }): boolean {
  return p.plus || (!p.digits.startsWith('0') && p.digits.length >= 11);
}

/** رابط `tel:` صالحٌ للاتصال من الجوال — أو null إن لم يبقَ رقمٌ معقول */
export function contactPhoneTel(raw: string | null | undefined): string | null {
  const p = digitsOf(raw);
  if (p.digits.length < 3) return null;
  return `tel:${isInternational(p) ? '+' : ''}${p.digits}`;
}

/** عرضٌ مقروء: `+966 55 123 4567` للجوال السعودي، و`+971501234567` للدولي، وغيرهما كما هو */
export function contactPhoneDisplay(raw: string | null | undefined): string {
  const p = digitsOf(raw);
  if (!p.digits) return String(raw ?? '').trim();
  const sa = /^9665(\d)(\d{3})(\d{4})$/.exec(p.digits);
  if (sa) return `+966 5${sa[1]} ${sa[2]} ${sa[3]}`;
  if (isInternational(p)) return `+${p.digits}`;
  return p.digits;
}
