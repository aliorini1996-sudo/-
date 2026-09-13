// ============================================================================
// برنامج «سفير فيلد سيلز» — القواعد النقيّة (بلا قاعدة بيانات).
// ----------------------------------------------------------------------------
// كل رقمٍ ماليّ وكل قرارٍ حاسم في البرنامج يُحسب هنا ويُختبَر وحده، ثم تستعمله
// المسارات. والقرارات الحاكمة من المالك (١٣ سبتمبر ٢٠٢٦) — اقرأ
// docs/affiliate/CONTRACT.md §0 قبل تعديل أيّ دالّة هنا:
//   · العمولة ٣٠٪ من **الدفعة الأولى المؤكَّدة فقط** لكل شركة، لا تكرار.
//   · الأساس **كامل مبلغ الدفعة شاملاً الضريبة** ولو غطّت سنةً مقدّماً.
//   · الصرف يدويّ من المالك؛ المنصّة لا تحرّك مالاً.
// ============================================================================
import { randomInt } from 'crypto';

// ───────────────────────────── المال ─────────────────────────────

/**
 * عمولة دفعةٍ بالهللات — صحيحٌ دائماً، ونصفٌ لأعلى.
 *
 * بالهللات لا بالريالات: ٣٠٪ من ٢٩٩٫٠٠ = ٨٩٫٧٠ بلا كسر، لكنّ ٣٠٪ من ٣٩٩٫٩٩
 * = ١١٩٫٩٩٧ — والتقريب في الريال بعد الضرب يترك الكسر العشريّ للّغة، وفي
 * الهللة لا يترك شيئاً.
 */
export function commissionHalalas(paymentHalalas: number, rateBps: number): number {
  if (!Number.isFinite(paymentHalalas) || !Number.isFinite(rateBps)) return 0;
  if (paymentHalalas <= 0 || rateBps <= 0) return 0;
  // (a × b + 5000) / 10000 صحيحاً = تقريبٌ نصفٌ لأعلى بلا فاصلة عائمة
  return Math.floor((Math.trunc(paymentHalalas) * Math.trunc(rateBps) + 5000) / 10000);
}

/**
 * العمولة بعد استردادٍ جزئي: النسبة × (الدفعة − المسترد التراكمي).
 * `refunded` تراكميّ كما يعيده ميسر، فتكرار الإشعار نفسه لا يخفّضها مرّتين.
 */
export function commissionAfterRefund(paymentHalalas: number, refundedHalalas: number, rateBps: number): number {
  const paid = Math.trunc(paymentHalalas);
  const refunded = Math.min(Math.max(0, Math.trunc(refundedHalalas) || 0), Math.max(0, paid));
  return commissionHalalas(paid - refunded, rateBps);
}

/**
 * القيد السالب الواجب إضافته ليبلغ مجموع قيود الاسترداد هدفه — لا يزيد عن الهدف أبداً.
 * `target` ≤ 0 (مجموع ما يجب خصمه)، و`existing` مجموع ما خُصم فعلاً (≤ 0).
 * يُعيد صفراً إن كان المخصوم بلغ الهدف أو تجاوزه.
 */
export function clawbackDelta(existing: number, target: number): number {
  const e = Math.min(0, Math.trunc(existing) || 0);
  const g = Math.min(0, Math.trunc(target) || 0);
  return g < e ? g - e : 0;
}

/** تاريخ الاستحقاق = لحظة الدفع + أيّام الحجز — يُحسب مرّةً ويُخزَّن */
export function eligibleAt(paidAt: Date, holdDays: number): Date {
  const days = Number.isFinite(holdDays) && holdDays > 0 ? Math.trunc(holdDays) : 0;
  return new Date(paidAt.getTime() + days * 86_400_000);
}

/** هل الدفعة داخل نافذة الإسناد؟ (بعد بدئه، وقبل مهلة الدفعة الأولى) */
export function paymentWithinAttribution(
  paidAt: Date,
  attribution: { effectiveFrom: Date; firstPaymentDeadline: Date },
): boolean {
  const t = paidAt.getTime();
  return t >= attribution.effectiveFrom.getTime() && t <= attribution.firstPaymentDeadline.getTime();
}

// ───────────────────────────── الرموز ─────────────────────────────

/**
 * أبجدية الرمز بلا الأحرف المتشابهة: لا 0/O ولا 1/I/L.
 * يُقرأ الرمز بصوتٍ في مكالمة، ويُكتب من صورة، و«O» مكان «0» يُضيّع عمولة.
 */
export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const CODE_LENGTH = 8;
const CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);

export function generateCode(): string {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return out;
}

/**
 * يقرأ رمز إحالة من مدخلٍ حرّ — **لا يرمي أبداً**.
 *
 * يُستدعى من تسجيل الشركة، وقاعدة العقد الأولى أنّ رمزاً خاطئاً لا يُفشل
 * تسجيل شركةٍ جاءت تشترك. فالمسافات والأحرف الصغيرة والشرطات تُطبَّع، والأحرف
 * المتشابهة التي يكتبها الناس خطأً (O بدل 0 …) **لا** تُصحَّح تخميناً — رمزٌ
 * مُصحَّحٌ خطأً يمنح عمولةً لمسوّقٍ آخر. وما لا يطابق الصيغة يُعاد `null`.
 */
