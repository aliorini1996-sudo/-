/**
 * جوال العميل في تطبيق المندوب — حرٌّ تماماً (أمر المالك، ٧ نوفمبر ٢٠٢٦: «فك القيد بالكامل»
 * و«اجعل تسجيل الجوال ليس اجباري»): يُحفظ العميل بلا جوال (يُخزَّن '') وبأيّ صيغة، والقيد الوحيد
 * طولٌ أقصى للأمان. لذا لا يُفترض في أيّ مكان أنّ الجوال موجود أو صالح:
 *  - الفارغ لا يُعرض بفاصلٍ يتيم ولا يُبنى منه رابط؛
 *  - الرقم الذي لا يكفي لرابط واتساب (فارغ أو عبث) لا يُستهدف به أحد — يفتح واتساب قائمة جهاته
 *    فيختار المندوب الرقم بنفسه بدل أن تذهب رسالة الدفع لرقمٍ خاطئ.
 *
 * نقيّ بلا React — يختبره customerPhone.test.ts.
 */

/**
 * الحدّ الأقصى لطول الجوال (كما يقصّه الخادم) — لا حدّ أدنى ولا صيغة. معرَّفٌ مرّةً في lib/customerPhoneField.ts
 * (يطابقه اختبارٌ بحدّ الخادم) فلا تبقى الأوتبوكس تعيد إرسال ما صار الخادم يرفضه إن تغيّر.
 */
export { CUSTOMER_PHONE_MAX } from '../lib/customerPhoneField';

/** أقصر رقم دوليّ معقول برمز دولته (E.164 عملياً) — دونه لا يُبنى رابط wa.me موجَّه */
const WA_MIN_DIGITS = 7;

/**
 * الجوال كما يُرسَل للخادم: مقصوص الأطراف، و'' حين يُترك فارغاً (العمود NOT NULL فلا null ولا undefined
 * — في التعديل يُمحى فعلاً). لا يُقتطع هنا بصمت: الحقل يمنع الزيادة بـmaxLength، والخادم حَكَمُ الطول.
 */
export function customerPhoneValue(raw: unknown): string {
  return String(raw ?? '').trim();
}

/**
 * أرقام واتساب الدولية: wa.me لا يفهم الصيغة المحلية 05… — التطبيع لدولي كما في lib/phone.ts الخلفية،
 * والأرقام العربية/الفارسية تُقرأ أرقاماً (كانت تُحذف فيضيع الرقم كلّه).
 */
export function waDigits(raw: unknown): string {
  let d = String(raw ?? '')
    .replace(/[٠-٩]/g, (c) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(c)))
    .replace(/[۰-۹]/g, (c) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(c)))
    .replace(/[^0-9]/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 10 && d.startsWith('05')) d = '966' + d.slice(1);
  else if (d.length === 9 && d.startsWith('5')) d = '966' + d;
  return d;
}

/** هل يصلح جوال العميل هدفاً لرسالة واتساب؟ الفارغ والعبث (أقصر من رقم دوليّ) لا */
export function hasWaTarget(raw: unknown): boolean {
  return waDigits(raw).length >= WA_MIN_DIGITS;
}

/**
 * رابط مشاركة واتساب: موجَّهٌ لجوال العميل إن صلح هدفاً، وإلا بلا رقم فيسأل واتساب المندوبَ
 * عن جهة الاتصال — لا يُخمَّن رقمٌ من جوالٍ فارغ أو ناقص.
 */
export function customerWaHref(phone: unknown, encodedText: string): string {
  return hasWaTarget(phone)
    ? `https://wa.me/${waDigits(phone)}?text=${encodedText}`
    : `https://wa.me/?text=${encodedText}`;
}

/**
 * سطر بطاقة العميل «الجوال • المدينة» — الفارغ يسقط بفاصله فلا يظهر «• الرياض» ولا «0555… •».
 * وما خلا من كل حرفٍ ورقم يسقط كذلك: «—» علامة «بلا جوال» التي خزّنها الاستيراد قبل ٧ نوفمبر (باقيةٌ في القاعدة).
 */
export function customerSubline(phone: unknown, city: unknown): string {
  return [phone, city].map((v) => String(v ?? '').trim()).filter((v) => /[\p{L}\p{N}]/u.test(v)).join(' • ');
}
