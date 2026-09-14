// ============================================================================
// ZATCA المرحلة الثانية (Z1) — مُدقِّقات بيانات البائع والمشتري (مصدر واحد)
// ----------------------------------------------------------------------------
// تُستعمل في: الفحص المسبق قبل استهلاك ICV (preflight.ts)، ولاحقاً نقطة الجاهزية
// ونماذج الإعدادات. ⚠️ ستُنسخ حرفياً إلى web-admin/src/rep/zatcaValidators.ts مع اختبار
// حارس للفرق (design §1.4) — لذا الملف **مكتفٍ بذاته**: بلا أي import، وأنواعه بنيوية
// متوافقة مع UblParty/UblAddress في model.ts.
//
// الرسائل بالعربية وتُسمّي الحقل كما يراه مدير الشركة في شاشة الإعدادات أو بطاقة العميل.
// ============================================================================

export interface IssueLike {
  rule: string;
  field: string;
  messageAr: string;
  severity: 'error' | 'warning';
}

export interface AddressLike {
  street?: string;
  buildingNumber?: string;
  additionalNumber?: string;
  district?: string;
  city?: string;
  postalZone?: string;
  country?: string;
}

export interface PartyLike {
  registrationName?: string;
  vatNumber?: string;
  otherId?: { scheme?: string; value?: string };
  address?: AddressLike;
}

/** رقم ضريبي سعودي: 15 رقماً لاتينياً يبدأ وينتهي بـ 3 (BR-KSA-40 / BR-KSA-44). */
export function isSaudiVat(s: unknown): boolean {
  return typeof s === 'string' && /^3[0-9]{13}3$/.test(s);
}

/** رقم المبنى في العنوان الوطني: 4 أرقام بالضبط (BR-KSA-37). */
export function isBuildingNo(s: unknown): boolean {
  return typeof s === 'string' && /^[0-9]{4}$/.test(s);
}

/** الرمز البريدي: 5 أرقام بالضبط (BR-KSA-66 / BR-KSA-67). */
export function isPostalCode(s: unknown): boolean {
  return typeof s === 'string' && /^[0-9]{5}$/.test(s);
}

/** معرّف أبجدي رقمي لاتيني بلا مسافات (BR-KSA-08 / BR-KSA-14). */
export function isAlphanumericId(s: unknown): boolean {
  return typeof s === 'string' && /^[A-Za-z0-9]+$/.test(s);
}

/** مخططات معرّف البائع الآخر (BR-KSA-08). */
export const SELLER_ID_SCHEMES = ['CRN', 'MOM', 'MLS', '700', 'SAG', 'OTH'] as const;

/** مخططات معرّف المشتري الآخر (BR-KSA-14). */
export const BUYER_ID_SCHEMES = ['TIN', 'CRN', 'MOM', 'MLS', '700', 'SAG', 'NAT', 'GCC', 'IQA', 'PAS', 'OTH'] as const;

/**
 * رموز أسباب الإعفاء وفئتها [XML §11.2.4]. الرموز الأحدث (VATEX-SA-32bis، ROYALDECREE،
 * DUTYFREE) فئتها متضاربة في المصادر فتُرفض حتى تُحسم — UNVERIFIED (xml report §12 q5).
 */
export const VATEX_CATEGORY: Readonly<Record<string, 'Z' | 'E' | 'O'>> = {
  'VATEX-SA-29': 'E', 'VATEX-SA-29-7': 'E', 'VATEX-SA-30': 'E',
  'VATEX-SA-32': 'Z', 'VATEX-SA-33': 'Z',
  'VATEX-SA-34-1': 'Z', 'VATEX-SA-34-2': 'Z', 'VATEX-SA-34-3': 'Z', 'VATEX-SA-34-4': 'Z', 'VATEX-SA-34-5': 'Z',
  'VATEX-SA-35': 'Z', 'VATEX-SA-36': 'Z', 'VATEX-SA-EDU': 'Z', 'VATEX-SA-HEA': 'Z', 'VATEX-SA-MLTRY': 'Z',
  'VATEX-SA-OOS': 'O',
};