export function parseRef(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const s = input.normalize('NFKC').replace(/[\s\-_.]/g, '').toUpperCase();
  return CODE_RE.test(s) ? s : null;
}

// ───────────────────────────── التطبيع ─────────────────────────────

export function normEmail(email: unknown): string {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

/** الأرقام العربية والفارسية إلى لاتينية */
function latinDigits(s: string): string {
  return s
    .replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)));
}

/**
 * جوال سعودي بصيغةٍ واحدة `9665XXXXXXXX` — أو `null` إن لم يكن جوالاً سعودياً.
 * يقبل 05… و5… و+9665… و009665…، والأرقام العربية.
 */
export function normPhoneSA(phone: unknown): string | null {
  if (typeof phone !== 'string') return null;
  let d = latinDigits(phone).replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('966')) d = d.slice(3);
  if (d.startsWith('0')) d = d.slice(1);
  return /^5\d{8}$/.test(d) ? `966${d}` : null;
}

/** السجل التجاري: عشرة أرقام — أو `null` */
export function normCR(cr: unknown): string | null {
  if (typeof cr !== 'string') return null;
  const d = latinDigits(cr).replace(/\D/g, '');
  return /^\d{10}$/.test(d) ? d : null;
}

/**
 * اسم منشأةٍ مُطبَّع للمطابقة: بلا تشكيل، والألف والتاء المربوطة والياء موحّدة،
 * وبلا الكلمات العامة التي تتكرّر في الأسماء كلّها («مؤسسة» و«شركة»…).
 */
