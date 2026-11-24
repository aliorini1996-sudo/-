// «رقم العميل» (طلب المالك ٢٣ نوفمبر ٢٠٢٦): رقمٌ تسلسليّ لكل عميل داخل شركته يمنحه الخادم وحده، ويُبحث به في كل مكان
// بدل الكود الآلي (cuid). هذا الملف مصدر العرض والمطابقة في الواجهة كلها (سطح المكتب و/m وتطبيق المندوب):
//   • customerNumberQuery — قاعدة نصّ البحث نفسها في الخادم (backend/src/services/customerNumber.ts) حرفاً بحرف.
//   • المطابقة دقيقة دائماً (matchesCustomerNumber): لا يُدخل الرقم ولا «#N» في أي نصٍّ يُطابَق بالاحتواء — وإلا لطابق
//     البحث «1» كل عميلٍ رقمه فيه ١ (12، 21، 100…).
//   • العرض بأرقام لاتينية '#12 · الاسم' (String(n) لا formatNumber: الرقم مُعرِّف لا كمّية، فلا فواصل آلاف).

/** أكبر رقم يحتمله عمود Int في الخادم (int4) */
export const CUSTOMER_NUMBER_MAX = 2147483647;

/** الأرقام العربية-الهندية (٠-٩) والفارسية (۰-۹) إلى اللاتينية */
const LOCAL_DIGITS: Record<string, string> = {};
for (let i = 0; i < 10; i++) {
  LOCAL_DIGITS[String.fromCharCode(0x0660 + i)] = String(i);
  LOCAL_DIGITS[String.fromCharCode(0x06f0 + i)] = String(i);
}

/**
 * نصّ البحث ⇒ رقم عميل أو null: يُقصّ، ثم تُنزع # (أو ＃) في أوّله والمسافات بعدها، وتُوحَّد الأرقام؛ ثم يجب أن يكون أرقاماً
 * بلا صفرٍ بادئ (فبادئة الجوال «05» ليست رقم عميل) ولا يتجاوز CUSTOMER_NUMBER_MAX. غير النصّ ⇒ null.
 * إلا بعد #: «#007» و«#٠١٢» حشوٌ صريحٌ لرقم عميل لا جوال، فتُنزع أصفاره البادئة (7 و12)؛ و«#0» و«#000» صفرٌ لا رقم ⇒ null.
 */
export function customerNumberQuery(q: unknown): number | null {
  if (typeof q !== 'string') return null;
  const t = q.trim();
  let s = t.replace(/^[#＃]\s*/, '').replace(/[٠-٩۰-۹]/g, (d) => LOCAL_DIGITS[d] ?? d);
  if (/^[#＃]/.test(t) && /^\d+$/.test(s)) s = s.replace(/^0+(?=\d)/, '');
  if (!/^[1-9]\d{0,9}$/.test(s)) return null;
  const n = Number(s);
  return n <= CUSTOMER_NUMBER_MAX ? n : null;
}

/** هل نصّ البحث هو رقم هذا العميل بالضبط؟ — يُضاف بـ«أو» إلى مطابقة الاسم/الجوال القائمة، لا بدلاً منها */
export function matchesCustomerNumber(q: string, n: number | null | undefined): boolean {
  return n != null && customerNumberQuery(q) === n;
}

const isNum = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0;

/** '#12' أو '' حين لا رقم بعد */
export function formatCustomerNumber(n: number | null | undefined): string {
  return isNum(n) ? `#${String(n)}` : '';
}

/** خانة الجدول: '#12' أو '—' حتى يُرقَّم العميل */
export function customerNumberCell(n: number | null | undefined): string {
  return isNum(n) ? `#${String(n)}` : '—';
}

/** تسمية المنتقيات ونتائج البحث: '#12 · الاسم' أو الاسم وحده */
export function formatCustomerLabel(c: { name: string; number?: number | null }): string {
  return isNum(c.number) ? `#${String(c.number)} · ${c.name}` : c.name;
}

/** الكود الآلي (cuid الافتراضي في الخادم) أو الفارغ — لا يُعرض في القوائم؛ الكود المخصّص يبقى معروضاً ومبحوثاً */
export function isAutoCustomerCode(code: string | null | undefined): boolean {
  const c = (code ?? '').trim();
  return c === '' || /^c[a-z0-9]{20,32}$/.test(c);
}

/** الكود الصالح للعرض: '' للآلي، والمخصّص كما هو */
export function visibleCustomerCode(code: string | null | undefined): string {
  return isAutoCustomerCode(code) ? '' : (code ?? '').trim();
}
