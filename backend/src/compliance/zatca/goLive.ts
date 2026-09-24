// ============================================================================
// ZATCA المرحلة الثانية (Z5.8) — منطق التفعيل النقيّ: علم البيئة، «تسليح» التفعيل، قرار الانتقال (D11)، وجاهزية المناديب
// ----------------------------------------------------------------------------
// z5_plan §5.8 + §5 + نقد الخطة (3، 4): كلّه دوالّ نقيّة لا تلمس قاعدة بيانات ولا شبكة ولا أسراراً.
//   • علم `ZATCA_GO_LIVE`: off (الافتراضي) | on | allowlist:<معرّفات> — وقيمة غير معروفة ⇒ مغلق (فشل مغلق).
//   • «التسليح» (armedAt، نقد 4): قبل التفعيل الفعليّ يُرفض إصدار المرحلة الأولى لمستند أُنشئ على الجهاز عند/بعد لحظة
//     التسليح — شبكةُ أمانٍ خلف رفض العميل. مطفأ تماماً لمن لم يُسلَّح (armedAt == null): بلا أثر على أيّ شركة اليوم.
//   • قرار الانتقال (D11، بعد التفعيل): مستندٌ دون اتصال أُنشئ قبل التفعيل ويُرفع خلال ٧٢ ساعة يُقبل مرحلةً أولى، وإلا
//     يُحال لمراجعة الإدارة — لا رفض صامت أبداً.
//   • جاهزية المناديب: كلّ مندوب نشط ظهر خلال ١٤ يوماً يجب أن يكون قد أبلغ صندوقاً فارغاً بعد لحظة التسليح.
// لا يستورد services/gl.
// ============================================================================

import { checkLiveUnitAllowed, type EnvironmentPolicy } from './onboarding';
import type { SellerSettingsRecord } from './onboardingStore';
import { sellerNotReady, type UnitForIssuance } from './regime';

// ─────────────────────────────────────────────────────────────────────────────
// ثوابت
// ─────────────────────────────────────────────────────────────────────────────

export const GO_LIVE_ENV_VAR = 'ZATCA_GO_LIVE';
/** مهلة قبول مستند انتقاليّ على مسار المرحلة الأولى بعد التفعيل (D11): ٧٢ ساعة من لحظة التفعيل. */
export const CUTOVER_WINDOW_MS = 72 * 60 * 60 * 1000;
/** أقصى تأريخ سابق مقبول لمستند انتقاليّ (خطة §5.8): سبعة أيام قبل التفعيل. */
export const CUTOVER_BACKDATE_LIMIT_MS = 7 * 24 * 60 * 60 * 1000;
/** نافذة «مندوب نشط»: من ظهر خلالها وحده يُحسب في جاهزية المزامنة (خطة §5.8). */
export const REP_SYNC_ACTIVE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export const ARM_REFUSAL_CODE = 'ZATCA_GO_LIVE_ARMING';
export const ARM_REFUSAL_MESSAGE_AR =
  'يجري تفعيل الفوترة الإلكترونية (المرحلة الثانية) في شركتك — لا يمكن إصدار فاتورة جديدة من هذا الجهاز الآن؛ زامن المستندات المعلّقة وحدّث الصفحة';

