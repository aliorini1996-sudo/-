// ============================================================================
// تحقّق نقيّ لنماذج بوابة السفير — مرآة لقواعد الخادم
// (backend/src/services/affiliate/rules.ts) لإعطاء ردٍّ فوريّ قبل الإرسال.
// الخادم يبقى الحَكَم: هذه طبقة راحة لا طبقة أمان.
// ============================================================================
import type { ClaimBody, ClaimHow, RegisterBody, UpdateMeBody } from './types';
import { CLAIM_HOW_ORDER } from './labels';

/** أقصى طول لاسم المدينة — مطابق للخادم (التسجيل والترشيح والملف) */
export const CITY_MAX = 60;
export const CITY_TOO_LONG = `اسم المدينة ${CITY_MAX} حرفاً كحدّ أقصى`;

/** الأرقام العربية والفارسية إلى لاتينية */
export function latinDigits(s: string): string {
  return s
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)));
}

/**
 * هل في النصّ الحرّ بيانات اتصال؟ (العقد §1 القاعدة 9) — مرآةٌ حرفية لكاشف الخادم
 * (`containsContactInfo` في backend/src/services/affiliate/rules.ts):
 *
 *  1. NFKC أولاً (الأرقام و«＠» العريضة تصير عادية) ثم الأرقام العربية-الهندية والفارسية لاتينية.
 *  2. بريدٌ ⇒ مرفوض.
 *  3. التواريخ (2026-09-13 · 13/09/2026) والأوقات (14:00) تُستبدل بكلمة قبل الفحص.
 *  4. أيّ سلسلةٍ تبدأ برقم وتنتهي برقم وليس بينهما **حرف** (فالفاصلة العربية «،» والفاصل
 *     العشري «٫» والنقطتان والمحارف الخفيّة كلها فواصل) وتحوي ثمانية أرقامٍ فأكثر ⇒ مرفوض.
 */
export const CONTACT_MIN_DIGITS = 8;

export function containsContactInfo(text: unknown): boolean {
  if (typeof text !== 'string' || !text) return false;
  const t = latinDigits(text.normalize('NFKC'));
  if (/[^\s@]+@[^\s@]+\.[^\s@]+/.test(t)) return true;
  const cleaned = t
    .replace(/(?:19|20)\d{2}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.](?:19|20)\d{2}/g, ' تاريخ ')
    .replace(/\b\d{1,2}:\d{2}\b/g, ' وقت ');
  for (const m of cleaned.matchAll(/\d[^\p{L}]*\d/gu)) {
    if (m[0].replace(/\D/g, '').length >= CONTACT_MIN_DIGITS) return true;
  }
  return false;
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());
}

