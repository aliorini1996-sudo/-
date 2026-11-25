// «منع تكرار العملاء عند فتح عميل جديد» (طلب المالك ٢٣ نوفمبر ٢٠٢٦) — منطقٌ صرف يُختبر وحده، مشتركٌ بين نافذة المندوب في اللوحة
// (SalesRepModal) وشاشة صلاحياته في الجوال (MSalesReps) وتطبيق المندوب (إضافة العميل وتعديله في RepApp).
//
// القيد في الخادم (services/customerDedup.ts وroutes/customers.ts) بقرار المالك: لكل مندوبٍ ثلاثة مفاتيح مستقلّة — رقم الجوال والاسم
// والعنوان، أيّها أو بعضها أو كلها — تمنعه أن يفتح عميلاً جديداً (أو يعدّل عميلاً إلى قيمةٍ جديدة) مسجّلةً لعميلٍ آخر في الشركة كلها
// (لا عملاؤه وحدهم، والمحذوف لا يُعدّ)، بعد توحيد الكتابة: المسافات والتشكيل والتطويل والهمزات (أ/إ/آ ⇒ ا) والتاء المربوطة والألف
// المقصورة وحالة الحروف اللاتينية، والجوال بصيغه (+966 و00966 و05 والأرقام الهندية رقمٌ واحد). القيمة الفارغة لا تُطابَق.
// والموقع (ضمن ٣٠ متراً) كان قاعدةً للشركة كلها، فألغاه المالك وجعله خياراً رابعاً هنا (٢٥ نوفمبر ٢٠٢٦، dedupCustomerLocation)
// بمدى تضبطه الإدارة لكل مندوب (dedupCustomerLocationM، ٣٠ افتراضاً):
// يرفضه الخادم برمزه CUSTOMER_LOCATION_EXISTS لا CUSTOMER_DUPLICATE، وتطبيق المندوب يعرض رسالته كما كان.
// معفيّان كمنع الموقع: طلب مفتاح API وإعادة رفع صندوق المندوب دون اتصال (عميلٌ سُجّل دون اتصال قد يحمل فواتيره) — فلا يُفحصان.
// والإدارة لا يمسّها القيد. والافتراض مطفأ: مندوبٌ بلا المفاتيح (أو صفّ خادمٍ أقدم بلاها) يعمل كما اليوم.

/** رمز رفض الخادم: 409 {success:false, code, field, message, existingId?, existingName?} — والاسم لمن يرى ذلك العميل وحده */
export const CUSTOMER_DUPLICATE = 'CUSTOMER_DUPLICATE';

/** الحقول التي يُمنع تكرارها — بترتيب العرض */
export type DedupField = 'phone' | 'name' | 'address' | 'location';
export const DEDUP_FIELDS: readonly DedupField[] = ['phone', 'name', 'address', 'location'];

/** حقول القيد على صفّ المندوب — اختياريةٌ: صفّ خادمٍ أقدم لا يحملها */
export interface CustomerDedupFields {
  dedupCustomerPhone?: boolean;
  dedupCustomerName?: boolean;
  dedupCustomerAddress?: boolean;
  dedupCustomerLocation?: boolean;
}

/** عمود كل حقلٍ في صفّ المندوب (prisma SalesRep) */
export const DEDUP_KEYS: Readonly<Record<DedupField, keyof CustomerDedupFields>> = {
  phone: 'dedupCustomerPhone', name: 'dedupCustomerName', address: 'dedupCustomerAddress', location: 'dedupCustomerLocation',
};

/** عنوان خانة كل حقلٍ في الإعداد (يُمرَّر بـtr) */
export const DEDUP_LABELS: Readonly<Record<DedupField, string>> = { phone: 'رقم الجوال', name: 'الاسم', address: 'العنوان', location: 'الموقع' };

/**
 * مدى قيد الموقع بالأمتار: ٣٠ افتراضاً، وتضبطه الإدارة لكل مندوب من ٥ إلى ١٠٠٠ (طلب المالك ٢٥ نوفمبر ٢٠٢٦: «٣٠ متراً أو أقل أو
 * أكثر» — SalesRep.dedupCustomerLocationM). الحدود نفسها في الخادم (services/customerLocationDup.ts)
 */
export const LOCATION_DUP_RADIUS_M = 30;
export const LOCATION_DUP_MIN_M = 5;
export const LOCATION_DUP_MAX_M = 1000;

/** مدى صالح: عددٌ صحيح بين الحدّين */
export const locationRadiusOk = (m: unknown): m is number =>
  typeof m === 'number' && Number.isInteger(m) && m >= LOCATION_DUP_MIN_M && m <= LOCATION_DUP_MAX_M;

/** مدى المندوب المحفوظ، والغائب (صفّ خادمٍ أقدم) أو غير الصالح ٣٠ */
export const locationRadiusOf = (rep: { dedupCustomerLocationM?: number | null } | null | undefined): number =>
  locationRadiusOk(rep?.dedupCustomerLocationM) ? rep!.dedupCustomerLocationM as number : LOCATION_DUP_RADIUS_M;

/**
 * المدى يُرسل مع خانة الموقع المختارة وحدها — والمطفأة لا ترسله فقيمةٌ ناقصة في حقلٍ مخفيّ لا تعطّل الحفظ (كـidleSaveFields)،
 * ويبقى المحفوظ في الخادم كما هو
 */
export function locationRadiusSaveFields<T extends { dedupCustomerLocation?: boolean; dedupCustomerLocationM?: number | null }>(data: T): T {
  if (data.dedupCustomerLocation === true) return data;
  const { dedupCustomerLocationM: _m, ...rest } = data;
  return rest as T;
}

export type DedupChecks = Record<DedupField, boolean>;