/** طول النص بالبايت في UTF-8 (بلا TextEncoder كي يعمل في المتصفح والخادم بلا أنواع DOM). */
export function utf8ByteLength(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { n += 4; i++; }
    else n += 3; // يشمل البديل المنفرد (يُرمَّز U+FFFD بثلاث بايتات)
  }
  return n;
}

/** حدّ طول قيمة TLV في QR (بايت واحد للطول). */
export const QR_TLV_MAX_BYTES = 255;
/** فوق هذا الحدّ يُحذَّر حتى يُحسم ترميز الأطوال 128–255. UNVERIFIED(U1) — design §6.2. */
export const QR_TLV_SAFE_BYTES = 127;

/** حدّ طول النصوص الحرّة في قاموس البيانات (BR-KSA-F-06): الاسم وسبب الإشعار واسم الصنف. */
export const TEXT_MAX_CHARS = 1000;

// محارف تحكّم C0/C1 (عدا TAB وLF)، ولا-محارف XML (U+FFFE/U+FFFF)، والبدائل المنفردة
const STRIP = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * الصيغة النصّية الوحيدة للمستند: يحذف ما لا يُكتب في XML ويوحّد نهايات الأسطر إلى LF.
 * mapInvoice يطبّقها على كل نص قبل البناء (فالنموذج = الـXML = اللقطة = مصدر QR)، والفحص المسبق
 * يقيس بها الفراغ، والمُسلسِل يعيدها احتياطاً. مكانها هنا لأن هذا الملف مكتفٍ بذاته ويُنسخ للواجهة.
 */
export function sanitizeText(s: string): string {
  return String(s).replace(/\r\n?/g, '\n').replace(STRIP, '');
}

/** طول النص بالمحارف (نقاط يونيكود لا وحدات UTF-16). */
export function charLength(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++, n++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) i++;
  }
  return n;
}

/** رمز دولة بصيغة ISO 3166-1 alpha-2 (حرفان لاتينيان كبيران). الصيغة فقط — القائمة الرسمية لا تُفحص هنا. */
export function isCountryCode(s: unknown): boolean {
  return typeof s === 'string' && /^[A-Z]{2}$/.test(s);
}

/** فارغ بعد التطبيع: نصّ من محارف تحكّم فقط لا يُكتب في الـXML فهو فارغ. */
const blank = (s: unknown) => typeof s !== 'string' || sanitizeText(s).trim() === '';

function err(rule: string, field: string, messageAr: string): IssueLike {
  return { rule, field, messageAr, severity: 'error' };
}

