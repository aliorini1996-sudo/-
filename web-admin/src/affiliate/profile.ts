// ============================================================================
// اكتمال ملف السفير (V2_SPEC §3): النوع + الآيبان + الهوية/الإقامة (+ السجل للشركة).
// الملف لا يحجب الحساب — هو شرط دخول دورة التسوية وحده. الخادم هو الحَكَم (`missing`
// و`profileComplete` في GET /me)؛ هنا نسبةٌ تُعرض فقط.
// ============================================================================
import type { AffiliateMe, ProfileMissing } from './types';

const KNOWN: readonly ProfileMissing[] = ['partnerType', 'iban', 'national_id', 'commercial_reg'];

export interface ProfileProgress {
  /** 0..100 */
  percent: number;
  done: number;
  total: number;
  /** ما ينقص بترتيبٍ ثابت (القيم المجهولة من خادمٍ أحدث تُهمل) */
  missing: ProfileMissing[];
  complete: boolean;
}

export function profileProgress(u: Pick<AffiliateMe, 'partnerType' | 'missing' | 'profileComplete'>): ProfileProgress {
  const raw = Array.isArray(u.missing) ? u.missing : [];
  const missing = KNOWN.filter((k) => raw.includes(k));
  const complete = u.profileComplete === true && missing.length === 0;
  // الشركة تحتاج السجل أيضاً — أربع خطوات، وغيرها ثلاث
  const total = u.partnerType === 'company' || missing.includes('commercial_reg') ? 4 : 3;
  const done = complete ? total : Math.max(0, total - missing.length);
  return { percent: Math.round((done / total) * 100), done, total, missing, complete };
}

/**
 * المستخدم بعد ردّ تعديل (PUT /me · PUT /payout-profile · POST /accept-terms): هذه الردود بلا
 * `documents` و`missing` و`profileComplete` (يحسبها GET /me وحده)، واستبدال المستخدم بها كان يُظهر
 * لحظةَ إعادة القراءة هويةً مرفوعة «لم تُرفع» واكتمالاً ١٠٠٪ «ناقصاً». فيُدمج الردّ فوق ما في الذاكرة،
 * وتبقى الحقول الثلاثة القديمة ما لم يُرسلها الخادم — حتى تصل قراءة /me (الخادم هو الحَكَم).
 */
export function mergeMeUser(old: AffiliateMe, u: Partial<AffiliateMe>): AffiliateMe {
  return {
    ...old,
    ...u,
    documents: Array.isArray(u.documents) ? u.documents : old.documents,
    missing: Array.isArray(u.missing) ? u.missing : old.missing,
    profileComplete: typeof u.profileComplete === 'boolean' ? u.profileComplete : old.profileComplete,
  };
}

/** هل يُطلب السجل التجاري؟ للشركة وحدها (أو إن طلبه الخادم صراحةً) */
export function needsCommercialReg(u: Pick<AffiliateMe, 'partnerType' | 'missing'>): boolean {
  return u.partnerType === 'company' || (Array.isArray(u.missing) && u.missing.includes('commercial_reg'));
}