/** خانات المندوب المحفوظة: الغائب مطفأٌ (تقييديٌّ يُقرأ بـ=== true) */
export function dedupChecksOf(rep: CustomerDedupFields | null | undefined): DedupChecks {
  return {
    phone: rep?.dedupCustomerPhone === true,
    name: rep?.dedupCustomerName === true,
    address: rep?.dedupCustomerAddress === true,
    location: rep?.dedupCustomerLocation === true,
  };
}

/** أيّ خانةٍ مختارة — وهي حالة المفتاح الرئيس «منع تكرار العملاء» عند فتح الإعداد */
export const dedupAnyOn = (c: DedupChecks): boolean => DEDUP_FIELDS.some((f) => c[f]);

/**
 * قلب المفتاح الرئيس: تشغيله بلا خانةٍ مختارة يختار «رقم الجوال» (أقوى معرّفٍ للعميل وأقلّها التباساً) فلا يظهر مفتاحٌ مفعّل بلا أثر،
 * وما اختير قبلاً يبقى؛ وإطفاؤه يُفرغ الخانات الثلاث — فالخانات وحدها ما يُحفظ، ولا تُرسل خانةٌ مختارة تحت مفتاحٍ مطفأ.
 * والمفتاح مفعّلٌ بعد إفراغ خاناته كلها يدويّاً يُحفظ مطفأً (لا منع بلا حقل)، وتنبّه الشاشة إلى ذلك تحت الخانات
 */
export function dedupToggleMaster(c: DedupChecks, on: boolean): DedupChecks {
  if (!on) return { phone: false, name: false, address: false, location: false };
  return dedupAnyOn(c) ? c : { ...c, phone: true };
}

/** الأعمدة الثلاثة صريحةً دائماً (لا غائب يُقرأ «كما هو» في الخادم) — لقيم النموذج الافتراضية ولجسم الحفظ */
export function dedupColumns(c: DedupChecks): Required<CustomerDedupFields> {
  return { dedupCustomerPhone: c.phone, dedupCustomerName: c.name, dedupCustomerAddress: c.address, dedupCustomerLocation: c.location };
}

// ───────── تطبيق المندوب: ردّ الخادم 409 CUSTOMER_DUPLICATE ─────────

export interface CustomerDupError {
  /** الحقل المكرَّر كما يرسله الخادم، وnull لقيمةٍ لا يعرفها التطبيق (تُعرض رسالة الخادم كما هي) */
  field: DedupField | null;
  /** رسالة الخادم العربية */
  message: string;
  /** اسم العميل الآخر — يرسله الخادم لمن يرى ذلك العميل وحده (عزل عملاء المناديب)، فلا يُخترع هنا */
  existingName: string | null;
}

/** رفض التكرار من خطأ axios، أو null لكل خطأٍ آخر (شبكةٌ أو رمزٌ غيره) */
export function customerDupOf(err: unknown): CustomerDupError | null {
  const d = (err as { response?: { data?: unknown } } | null)?.response?.data;
  if (!d || typeof d !== 'object') return null;
  const o = d as Record<string, unknown>;
  if (o.code !== CUSTOMER_DUPLICATE) return null;
  const field = typeof o.field === 'string' && (DEDUP_FIELDS as readonly string[]).includes(o.field) ? (o.field as DedupField) : null;
  const name = typeof o.existingName === 'string' ? o.existingName.trim() : '';
  return { field, message: typeof o.message === 'string' ? o.message : '', existingName: name || null };
}

/**
 * حقل نموذج «إضافة عميل» الذي يُعرض تحته الرفض: الاسم المُرسَل فارغاً يأخذ في الخادم اسم المنشأة (customerNameFallback في
 * routes/customers.ts) فهو ما فُحص بقاعدة الاسم — فرفض 'name' حينها تحت «اسم المنشأة» الذي كتبه المندوب لا تحت حقلٍ فارغ لم يمسّه.
 * يُحسب من الاسم المُرسَل لحظة الردّ (لا الحيّ) فلا يقفز الرفض إلى «اسم العميل» حين يبدأ الكتابة فيه. والتعديل لا يأخذ بديلاً (حقله نفسه)
 */
export function customerDupFormKey(field: DedupField | null, sentName: string | null | undefined): string | null {
  return field === 'name' && !(sentName ?? '').trim() ? 'businessName' : field;
}

/**
 * نصّ الرفض بلغة المندوب: قوالب الخادم نفسها حرفاً (فالعربية مطابقةٌ لرسالته) — باسم العميل الآخر إن أرسله الخادم، وإلا «عميل آخر في
 * الشركة». وحقلٌ لا يعرفه التطبيق ⇒ رسالة الخادم كما هي
 */
export function customerDupText(dup: CustomerDupError, tr: (ar: string) => string): string {
  // دالّة الاستبدال لا نصّه: اسمٌ فيه «$&» أو «$1» يُكتب حرفاً لا نمطاً
  const named = (t: string) => t.replace('{name}', () => dup.existingName ?? '');
  switch (dup.field) {
    case 'phone':
      return dup.existingName ? named(tr('رقم الجوال مسجل للعميل «{name}»')) : tr('رقم الجوال مسجل لعميل آخر في الشركة');
    case 'name':
      return dup.existingName ? named(tr('اسم العميل مسجل للعميل «{name}»')) : tr('يوجد عميل آخر بالاسم نفسه في الشركة');
    case 'address':
      return dup.existingName ? named(tr('العنوان مسجل للعميل «{name}»')) : tr('يوجد عميل آخر بالعنوان نفسه في الشركة');
    default:
      return dup.message || tr('يوجد عميل آخر بالبيانات نفسها في الشركة');
  }
}