/** مخالفات بيانات البائع (المنشأة) — تنطبق على كل أنواع المستندات. */
export function sellerIssues(party: PartyLike | undefined): IssueLike[] {
  const p = party ?? {};
  const out: IssueLike[] = [];
  const f = (x: string) => `supplier.${x}`;

  // الاسم القانوني BT-27 + حدّ وسم QR 1
  if (blank(p.registrationName)) {
    out.push(err('BR-06', f('registrationName'), 'الاسم القانوني للمنشأة (البائع) مفقود — أدخله في إعدادات الفوترة الإلكترونية'));
  } else {
    const bytes = utf8ByteLength(p.registrationName!);
    if (bytes > QR_TLV_MAX_BYTES) {
      out.push(err('QR-TAG1-LENGTH', f('registrationName'), `الاسم القانوني للمنشأة طويل جداً لرمز QR (${bytes} بايت، الحدّ ${QR_TLV_MAX_BYTES}) — اختصره`));
    } else if (bytes > QR_TLV_SAFE_BYTES) {
      out.push({ rule: 'QR-TAG1-LENGTH', field: f('registrationName'), messageAr: `تنبيه: الاسم القانوني للمنشأة ${bytes} بايت (أكثر من ${QR_TLV_SAFE_BYTES}) — ترميز طوله في رمز QR لم يُعتمد بعد`, severity: 'warning' });
    }
  }

  // الرقم الضريبي BT-31
  if (blank(p.vatNumber)) {
    out.push(err('BR-KSA-39', f('vatNumber'), 'الرقم الضريبي للمنشأة مفقود'));
  } else if (!isSaudiVat(p.vatNumber)) {
    out.push(err('BR-KSA-40', f('vatNumber'), 'الرقم الضريبي للمنشأة يجب أن يكون 15 رقماً يبدأ وينتهي بالرقم 3'));
  }

  // المعرّف الآخر BT-29 (سجل تجاري أو ما يعادله)
  const id = p.otherId;
  if (!id || blank(id.value)) {
    out.push(err('BR-KSA-08', f('otherId.value'), 'رقم السجل التجاري (أو معرّف المنشأة الآخر) مفقود'));
  } else {
    if (!(SELLER_ID_SCHEMES as readonly string[]).includes(id.scheme ?? '')) {
      out.push(err('BR-KSA-08', f('otherId.scheme'), `نوع معرّف المنشأة غير مسموح (${id.scheme ?? ''}) — المسموح: ${SELLER_ID_SCHEMES.join('، ')}`));
    }
    if (!isAlphanumericId(id.value)) {
      out.push(err('BR-KSA-08', f('otherId.value'), 'رقم السجل التجاري للمنشأة يجب أن يكون أرقاماً/حروفاً لاتينية بلا مسافات أو رموز'));
    }
  }

  // العنوان الوطني BR-KSA-09
  const a = p.address ?? {};
  const need: Array<[keyof AddressLike, string]> = [
    ['street', 'اسم الشارع'], ['buildingNumber', 'رقم المبنى'], ['district', 'الحي'],
    ['city', 'المدينة'], ['postalZone', 'الرمز البريدي'], ['country', 'رمز الدولة'],
  ];
  for (const [k, label] of need) {
    if (blank(a[k])) out.push(err('BR-KSA-09', f(`address.${k}`), `${label} في عنوان المنشأة مفقود`));
  }
  // سياسة المنصّة (كـ D9 للعملة): المرحلة الثانية للمنشآت السعودية فقط، وقواعد العنوان الوطني أعلاه
  // (4 أرقام للمبنى و5 للبريد) تفترض عنواناً سعودياً. رمز مثل KSA يخالف BR-CL-14 أيضاً.
  if (!blank(a.country) && a.country !== 'SA') {
    out.push(err(isCountryCode(a.country) ? 'ZATCA_SELLER_COUNTRY' : 'BR-CL-14', f('address.country'),
      `رمز الدولة في عنوان المنشأة يجب أن يكون SA (الحالي: ${a.country})`));
  }
  if (!blank(a.buildingNumber) && !isBuildingNo(a.buildingNumber)) {
    out.push(err('BR-KSA-37', f('address.buildingNumber'), 'رقم المبنى في عنوان المنشأة يجب أن يكون 4 أرقام'));
  }
  if (!blank(a.postalZone) && !isPostalCode(a.postalZone)) {
    out.push(err('BR-KSA-66', f('address.postalZone'), 'الرمز البريدي في عنوان المنشأة يجب أن يكون 5 أرقام'));
  }
  return out;
}

/**
 * مخالفات بيانات المشتري.
 *  - standard (01): الاسم، العنوان، والرقم الضريبي أو معرّف آخر (BR-KSA-42/10/63/67/44/81/14).
 *  - simplified (02): لا عنوان مطلوب؛ يُفحص فقط ما وُجد، ويُمنع طرف فارغ تماماً.
 *    UNVERIFIED(U12): قبول طرف مشترٍ فارغ في المبسطة — design §6.2؛ لذا يُمنع احتياطاً.
 */
