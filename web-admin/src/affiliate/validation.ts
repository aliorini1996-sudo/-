// ============================================================================
// تحقّق نقيّ لنماذج بوابة السفير — مرآة لقواعد الخادم
// (backend/src/services/affiliate/rules.ts) لإعطاء ردٍّ فوريّ قبل الإرسال.
// الخادم يبقى الحَكَم: هذه طبقة راحة لا طبقة أمان.
//
// لا نصوص هنا: كل خطأ مفتاحٌ في قاموس البوابة (./i18n) مع متغيّراته، والواجهة
// تترجمه بلغة العرض.
// ============================================================================
import type { ClaimBody, ClaimHow, RegisterBody, TrialBody, UpdateMeBody } from './types';
import { CLAIM_HOW_ORDER } from './labels';
import { msg, type AxMsg } from './i18n';
import { dialOf } from '../i18n/dialCodes';

/** أقصى طول لاسم المدينة — مطابق للخادم (التسجيل والترشيح والملف) */
export const CITY_MAX = 60;
const cityTooLong = (): AxMsg => msg('val.cityTooLong', { max: CITY_MAX });

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

/**
 * هل في الاسم رابطٌ أو نطاق موقع؟ — مرآة `containsLinkLike` في الخادم (rules.ts):
 * NFKC والأرقام اللاتينية أولاً، ثم `http(s)://` أو `www.`، أو كلمةٌ من حرفين فأكثر تليها نقطة
 * وامتدادٌ لاتينيّ (fieldsa-pay.com). اسم الشركة واسم مسؤولها يصلان بريدَ المالك ولوحته،
 * فلا يُستعملان قناةً لرابط تصيّد. «Al-Noor Co.» و«شركة 2026» أسماءٌ لا روابط.
 */
export function containsLinkLike(text: unknown): boolean {
  if (typeof text !== 'string' || !text) return false;
  const t = latinDigits(text.normalize('NFKC'));
  return /(https?:\/\/|www\.)/i.test(t) || /[\p{L}\p{N}-]{2,}\.[a-z]{2,24}\b/iu.test(t);
}

/**
 * قاعدة zod `.email()` في الخادم حرفياً (zod 3.25، `z.string().trim().email()`): لا نقطة في
 * البداية ولا نقطتان متتاليتان ولا نقطة قبل @، ونطاقٌ بمقاطع لاتينية ورقمية وشرطة، وامتدادٌ
 * من حرفين لاتينيين فأكثر، ومحارف ASCII فقط. أرخى منها يُمرّر ما يرفضه الخادم برسالةٍ عامة.
 */
