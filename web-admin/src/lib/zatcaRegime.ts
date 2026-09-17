/**
 * فوترة ZATCA المرحلة الثانية (Z5.0 / Z5.6a) — محدِّدات الواجهة من ردّ GET /company (بلا React ولا استيراد).
 *
 * مستويان للتحكّم (z5_plan §0.1 + نقد الخطة 5):
 *  • zatcaCollectOn: جمع بيانات المشتري (D2) وقائمة الناقصين — (علم المالك || التفعيل الحيّ) لشركة سعودية.
 *    العلم وحده كان سيُخفي الحقول ويُسقط حوار «أكمل البيانات» إن أُطفئ بعد التفعيل.
 *  • zatcaRegimeOf: طريقة الإصدار — من حقل الخادم company.zatcaRegime (يضيفه Z5.2 للمعلَّمين أو المفعّلين). الخادم هو المرجع؛
 *    وإن غاب الحقل وكانت الشركة مفعّلة (zatcaPhase2StartedAt) فالقرار «مرحلة ثانية» (فشل آمن: لا إصدار ضريبي دون اتصال).
 * غير المعلَّمين وغير المفعّلين: دائماً مرحلة أولى ولا جمع — لا يتغيّر شيء عمّا اليوم.
 */

export type ZatcaRegimeMode = 'live' | 'rehearsal';

export type ZatcaRegimeView =
  | { phase: 1 }
  | { phase: 2; mode: ZatcaRegimeMode; blocked: string | null };

export interface ZatcaCompanyLike {
  countryCode?: string | null;
  zatcaPhase2Enabled?: boolean | null;
  zatcaPhase2StartedAt?: string | Date | null;
  zatcaRegime?: unknown;
}

const BLOCKED_RE = /^[A-Z_]{1,40}$/;

/** مفعّلة حيّاً: zatcaPhase2StartedAt محفوظ (يضبطه التفعيل وحده في الخادم). */
export function isZatcaPhase2Live(company: ZatcaCompanyLike | null | undefined): boolean {
  const v = company?.zatcaPhase2StartedAt;
  return v instanceof Date || (typeof v === 'string' && v !== '');
}

/** جمع بيانات المشتري وإظهار أقسامها: (العلم === true || مفعّلة) && SA. */
export function zatcaCollectOn(company: ZatcaCompanyLike | null | undefined): boolean {
  return (company?.zatcaPhase2Enabled === true || isZatcaPhase2Live(company)) && company?.countryCode === 'SA';
}

function parseServerRegime(raw: unknown): ZatcaRegimeView | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as { phase?: unknown; mode?: unknown; blocked?: unknown };
  if (r.phase === 1) return { phase: 1 };
  if (r.phase !== 2 || (r.mode !== 'live' && r.mode !== 'rehearsal')) return null;
  const blocked = typeof r.blocked === 'string' && BLOCKED_RE.test(r.blocked) ? r.blocked : null;
  if (r.blocked !== null && r.blocked !== undefined && blocked === null) return null;
  return { phase: 2, mode: r.mode, blocked };
}

/** نظام الإصدار كما يعلنه الخادم؛ غيابه ⇒ مرحلة ثانية للمفعّلة (فشل آمن) وإلا مرحلة أولى. */
export function zatcaRegimeOf(company: ZatcaCompanyLike | null | undefined): ZatcaRegimeView {
  const server = parseServerRegime(company?.zatcaRegime);
  if (server) return server;
  if (isZatcaPhase2Live(company)) return { phase: 2, mode: 'live', blocked: null };
  return { phase: 1 };
}