export function buyerIssues(kind: 'standard' | 'simplified', party: PartyLike | undefined): IssueLike[] {
  const p = party ?? {};
  const out: IssueLike[] = [];
  const f = (x: string) => `customer.${x}`;
  const id = p.otherId;
  const hasVat = !blank(p.vatNumber);
  const hasId = !!id && !blank(id.value);

  if (hasVat && !isSaudiVat(p.vatNumber)) {
    out.push(err('BR-KSA-44', f('vatNumber'), 'الرقم الضريبي للعميل يجب أن يكون 15 رقماً يبدأ وينتهي بالرقم 3'));
  }
  if (hasId) {
    if (!(BUYER_ID_SCHEMES as readonly string[]).includes(id!.scheme ?? '')) {
      out.push(err('BR-KSA-14', f('otherId.scheme'), `نوع معرّف العميل غير مسموح (${id!.scheme ?? ''}) — المسموح: ${BUYER_ID_SCHEMES.join('، ')}`));
    }
    if (!isAlphanumericId(id!.value)) {
      out.push(err('BR-KSA-14', f('otherId.value'), 'معرّف العميل (السجل التجاري/الهوية) يجب أن يكون أرقاماً/حروفاً لاتينية بلا مسافات'));
    }
  }
  if (!blank(p.registrationName) && charLength(p.registrationName!) > TEXT_MAX_CHARS) {
    out.push(err('BR-KSA-F-06', f('registrationName'), `اسم العميل أطول من ${TEXT_MAX_CHARS} حرف — اختصره في بطاقة العميل`));
  }
  if (p.address && !blank(p.address.country) && !isCountryCode(p.address.country)) {
    out.push(err('BR-CL-14', f('address.country'), `رمز الدولة في عنوان العميل غير صالح (${p.address.country}) — المطلوب حرفان لاتينيان مثل SA`));
  }

  if (kind === 'simplified') {
    const a = p.address;
    const anyAddress = !!a && Object.values(a).some(v => !blank(v));
    if (blank(p.registrationName) && !hasVat && !hasId && !anyAddress) {
      out.push(err('BR-KSA-F-03', f('registrationName'), 'بيانات العميل فارغة تماماً — أدخل اسم العميل على الأقل'));
    }
    return out;
  }

  // ═══ الفاتورة الضريبية (01) ═══
  if (blank(p.registrationName)) {
    out.push(err('BR-KSA-42', f('registrationName'), 'اسم العميل (المنشأة المشترية) مفقود — مطلوب في الفاتورة الضريبية'));
  }
  if (!hasVat && !hasId) {
    out.push(err('BR-KSA-81', f('otherId.value'), 'العميل بلا رقم ضريبي: أدخل رقم السجل التجاري أو معرّفاً آخر للعميل'));
  }
  const a = p.address ?? {};
  const base: Array<[keyof AddressLike, string]> = [['street', 'اسم الشارع'], ['city', 'المدينة'], ['country', 'رمز الدولة']];
  for (const [k, label] of base) {
    if (blank(a[k])) out.push(err('BR-KSA-10', f(`address.${k}`), `${label} في عنوان العميل مفقود`));
  }
  if (a.country === 'SA') {
    if (blank(a.buildingNumber)) out.push(err('BR-KSA-63', f('address.buildingNumber'), 'رقم المبنى في عنوان العميل مفقود'));
    else if (!isBuildingNo(a.buildingNumber)) out.push(err('BR-KSA-63', f('address.buildingNumber'), 'رقم المبنى في عنوان العميل يجب أن يكون 4 أرقام'));
    if (blank(a.district)) out.push(err('BR-KSA-63', f('address.district'), 'الحي في عنوان العميل مفقود'));
    if (blank(a.postalZone)) out.push(err('BR-KSA-63', f('address.postalZone'), 'الرمز البريدي في عنوان العميل مفقود'));
    else if (!isPostalCode(a.postalZone)) out.push(err('BR-KSA-67', f('address.postalZone'), 'الرمز البريدي في عنوان العميل يجب أن يكون 5 أرقام'));
  }
  return out;
}