export const CUTOVER_REVIEW_STATUSES = Object.freeze(['PENDING', 'ACCEPTED_PHASE1', 'ACCEPTED_PHASE2', 'REJECTED'] as const);
export type CutoverStatus = (typeof CUTOVER_REVIEW_STATUSES)[number];
export function isCutoverStatus(v: unknown): v is CutoverStatus {
  return typeof v === 'string' && (CUTOVER_REVIEW_STATUSES as readonly string[]).includes(v);
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// ─────────────────────────────────────────────────────────────────────────────
// علم البيئة ZATCA_GO_LIVE
// ─────────────────────────────────────────────────────────────────────────────

export type GoLiveEnvMode = 'off' | 'on' | 'allowlist';
export interface GoLiveEnvGate {
  mode: GoLiveEnvMode;
  tenants: ReadonlySet<string>;
}

/** off (الافتراضي/غير معروف) | on | allowlist:<معرّفات مفصولة بفواصل>. الفراغ والقيمة المجهولة ⇒ مغلق. */
export function parseGoLiveEnv(env: Readonly<Record<string, string | undefined>>): GoLiveEnvGate {
  const raw = (typeof env[GO_LIVE_ENV_VAR] === 'string' ? (env[GO_LIVE_ENV_VAR] as string) : '').trim();
  const low = raw.toLowerCase();
  if (raw === '' || low === 'off') return { mode: 'off', tenants: new Set() };
  if (low === 'on') return { mode: 'on', tenants: new Set() };
  const m = /^allowlist:(.*)$/i.exec(raw);
  if (m) {
    const tenants = new Set<string>();
    for (const t of m[1].split(',')) {
      const id = t.trim();
      if (ID_RE.test(id)) tenants.add(id);
    }
    return { mode: 'allowlist', tenants };
  }
  return { mode: 'off', tenants: new Set() };
}

export function goLiveEnvAllows(env: Readonly<Record<string, string | undefined>>, tenantId: string): boolean {
  const g = parseGoLiveEnv(env);
  if (g.mode === 'on') return true;
  if (g.mode === 'allowlist') return g.tenants.has(tenantId);
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// رفض إصدار المرحلة الأولى بعد التسليح (نقد 4)
// ─────────────────────────────────────────────────────────────────────────────

export interface ArmRefusal {
  status: number;
  body: { success: false; code: string; message: string };
}

/**
 * هل تُرفض هذه الفاتورة (مرحلة أولى) لأنّ التفعيل مُسلَّح والمستند أُنشئ على الجهاز عند/بعد لحظة التسليح؟
 * null = لا رفض. مطفأ تماماً حين armedAt == null، وبعد التفعيل الفعليّ (startedAt != null) يحكمه فرع المرحلة الثانية
 * (قرار الانتقال) لا هذا — فلا يُرفض هنا مستندٌ قُبل انتقالياً.
 */
export function phase1ArmRefusal(input: { armedAt: Date | null; startedAt: Date | null; clientCreatedAt: Date | null }): ArmRefusal | null {
  if (input.startedAt != null) return null;
  if (!(input.armedAt instanceof Date)) return null;
  const c = input.clientCreatedAt;
  if (!(c instanceof Date) || Number.isNaN(c.getTime())) return null; // طلب حيّ بلا لحظة جهاز: خارج قاعدة التسليح
  if (c.getTime() < input.armedAt.getTime()) return null; // أُنشئ قبل التسليح ⇒ يمرّ كما اليوم
  return { status: 409, body: { success: false, code: ARM_REFUSAL_CODE, message: ARM_REFUSAL_MESSAGE_AR } };
}

// ─────────────────────────────────────────────────────────────────────────────
// قرار الانتقال (D11)
// ─────────────────────────────────────────────────────────────────────────────

export type CutoverReason = 'CREATED_AFTER_GOLIVE' | 'WINDOW_EXPIRED' | 'TOO_OLD' | 'NO_CLIENT_TIME';
export type CutoverDecision = { kind: 'ACCEPT_PHASE1' } | { kind: 'REVIEW'; reason: CutoverReason };

/**
 * بعد التفعيل: مستندٌ أُعيد رفعه (X-FS-Replay) بلحظة جهازٍ قبل التفعيل وضمن مهلة ٧٢ ساعة ⇒ يُقبل مرحلةً أولى.
 * غير ذلك (بلا لحظة، أو أُنشئ بعد التفعيل، أو فات الوقت، أو أقدم من الحدّ) ⇒ مراجعة الإدارة (لا رفض صامت).
 */
export function cutoverDecision(input: {
  startedAt: Date; clientCreatedAt: Date | null; now: Date; windowMs?: number; backdateLimitMs?: number;
}): CutoverDecision {
  const windowMs = input.windowMs ?? CUTOVER_WINDOW_MS;
  const backdateLimitMs = input.backdateLimitMs ?? CUTOVER_BACKDATE_LIMIT_MS;
  const c = input.clientCreatedAt;
  if (!(c instanceof Date) || Number.isNaN(c.getTime())) return { kind: 'REVIEW', reason: 'NO_CLIENT_TIME' };
  const started = input.startedAt.getTime();
  if (c.getTime() >= started) return { kind: 'REVIEW', reason: 'CREATED_AFTER_GOLIVE' };
  if (input.now.getTime() > started + windowMs) return { kind: 'REVIEW', reason: 'WINDOW_EXPIRED' };
  if (c.getTime() < started - backdateLimitMs) return { kind: 'REVIEW', reason: 'TOO_OLD' };
  return { kind: 'ACCEPT_PHASE1' };
}

/** حمولة تُحفظ في طابور المراجعة (تُمرَّر من فرع الإصدار إلى المخزن). */
export interface CutoverRecordInput {
  tenantId: string;
  clientRef: string | null;
  clientCreatedAt: Date | null;
  reason: CutoverReason;
  payload: unknown;
  salesRepId?: string | null;
  customerId?: string | null;
  amount?: number | null;
  at: Date;
}

// ─────────────────────────────────────────────────────────────────────────────
// جاهزية مزامنة المناديب
// ─────────────────────────────────────────────────────────────────────────────

export interface RepSyncRow {
  id: string;
  name: string;
  isActive: boolean;
  lastSeenAt: Date | null;
  outboxPending: number | null;
  outboxTaxPending: number | null;
  outboxReportedAt: Date | null;
}

export type RepUnsyncedReason = 'NO_REPORT' | 'STALE_REPORT' | 'OUTBOX_PENDING';

export interface RepSyncReadiness {
  ready: boolean;
  total: number;
  synced: number;
  unsynced: Array<{ id: string; name: string; reason: RepUnsyncedReason }>;
}

/**
 * جاهز = مُسلَّح، وكلّ مندوب نشطٍ ظهر خلال ١٤ يوماً أبلغ صندوقاً فارغاً (outboxPending = outboxTaxPending = 0) بعد لحظة
 * التسليح. من لم يُبلّغ ⇒ NO_REPORT، من أبلغ قبل التسليح ⇒ STALE_REPORT، ومن أبلغ صندوقاً غير فارغ ⇒ OUTBOX_PENDING.
 */
export function repSyncReadiness(
  reps: readonly RepSyncRow[], armedAt: Date | null, now: Date, opts: { activeWindowMs?: number } = {},
): RepSyncReadiness {
  const activeWindowMs = opts.activeWindowMs ?? REP_SYNC_ACTIVE_WINDOW_MS;
  const relevant = reps.filter(r =>
    r.isActive && r.lastSeenAt instanceof Date && now.getTime() - r.lastSeenAt.getTime() <= activeWindowMs);
  const unsynced: RepSyncReadiness['unsynced'] = [];
  for (const r of relevant) {
    if (!(r.outboxReportedAt instanceof Date)) { unsynced.push({ id: r.id, name: r.name, reason: 'NO_REPORT' }); continue; }
    if (armedAt == null || r.outboxReportedAt.getTime() < armedAt.getTime()) { unsynced.push({ id: r.id, name: r.name, reason: 'STALE_REPORT' }); continue; }
    if ((r.outboxPending ?? 0) > 0 || (r.outboxTaxPending ?? 0) > 0) { unsynced.push({ id: r.id, name: r.name, reason: 'OUTBOX_PENDING' }); continue; }
  }
  return { ready: armedAt != null && unsynced.length === 0, total: relevant.length, synced: relevant.length - unsynced.length, unsynced };
}

// ─────────────────────────────────────────────────────────────────────────────
// بوابة التفعيل الكاملة (للاستطلاع من الواجهة و goLiveAvailable)
// ─────────────────────────────────────────────────────────────────────────────

export interface GoLiveGateInput {
  settings: SellerSettingsRecord;
  /** وحدات production حالة ACTIVE (مُصفّاة مسبقاً من المستدعي). */
  units: readonly UnitForIssuance[];
  armedAt: Date | null;
  reps: readonly RepSyncRow[];
  policy: EnvironmentPolicy;
  envAllows: boolean;
  /** هل مخزن التفعيل مهيّأ أصلاً (الإنتاج: دائماً؛ غيابه ⇒ التفعيل غير متاح كما اليوم). */
  storeReady: boolean;
  now: Date;
}

export interface GoLiveGate {
  available: boolean;
  envAllows: boolean;
  armed: boolean;
  armedAt: string | null;
  checks: { unitActive: boolean; sellerReady: boolean; currencySar: boolean; repsSynced: boolean };
  reps: RepSyncReadiness;
}

export function currencyIsSar(s: Pick<SellerSettingsRecord, 'currency' | 'currencyOverride'>): boolean {
  return s.currency === 'SAR' && (s.currencyOverride == null || s.currencyOverride === 'SAR');
}

/** وحدة إنتاج واحدة مفعّلة، شهادتها سارية، ورقمها الضريبي = رقم البائع (كفحص goLive نفسه). */
export function unitActiveForGoLive(
  units: readonly UnitForIssuance[], settings: Pick<SellerSettingsRecord, 'taxNumber'>, policy: EnvironmentPolicy, now: Date,
): boolean {
  if (units.length !== 1) return false;
  const u = units[0];
  if (!checkLiveUnitAllowed(u, policy).ok) return false;
  if (!(u.certNotAfter instanceof Date) || u.certNotAfter.getTime() <= now.getTime()) return false;
  return (settings.taxNumber ?? null) === u.vatNumber;
}

export function computeGoLiveGate(input: GoLiveGateInput): GoLiveGate {
  const reps = repSyncReadiness(input.reps, input.armedAt, input.now);
  const checks = {
    unitActive: unitActiveForGoLive(input.units, input.settings, input.policy, input.now),
    sellerReady: !sellerNotReady(input.settings),
    currencySar: currencyIsSar(input.settings),
    repsSynced: reps.ready,
  };
  const armed = input.armedAt != null;
  const available = input.storeReady && input.envAllows && armed
    && checks.unitActive && checks.sellerReady && checks.currencySar && checks.repsSynced;
  return {
    available, envAllows: input.envAllows, armed, armedAt: input.armedAt ? input.armedAt.toISOString() : null, checks, reps,
  };
}

/** رسالة عربية موجزة تسمّي الفحوص غير المكتملة (للردّ حين يُطلب التفعيل قبل الجاهزية). */
export function goLiveNotReadyMessage(gate: GoLiveGate): string {
  const missing: string[] = [];
  if (!gate.envAllows) missing.push('لم تُفعَّل بيئة الإطلاق للمنصّة بعد');
  if (!gate.armed) missing.push('لم يُسلَّح التفعيل (اضغط «تسليح» أولاً)');
  if (!gate.checks.unitActive) missing.push('لا توجد وحدة فوترة إنتاجيّة مفعّلة وسارية');
  if (!gate.checks.sellerReady) missing.push('بيانات المنشأة (البائع) غير مكتملة');
  if (!gate.checks.currencySar) missing.push('العملة يجب أن تكون الريال السعودي');
  if (!gate.checks.repsSynced) {
    const names = gate.reps.unsynced.map(u => u.name).slice(0, 6).join('، ');
    missing.push(names ? `مناديب لم يزامنوا أجهزتهم بعد: ${names}` : 'لم يزامن كل المناديب أجهزتهم بعد');
  }
  return missing.length ? `تعذّر التفعيل — ${missing.join('؛ ')}` : 'التفعيل جاهز';
}