/** جوال سعودي بصيغة 9665XXXXXXXX أو null — مطابق لـnormPhoneSA في الخادم */
export function normPhoneSA(phone: string): string | null {
  let d = latinDigits(phone || '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('966')) d = d.slice(3);
  if (d.startsWith('0')) d = d.slice(1);
  return /^5\d{8}$/.test(d) ? `966${d}` : null;
}

/** السجل التجاري: عشرة أرقام — أو null */
export function normCR(cr: string): string | null {
  const d = latinDigits(cr || '').replace(/\D/g, '');
  return /^\d{10}$/.test(d) ? d : null;
}

/** الرقم الضريبي: 15 رقماً (API.md) — يُعيد الأرقام أو null */
export function normVat(vat: string): string | null {
  const d = latinDigits(vat || '').replace(/[\s-]/g, '');
  return /^\d{15}$/.test(d) ? d : null;
}

/** آيبان سعودي: SA + 22 رقماً ويجتاز mod-97 — مطابق لـnormIbanSA في الخادم */
export function normIbanSA(iban: string): string | null {
  const s = latinDigits(iban || '').replace(/\s+/g, '').toUpperCase();
  if (!/^SA\d{22}$/.test(s)) return null;
  const rearranged = s.slice(4) + s.slice(0, 4);
  const numeric = rearranged.replace(/[A-Z]/g, (ch) => String(ch.charCodeAt(0) - 55));
  let rem = 0;
  for (const ch of numeric) rem = (rem * 10 + Number(ch)) % 97;
  return rem === 1 ? s : null;
}

/** تاريخ تقويميّ حقيقيّ بصيغة YYYY-MM-DD (يرفض 2026-02-30) */
export function isIsoDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** رقم ترخيص موثوق مُطبَّع: أرقام لاتينية وأحرف وشرطات، 3..40 */
export function normMawthooqNo(no: string): string | null {
  const s = latinDigits(no || '').trim().replace(/\s+/g, '');
  return /^[A-Za-z0-9-]{3,40}$/.test(s) ? s : null;
}

/**
 * ترخيص موثوق للناشر العلني: رقمٌ صالح وتاريخ انتهاءٍ صالح لم يمضِ.
 * `today` بصيغة YYYY-MM-DD (توقيت الرياض) — مُمرَّر ليبقى الاختبار حتمياً.
 */
export function mawthooqError(no: string, expiry: string, today: string): string | null {
  if (!no.trim()) return 'أدخل رقم ترخيص «موثوق»';
  if (!normMawthooqNo(no)) return 'رقم ترخيص «موثوق» غير صالح';
  if (!expiry) return 'أدخل تاريخ انتهاء ترخيص «موثوق»';
  if (!isIsoDate(expiry)) return 'تاريخ انتهاء الترخيص غير صالح';
  if (expiry < today) return 'ترخيص «موثوق» منتهٍ — جدّده قبل النشر العلني';
  return null;
}

// ─────────────────────────── التسجيل ───────────────────────────

export interface RegisterForm {
  fullName: string;
  email: string;
  phone: string;
  city: string;
  password: string;
  publicPromoter: boolean;
  mawthooqNo: string;
  mawthooqExpiry: string;
  vatNumber: string;
  marketingConsent: boolean;
  acceptTerms: boolean;
  declarations: { independent: boolean; noSpam: boolean; disclose: boolean };
}

export const EMPTY_REGISTER: RegisterForm = {
  fullName: '', email: '', phone: '', city: '', password: '',
  publicPromoter: false, mawthooqNo: '', mawthooqExpiry: '', vatNumber: '',
  marketingConsent: false, acceptTerms: false,
  declarations: { independent: false, noSpam: false, disclose: false },
};

/** أوّل خطأ في نموذج التسجيل (بترتيب الحقول على الشاشة) أو null */
export function registerError(f: RegisterForm, today: string): string | null {
  const name = f.fullName.trim();
  if (name.length < 2 || name.length > 80) return 'الاسم الكامل بين حرفين و80 حرفاً';
  if (!isValidEmail(f.email)) return 'البريد الإلكتروني غير صحيح';
  if (!normPhoneSA(f.phone)) return 'أدخل رقم جوال سعودي صحيح يبدأ بـ05';
  if (f.city.trim().length > CITY_MAX) return CITY_TOO_LONG;
  if (f.password.length < 8) return 'كلمة المرور 8 أحرف على الأقل';
  if (f.password.length > 128) return 'كلمة المرور طويلة جداً';
  if (f.vatNumber.trim() && !normVat(f.vatNumber)) return 'الرقم الضريبي 15 رقماً';
  if (f.publicPromoter) {
    const m = mawthooqError(f.mawthooqNo, f.mawthooqExpiry, today);
    if (m) return m;
  }
  if (!f.acceptTerms) return 'يجب قراءة الشروط والموافقة عليها';
  const d = f.declarations;
  if (!d.independent || !d.noSpam || !d.disclose) return 'يجب الإقرار بجميع البنود الثلاثة';
  return null;
}

/** جسم POST /register بالشكل الدقيق في API.md — الحقول الاختيارية تُرسل فقط إن وُجدت */
export function buildRegisterBody(f: RegisterForm, termsVersion: string): RegisterBody {
  const body: RegisterBody = {
    fullName: f.fullName.trim(),
    email: f.email.trim().toLowerCase(),
    phone: normPhoneSA(f.phone) ?? f.phone.trim(),
    password: f.password,
    publicPromoter: f.publicPromoter,
    marketingConsent: f.marketingConsent,
    acceptTerms: true,
    termsVersion,
    declarations: { independent: true, noSpam: true, disclose: true },
  };
  const city = f.city.trim();
  if (city) body.city = city;
  const vat = f.vatNumber.trim() ? (normVat(f.vatNumber) ?? f.vatNumber.trim()) : '';
  if (vat) body.vatNumber = vat;
  if (f.publicPromoter) {
    body.mawthooqNo = normMawthooqNo(f.mawthooqNo) ?? f.mawthooqNo.trim();
    body.mawthooqExpiry = f.mawthooqExpiry;
  }
  return body;
}

// ─────────────────────────── الترشيح ───────────────────────────

export interface ClaimForm { companyName: string; crNumber: string; city: string; how: ClaimHow | ''; note: string }
export const EMPTY_CLAIM: ClaimForm = { companyName: '', crNumber: '', city: '', how: '', note: '' };
export const NOTE_MAX = 200;

export function claimError(f: ClaimForm): string | null {
  const name = f.companyName.trim();
  if (name.length < 2 || name.length > 120) return 'اسم المنشأة بين حرفين و120 حرفاً';
  if (containsContactInfo(name)) return 'اكتب اسم المنشأة فقط — بلا جوال أو بريد';
  if (!normCR(f.crNumber)) return 'السجل التجاري 10 أرقام';
  if (f.city.trim().length > CITY_MAX) return CITY_TOO_LONG;
  if (containsContactInfo(f.city)) return 'اكتب اسم المدينة فقط — بلا جوال أو بريد';
  if (!f.how || !CLAIM_HOW_ORDER.includes(f.how)) return 'اختر كيف عرّفت المنشأة';
  if (f.note.trim().length > NOTE_MAX) return `الملاحظة ${NOTE_MAX} حرف كحدّ أقصى`;
  if (containsContactInfo(f.note)) return 'الملاحظة لا تقبل أرقام جوال أو بريداً — لا نجمع بيانات أشخاص';
  return null;
}

export function buildClaimBody(f: ClaimForm): ClaimBody {
  const body: ClaimBody = {
    companyName: f.companyName.trim(),
    crNumber: normCR(f.crNumber) ?? f.crNumber.trim(),
    how: f.how as ClaimHow,
  };
  const city = f.city.trim();
  if (city) body.city = city;
  const note = f.note.trim();
  if (note) body.note = note;
  return body;
}

// ─────────────────────────── الملف ───────────────────────────

export interface ProfileForm {
  city: string;
  marketingConsent: boolean;
  publicPromoter: boolean;
  mawthooqNo: string;
  mawthooqExpiry: string;
  vatNumber: string;
}

/** حقول PUT /me التي تُطلق شرط «موثوق» في الخادم متى وردت في الجسم */
const MAWTHOOQ_TRIGGERS = ['publicPromoter', 'mawthooqNo', 'mawthooqExpiry'] as const;

/**
 * أوّل خطأ في نموذج الملف أو null.
 *
 * شرط «موثوق» (رقمٌ وتاريخ انتهاءٍ لم يمضِ) يُفحص **فقط** حين يحمل جسم الحفظ
 * `publicPromoter` أو `mawthooqNo` أو `mawthooqExpiry` — كما يفعل الخادم. فحفظ
 * المدينة أو الموافقة التسويقية أو الرقم الضريبي وحدها لا يمنعه ترخيصٌ انتهى.
 * والترخيص سارٍ حتى نهاية يوم انتهائه (`expiry >= today` بتوقيت الرياض).
 */
export function profileError(f: ProfileForm, initial: ProfileForm, today: string): string | null {
  if (f.city.trim().length > CITY_MAX) return CITY_TOO_LONG;
  if (f.vatNumber.trim() && !normVat(f.vatNumber)) return 'الرقم الضريبي 15 رقماً';
  const body = buildProfileBody(f, initial);
  const touchesMawthooq = MAWTHOOQ_TRIGGERS.some((k) => k in body);
  if (touchesMawthooq && f.publicPromoter) return mawthooqError(f.mawthooqNo, f.mawthooqExpiry, today);
  return null;
}

/**
 * جسم PUT /me بالحقول **المتغيّرة** فقط. حقلٌ نصّيّ أُفرغ يُرسل `''` (مسحٌ صريح)،
 * وحقول موثوق لا تُرسل حين يُطفأ «سأنشر علناً».
 */
export function buildProfileBody(f: ProfileForm, initial: ProfileForm): UpdateMeBody {
  const body: UpdateMeBody = {};
  const city = f.city.trim();
  if (city !== initial.city.trim()) body.city = city;
  if (f.marketingConsent !== initial.marketingConsent) body.marketingConsent = f.marketingConsent;
  if (f.publicPromoter !== initial.publicPromoter) body.publicPromoter = f.publicPromoter;
  if (f.publicPromoter) {
    const no = normMawthooqNo(f.mawthooqNo) ?? f.mawthooqNo.trim();
    if (no !== initial.mawthooqNo.trim() || f.publicPromoter !== initial.publicPromoter) body.mawthooqNo = no;
    if (f.mawthooqExpiry !== initial.mawthooqExpiry || f.publicPromoter !== initial.publicPromoter) body.mawthooqExpiry = f.mawthooqExpiry;
  }
  const vat = f.vatNumber.trim() ? (normVat(f.vatNumber) ?? f.vatNumber.trim()) : '';
  if (vat !== (initial.vatNumber.trim())) body.vatNumber = vat;
  return body;
}

// ─────────────────────────── الاستلام ───────────────────────────

export function payoutError(iban: string, holderName: string, bankName: string): string | null {
  if (!normIbanSA(iban)) return 'آيبان غير صالح — يبدأ بـSA ويتبعه 22 رقماً';
  const h = holderName.trim();
  if (h.length < 2 || h.length > 120) return 'اسم صاحب الحساب بين حرفين و120 حرفاً';
  if (bankName.trim().length > 80) return 'اسم البنك طويل';
  return null;
}