const EMAIL_RE = /^(?!\.)(?!.*\.\.)([A-Z0-9_'+\-\.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9\-]*\.)+[A-Z]{2,}$/i;

export function isValidEmail(email: string): boolean {
  return EMAIL_RE.test((email || '').trim());
}

/** جوال سعودي بصيغة 9665XXXXXXXX أو null — مطابق لـnormPhoneSA في الخادم */
export function normPhoneSA(phone: string): string | null {
  let d = latinDigits(phone || '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('966')) d = d.slice(3);
  if (d.startsWith('0')) d = d.slice(1);
  return /^5\d{8}$/.test(d) ? `966${d}` : null;
}

/**
 * جوال السفير من أيّ دولة — مرآة normAffiliatePhone في الخادم: السعوديّ `9665XXXXXXXX`،
 * وغيره بمفتاح دولته صراحةً أرقاماً دوليةً بلا `+`، أو null.
 */
export function normAffiliatePhone(phone: string): string | null {
  const raw = latinDigits((phone || '').normalize('NFKC')).trim();
  if (!raw || raw.length > 30) return null;
  const mobile = normPhoneSA(raw);
  if (mobile) return mobile;
  let d = raw.replace(/[\s\-().]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  else if (d.startsWith('00')) d = d.slice(2);
  else return null;
  if (!/^[1-9]\d{7,14}$/.test(d)) return null;
  if (d.startsWith('966')) return null;
  return d;
}

/** الرقم كاملاً من مفتاح الدولة المختار والرقم المحلّي (الصفر الأول يُحذف: 050… ← +971 50…) */
export function composeAffiliatePhone(country: string, local: string): string {
  const digits = latinDigits((local || '').normalize('NFKC')).replace(/\D/g, '').replace(/^0+/, '');
  return `${dialOf(country) || '+966'}${digits}`;
}

/** أقصى طول لرقم التواصل كما كُتب — مطابق للخادم */
export const CONTACT_PHONE_MAX = 30;

/**
 * رقم تواصل المنشأة المُرشَّحة — مرآة لقاعدة الخادم: جوال سعودي (05XXXXXXXX · 5XXXXXXXX ·
 * +9665… · 009665…، والأرقام العربية-الهندية مقبولة)، أو أيّ رقمٍ آخر من 8 إلى 15 رقماً
 * بعد حذف المسافات والشرطات والأقواس والنقاط و+ أو 00 في أوّله. يُعيد الرقم بأرقامٍ
 * لاتينية كما كُتب (للإرسال)، أو null.
 * كاشف بيانات الاتصال لا يُطبَّق على هذه الخانة — مكانها الصحيح.
 */
export function normContactPhone(raw: string): string | null {
  // NFKC قبل كل شيء — مرآة الخادم: الأرقام و«＋» و«（）» العريضة (لوحات مفاتيح صينية) تصير عادية
  const s = latinDigits((raw || '').normalize('NFKC')).trim();
  if (!s || s.length > CONTACT_PHONE_MAX) return null;
  if (normPhoneSA(s)) return s;
  let d = s.replace(/[\s\-().]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  else if (d.startsWith('00')) d = d.slice(2);
  return /^\d{8,15}$/.test(d) ? s : null;
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

// ─────────────────────────── التسجيل ───────────────────────────

export interface RegisterForm {
  fullName: string;
  email: string;
  /** مفتاح دولة الجوال (ISO alpha-2) — السعودية افتراضاً */
  phoneCountry: string;
  phone: string;
  city: string;
  password: string;
  vatNumber: string;
  marketingConsent: boolean;
  acceptTerms: boolean;
}

export const EMPTY_REGISTER: RegisterForm = {
  fullName: '', email: '', phoneCountry: 'SA', phone: '', city: '', password: '', vatNumber: '',
  marketingConsent: false, acceptTerms: false,
};

/** أوّل خطأ في نموذج التسجيل (بترتيب الحقول على الشاشة) أو null */
export function registerError(f: RegisterForm): AxMsg | null {
  const name = f.fullName.trim();
  if (name.length < 2 || name.length > 80) return msg('val.fullName');
  if (!isValidEmail(f.email)) return msg('val.email');
  if (!normAffiliatePhone(composeAffiliatePhone(f.phoneCountry, f.phone))) return msg('val.phone');
  if (f.city.trim().length > CITY_MAX) return cityTooLong();
  if (f.password.length < 8) return msg('val.passwordMin');
  if (f.password.length > 128) return msg('val.passwordMax');
  if (f.vatNumber.trim() && !normVat(f.vatNumber)) return msg('val.vat');
  if (!f.acceptTerms) return msg('val.acceptTerms');
  return null;
}

/** الجوال كما يُرسل: السعوديّ `9665…` كما كان، والدوليّ بـ`+` كي لا يُقرأ رقماً محلياً */
function registerPhone(f: RegisterForm): string {
  const composed = composeAffiliatePhone(f.phoneCountry, f.phone);
  const n = normAffiliatePhone(composed);
  if (!n) return composed;
  return n.startsWith('966') ? n : `+${n}`;
}

/** جسم POST /register — الحقول الاختيارية تُرسل فقط إن وُجدت */
export function buildRegisterBody(f: RegisterForm, termsVersion: string): RegisterBody {
  const body: RegisterBody = {
    fullName: f.fullName.trim(),
    email: f.email.trim().toLowerCase(),
    phone: registerPhone(f),
    password: f.password,
    marketingConsent: f.marketingConsent,
    acceptTerms: true,
    termsVersion,
  };
  const city = f.city.trim();
  if (city) body.city = city;
  const vat = f.vatNumber.trim() ? (normVat(f.vatNumber) ?? f.vatNumber.trim()) : '';
  if (vat) body.vatNumber = vat;
  return body;
}

// ─────────────────────────── الترشيح ───────────────────────────

export interface ClaimForm { companyName: string; crNumber: string; city: string; contactPhone: string; how: ClaimHow | ''; note: string }
export const EMPTY_CLAIM: ClaimForm = { companyName: '', crNumber: '', city: '', contactPhone: '', how: '', note: '' };
export const NOTE_MAX = 200;

export function claimError(f: ClaimForm): AxMsg | null {
  const name = f.companyName.trim();
  if (name.length < 2 || name.length > 120) return msg('val.companyName');
  if (containsContactInfo(name)) return msg('val.companyContact');
  if (!normCR(f.crNumber)) return msg('val.cr');
  if (f.city.trim().length > CITY_MAX) return cityTooLong();
  if (containsContactInfo(f.city)) return msg('val.cityContact');
  if (!f.contactPhone.trim()) return msg('val.contactPhoneRequired');
  if (!normContactPhone(f.contactPhone)) return msg('val.contactPhone');
  if (!f.how || !CLAIM_HOW_ORDER.includes(f.how)) return msg('val.how');
  if (f.note.trim().length > NOTE_MAX) return msg('val.noteTooLong', { max: NOTE_MAX });
  if (containsContactInfo(f.note)) return msg('val.noteContact');
  return null;
}

export function buildClaimBody(f: ClaimForm): ClaimBody {
  const body: ClaimBody = {
    companyName: f.companyName.trim(),
    crNumber: normCR(f.crNumber) ?? f.crNumber.trim(),
    contactPhone: normContactPhone(f.contactPhone) ?? latinDigits(f.contactPhone).trim(),
    how: f.how as ClaimHow,
  };
  const city = f.city.trim();
  if (city) body.city = city;
  const note = f.note.trim();
  if (note) body.note = note;
  return body;
}

// ─────────────────────── الحساب التجريبي ───────────────────────

/**
 * مفتاح مقارنة الجوال — مرآة `affiliatePhoneKey` في الخادم: صيغة normAffiliatePhone، وجوال السفير
 * المخزَّن أرقاماً دوليةً بلا «+» (`971501234567` — هكذا يحفظه التسجيل) يُعاد إليه «+»، وإلا لما
 * طابق سفيرٌ غير سعوديّ جواله أبداً.
 */
function phoneKeyOf(phone: string | null | undefined): string | null {
  if (typeof phone !== 'string' || !phone.trim()) return null;
  const direct = normAffiliatePhone(phone);
  if (direct) return direct;
  const digits = phone.trim();
  return /^[1-9]\d{7,14}$/.test(digits) ? normAffiliatePhone(`+${digits}`) : null;
}

/**
 * بريد مسؤول الشركة أو جواله هو بريد السفير أو جواله؟ — مرآة `isSelfContact` في الخادم الذي
 * يرفضه رفضاً صريحاً: رابط التفعيل يصل ذلك البريد، فلا يصحّ أن يكون صندوق السفير نفسه.
 * يقارن بيانات السفير وحده — فلا يكشف شيئاً عن غيره.
 */
export function isSelfContact(i: {
  affiliateEmail: string | null | undefined;
  affiliatePhone: string | null | undefined;
  adminEmail: string | null | undefined;
  adminPhone: string | null | undefined;
}): boolean {
  const ae = (i.affiliateEmail || '').trim().toLowerCase();
  const be = (i.adminEmail || '').trim().toLowerCase();
  if (ae && ae === be) return true;
  const ap = phoneKeyOf(i.affiliatePhone);
  const bp = phoneKeyOf(i.adminPhone);
  return !!ap && !!bp && ap === bp;
}

/** حدود الخادم (zod في POST /trials) */
export const TRIAL_COMPANY_MAX = 120;
export const TRIAL_ADMIN_NAME_MAX = 80;
export const TRIAL_EMAIL_MAX = 160;

export interface TrialForm {
  companyName: string;
  /** دولة الشركة (ISO alpha-2) — تضبط عملتها وضريبتها، والسعودية افتراضاً */
  country: string;
  adminName: string;
  adminEmail: string;
  /** مفتاح دولة جوال المسؤول — يتبع دولة الشركة ويُغيَّر يدوياً */
  phoneCountry: string;
  adminPhone: string;
  /** السجل التجاري — اختياري (قرار المالك)، ويُطابَق به الترشيح المعتمد إن وُجد */
  crNumber: string;
  consent: boolean;
}

export const EMPTY_TRIAL: TrialForm = {
  companyName: '', country: 'SA', adminName: '', adminEmail: '', phoneCountry: 'SA', adminPhone: '', crNumber: '', consent: false,
};

/** جوال المسؤول دولياً `+<مفتاح الدولة><الرقم>` — كما يُرسل */
export function trialPhone(f: Pick<TrialForm, 'phoneCountry' | 'adminPhone'>): string {
  return composeAffiliatePhone(f.phoneCountry, f.adminPhone);
}

/**
 * أوّل خطأ في نموذج الحساب التجريبي (بترتيب الحقول على الشاشة) أو null. `me` = بيانات السفير
 * نفسه: بريد المسؤول أو جواله إن طابقا بريده أو جواله رُفضا هنا كما يرفضهما الخادم.
 */
export function trialError(f: TrialForm, me?: { email: string; phone: string | null } | null): AxMsg | null {
  const company = f.companyName.trim();
  if (company.length < 2 || company.length > TRIAL_COMPANY_MAX) return msg('val.companyName');
  if (containsContactInfo(company)) return msg('val.companyContact');
  if (containsLinkLike(company)) return msg('val.linkLike');
  const admin = f.adminName.trim();
  if (admin.length < 2 || admin.length > TRIAL_ADMIN_NAME_MAX) return msg('val.adminName');
  if (containsContactInfo(admin) || containsLinkLike(admin)) return msg('val.linkLike');
  const email = f.adminEmail.trim();
  if (!isValidEmail(email) || email.length > TRIAL_EMAIL_MAX) return msg('val.adminEmail');
  if (!normAffiliatePhone(trialPhone(f))) return msg('val.adminPhone');
  if (me && isSelfContact({ affiliateEmail: me.email, affiliatePhone: me.phone, adminEmail: email, adminPhone: trialPhone(f) })) {
    return msg('val.selfContact');
  }
  if (f.crNumber.trim() && !normCR(f.crNumber)) return msg('val.cr');
  if (!f.consent) return msg('val.consent');
  return null;
}

/** جسم POST /trials — السجل والدولة يُرسلان فقط إن وُجدا، والبريد بأحرفٍ صغيرة (اسم الدخول) */
export function buildTrialBody(f: TrialForm): TrialBody {
  const body: TrialBody = {
    companyName: f.companyName.trim(),
    adminName: f.adminName.trim(),
    adminEmail: f.adminEmail.trim().toLowerCase(),
    adminPhone: trialPhone(f),
    consent: true,
  };
  if (/^[A-Z]{2}$/.test(f.country)) body.countryCode = f.country;
  const cr = f.crNumber.trim();
  if (cr) body.crNumber = normCR(cr) ?? latinDigits(cr);
  return body;
}

// ─────────────────────────── الملف ───────────────────────────

export interface ProfileForm {
  city: string;
  marketingConsent: boolean;
  vatNumber: string;
}

/** أوّل خطأ في نموذج الملف أو null */
export function profileError(f: ProfileForm): AxMsg | null {
  if (f.city.trim().length > CITY_MAX) return cityTooLong();
  if (f.vatNumber.trim() && !normVat(f.vatNumber)) return msg('val.vat');
  return null;
}

/** جسم PUT /me بالحقول **المتغيّرة** فقط. حقلٌ نصّيّ أُفرغ يُرسل `''` (مسحٌ صريح) */
export function buildProfileBody(f: ProfileForm, initial: ProfileForm): UpdateMeBody {
  const body: UpdateMeBody = {};
  const city = f.city.trim();
  if (city !== initial.city.trim()) body.city = city;
  if (f.marketingConsent !== initial.marketingConsent) body.marketingConsent = f.marketingConsent;
  const vat = f.vatNumber.trim() ? (normVat(f.vatNumber) ?? f.vatNumber.trim()) : '';
  if (vat !== (initial.vatNumber.trim())) body.vatNumber = vat;
  return body;
}

// ─────────────────────────── الاستلام ───────────────────────────

export function payoutError(iban: string, holderName: string, bankName: string): AxMsg | null {
  if (!normIbanSA(iban)) return msg('val.iban');
  const h = holderName.trim();
  if (h.length < 2 || h.length > 120) return msg('val.holder');
  if (bankName.trim().length > 80) return msg('val.bank');
  return null;
}