export function normCompanyName(name: unknown): string {
  if (typeof name !== 'string') return '';
  let s = name.normalize('NFKC').toLowerCase();
  s = s.replace(/[ً-ْـ]/g, '');           // تشكيل وتطويل
  s = s.replace(/[أإآٱ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي');
  s = s.replace(/[^\p{L}\p{N}\s]/gu, ' ');
  const STOP = new Set(['مؤسسه', 'موسسه', 'شركه', 'للتجاره', 'التجاريه', 'تجاريه', 'التجاره',
    'المحدوده', 'محدوده', 'ذ', 'م', 'co', 'company', 'est', 'establishment', 'ltd', 'llc', 'trading']);
  return s.split(/\s+/).filter(w => w && !STOP.has(w)).join(' ').trim();
}

/**
 * هل في النصّ الحرّ بيانات اتصالٍ شخصية؟
 *
 * ملاحظة الترشيح تُكتب بيد المسوّق، و«كلّمت أبو فهد 0551234567» تجمع بيانات
 * شخصٍ ثالث بلا أساسٍ نظاميّ. الرفض على الخادم لا التعليمات وحدها.
 */
export function containsContactInfo(text: unknown): boolean {
  if (typeof text !== 'string' || !text) return false;
  // NFKC: الأرقام و«＠» العريضة تصير عادية قبل أيّ فحص
  const t = latinDigits(text.normalize('NFKC'));
  if (/[^\s@]+@[^\s@]+\.[^\s@]+/.test(t)) return true;              // بريد
  // التواريخ والأوقات ليست أرقام اتصال — تُستبدل بكلمةٍ قبل الفحص
  const cleaned = t
    .replace(/(?:19|20)\d{2}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.](?:19|20)\d{2}/g, ' تاريخ ')
    .replace(/\b\d{1,2}:\d{2}\b/g, ' وقت ');
  // أيّ شيءٍ غير الحروف بين الأرقام فاصل: الفاصلة العربية «،» والفاصل العشري «٫»
  // والنقطتان والمحارف الخفيّة — قائمةٌ مغلقة من الفواصل كانت تُفلت «055،123،4567»
  for (const m of cleaned.matchAll(/\d[^\p{L}]*\d/gu)) {
    if (m[0].replace(/\D/g, '').length >= 8) return true;
  }
  return false;
}

// ───────────────────────────── الآيبان ─────────────────────────────

/**
 * آيبان سعودي صالح: `SA` + ٢٢ رقماً، ويجتاز فحص mod-97.
 * يُعيد الصيغة المُطبَّعة أو `null`.
 */
export function normIbanSA(iban: unknown): string | null {
  if (typeof iban !== 'string') return null;
  const s = latinDigits(iban).replace(/\s+/g, '').toUpperCase();
  if (!/^SA\d{22}$/.test(s)) return null;
  const rearranged = s.slice(4) + s.slice(0, 4);
  const numeric = rearranged.replace(/[A-Z]/g, ch => String(ch.charCodeAt(0) - 55));
  let rem = 0;
  for (const ch of numeric) rem = (rem * 10 + Number(ch)) % 97;
  return rem === 1 ? s : null;
}

// ───────────────────────────── الإشارات ─────────────────────────────

export type AttributionFlag = 'self_email' | 'self_phone' | 'returning_company' | 'ip_match' | 'terms_outdated' | 'link_expired';

/**
 * إشارات الإسناد عند تسجيل شركةٍ برمز.
 *
 * `self_*`: الشركة سجّلت ببريد المسوّق أو جواله — الإحالة الذاتية. و
 * `returning_company`: جوال الشركة يطابق شركةً أقدم لدينا — عميلٌ عائد لا
 * جديد. وأيٌّ منها يجعل الإسناد «متنازعاً عليه» يحسمه المالك، لا يُرفض آلياً:
 * قريبان يعملان في منشأتين حقيقةٌ قائمة، والحكم للبشر.
 */
export function attributionFlags(input: {
  affiliateEmail: string;
  affiliatePhone: string | null;
  adminEmail: string;
  companyPhone: string | null;
  existingCompanyPhones: string[];
}): AttributionFlag[] {
  const flags: AttributionFlag[] = [];
  if (normEmail(input.affiliateEmail) && normEmail(input.affiliateEmail) === normEmail(input.adminEmail)) {
    flags.push('self_email');
  }
  const aff = normPhoneSA(input.affiliatePhone ?? '');
  const comp = normPhoneSA(input.companyPhone ?? '');
  if (aff && comp && aff === comp) flags.push('self_phone');
  if (comp && input.existingCompanyPhones.some(p => normPhoneSA(p) === comp)) flags.push('returning_company');
  return flags;
}

/** الإشارات التي تُوقف الإسناد للمراجعة */
export function isDisputedByFlags(flags: string[]): boolean {
  return flags.some(f => f === 'self_email' || f === 'self_phone' || f === 'returning_company');
}

// ───────────────────────────── الانتقالات ─────────────────────────────

const TRANSITIONS: Record<string, Record<string, string[]>> = {
  user: {
    pending_email: ['pending_review'],
    pending_review: ['approved', 'rejected'],
    approved: ['suspended'],
    suspended: ['approved'],
    rejected: ['pending_review'],
  },
  claim: {
    under_review: ['approved', 'rejected', 'withdrawn'],
    approved: ['converted', 'expired', 'rejected'],
    rejected: [],
    withdrawn: [],
    expired: ['converted'],   // شركةٌ سجّلت داخل القفل وتأخّر ربطها
    converted: [],
  },
  attribution: {
    active: ['disputed', 'void'],
    disputed: ['active', 'void'],
    void: ['active'],
  },
  commission: {
    pending: ['approved', 'on_hold', 'declined', 'reversed'],
    on_hold: ['pending', 'declined', 'reversed'],
    approved: ['paid', 'on_hold', 'reversed'],
    paid: [],
    declined: [],
    reversed: [],
  },
  payout: {
    draft: ['recorded', 'void'],
    recorded: [],
    void: [],
  },
};

export function canTransition(entity: keyof typeof TRANSITIONS | string, from: string, to: string): boolean {
  return (TRANSITIONS[entity]?.[from] ?? []).includes(to);
}

/** العمولة جاهزة للاعتماد؟ مرّت أيّام الحجز والدفعة ما زالت مؤكَّدة */
export function canApproveCommission(
  c: { status: string; eligibleAt: Date },
  linkStatus: string,
  now: Date,
): { ok: true } | { ok: false; reason: 'not_pending' | 'hold_not_over' | 'payment_not_paid' } {
  if (c.status !== 'pending') return { ok: false, reason: 'not_pending' };
  if (linkStatus !== 'paid') return { ok: false, reason: 'payment_not_paid' };
  if (now.getTime() < c.eligibleAt.getTime()) return { ok: false, reason: 'hold_not_over' };
  return { ok: true };
}

// ───────────────────────────── الصرف ─────────────────────────────

/**
 * صافي دفعة مسوّق: عمولاته المعتمدة غير المصروفة + قيوده (السالبة للاسترداد).
 *
 * **لا دفعة سالبة ولا صفريّة أبداً**: إن لم يبلغ الصافي الحدّ الأدنى، أو كان
 * القيد السالب أكبر من العمولات، فلا دفعة — وتبقى القيود تنتظر عمولاتٍ تكفيها.
 * هذه قاعدة PartnerStack نفسها: «لا تُصبح فاتورةٌ سالبة».
 */
export function payoutTotals(
  commissions: { commissionHalalas: number }[],
  adjustments: { amountHalalas: number }[],
  minPayoutHalalas: number,
): { commissionsHalalas: number; adjustmentsHalalas: number; netHalalas: number; eligible: boolean } {
  const c = commissions.reduce((s, x) => s + Math.trunc(x.commissionHalalas), 0);
  const a = adjustments.reduce((s, x) => s + Math.trunc(x.amountHalalas), 0);
  const net = c + a;
  return {
    commissionsHalalas: c,
    adjustmentsHalalas: a,
    netHalalas: net,
    eligible: net > 0 && net >= Math.max(0, Math.trunc(minPayoutHalalas)),
  };
}
