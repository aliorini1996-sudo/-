/**
 * تطبيع أرقام الهاتف إلى E.164 — مصدر الحقيقة الوحيد لكل كتابة رقم في تكامل هاتف.
 *
 * لماذا هنا حارس مستقلّ: بحث جهات الاتصال عند المزوّد «مطابقة تامّة»، فأي اختلاف
 * تطبيع (05 مقابل ‎+9665) يعني «غير موجود» ثم عميلاً مكرّراً. ومطابقة المكالمة
 * الواردة بعميلنا تتم بالرقم — فالتطبيع يُطبَّق عند الكتابة دائماً لا عند القراءة.
 *
 * الافتراض المحلي: الأرقام بلا مفتاح دولي تُعامل سعودية (0XXXXXXXXX ⇒ ‎+966…) —
 * وهو سوق المنصّة الأول؛ الأرقام بمفتاح دولي صريح (+ أو 00) تمرّ بأي دولة.
 */

/** يحوّل الأرقام العربية-الهندية إلى لاتينية ويزيل كل ما ليس رقماً أو + بادئة */
function digitsOf(raw: string): string {
  const western = raw.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
  return western.replace(/[^\d+]/g, '');
}

/**
 * يعيد الرقم بصيغة E.164 (+9665XXXXXXXX) أو null إن تعذّر فهمه.
 * متجهات مضمونة بالاختبارات: 0501234567 · +966501234567 · 00966501234567 ·
 * ‏"966 50 123 4567" · ٠٥٠١٢٣٤٥٦٧ — كلها ⇒ +966501234567.
 */
export function toE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = digitsOf(String(raw).trim());
  if (!s) return null;
  if (s.startsWith('+')) s = s.slice(1);
  else if (s.startsWith('00')) s = s.slice(2);
  else if (s.startsWith('0')) s = '966' + s.slice(1); // محليّ سعودي
  else if (s.startsWith('5') && s.length === 9) s = '966' + s; // جوال سعودي بلا صفر
  // else: يبدأ بمفتاح دولة أصلاً (966… أو 20… إلخ)
  if (s.length < 8 || s.length > 15) return null; // حدود E.164
  if (!/^\d+$/.test(s)) return null;
  return '+' + s;
}

/** مطابقة رقمين بعد التطبيع — للاستخدام في ربط المكالمة بالعميل */
export function samePhone(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = toE164(a), nb = toE164(b);
  return !!na && na === nb;
}
