// ============================================================================
// ZATCA المرحلة الثانية (Z5.0) — آلة حالات المستند ومرآة الفاتورة (نقيّة: لا قاعدة بيانات ولا شبكة ولا ساعة)
// ----------------------------------------------------------------------------
// z5_plan §2.3 + نقد الخطة (10، 18، 34):
//   • أسماء الحالات الجارية هي IN_FLIGHT_DOCUMENT_STATUSES من onboarding.ts حرفياً (التجديد ينتظرها).
//   • كل كتابة نتيجة مسيَّجة برمز المطالبة: attempts (يزيده claim) مع status='SUBMITTING' — لا مساواة الطابع الزمني leaseUntil.
//   • «إيقاف الاعتماد» (303) على قياسية: flow=REPORTING والبايتات نفسها، ويُضبط reportDeadline فتسري مهلة ٢٤ ساعة؛ والقياسية
//     المُبلَّغ عنها reported/reported_warn قابلة للطباعة بختمنا (لا تبقى معلّقة إلى الأبد).
//   • 401 يُعلَّم المستند AUTH_BLOCKED؛ نقل الوحدة إلى AUTH_FAILED (Z5.3) لا يكون إلا بتأكيد: 401 ثانٍ على مستند آخر بعد
//     60 ثانية على الأقل (authFailureConfirmed).
// ============================================================================

import { IN_FLIGHT_DOCUMENT_STATUSES } from './onboarding';
import type { Msg, Outcome } from './responses';

export { IN_FLIGHT_DOCUMENT_STATUSES };

export const DOCUMENT_STATUSES = Object.freeze([
  'SIGNED', 'SUBMITTING', 'RETRY_WAIT', 'REPORTED', 'REPORTED_WARN', 'CLEARED', 'CLEARED_WARN', 'CLEARED_NO_XML', 'REJECTED',
  'AUTH_BLOCKED', 'CONFIG_ERROR',
] as const);
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

/** نهائية لهذه المحاولة: لا مطالبة بعدها. (AUTH_BLOCKED وCONFIG_ERROR ليستا نهائيتين: إعادة يدوية.) */
export const FINAL_DOCUMENT_STATUSES: readonly DocumentStatus[] = Object.freeze([
  'REPORTED', 'REPORTED_WARN', 'CLEARED', 'CLEARED_WARN', 'CLEARED_NO_XML', 'REJECTED',
] as DocumentStatus[]);
/** تُطالَب حين يحين موعدها (والمطالبة تستولي أيضاً على SUBMITTING منتهي العقد). */
export const CLAIMABLE_STATUSES: readonly DocumentStatus[] = Object.freeze(['SIGNED', 'RETRY_WAIT'] as DocumentStatus[]);
/** الإعادة اليدوية (مدير الشركة): إلى RETRY_WAIT الآن بالبايتات نفسها. */
export const MANUAL_RETRY_FROM: readonly DocumentStatus[] = Object.freeze(['RETRY_WAIT', 'AUTH_BLOCKED', 'CONFIG_ERROR'] as DocumentStatus[]);

export type Subtype = '01' | '02';
export type Flow = 'REPORTING' | 'CLEARANCE';

export function isDocumentStatus(v: unknown): v is DocumentStatus {
  return typeof v === 'string' && (DOCUMENT_STATUSES as readonly string[]).includes(v);
}

/** 01 (قياسية) ⇒ CLEARANCE؛ 02 (مبسّطة) ⇒ REPORTING. */
export function flowForSubtype(subtype: Subtype): Flow {
  return subtype === '01' ? 'CLEARANCE' : 'REPORTING';
}

/** النوع من typeName بسبع خانات (0100000 / 0200000)؛ غير ذلك null. */
export function subtypeOfTypeName(typeName: string | null | undefined): Subtype | null {
  if (typeof typeName !== 'string' || !/^0[12][0-9]{5}$/.test(typeName)) return null;
  return typeName.slice(0, 2) as Subtype;
}

export const REPORT_WINDOW_MS = 24 * 60 * 60 * 1000;

/** مهلة الإبلاغ للمبسّطة: issuedAt + 24 ساعة؛ القياسية بلا مهلة (حتى يوقف الاعتماد). */
export function reportDeadlineFor(flow: Flow, issuedAt: Date): Date | null {
  return flow === 'REPORTING' ? new Date(issuedAt.getTime() + REPORT_WINDOW_MS) : null;
}

// ─── الجدولة ───

/** بعد المحاولة رقم n (1..): 30ث، 2د، 5د، 10د، 15د، ثم كل 30د. الأولى فورية (nextAttemptAt null). */
export const BACKOFF_AFTER_ATTEMPT_MS: readonly number[] = Object.freeze([0, 30_000, 120_000, 300_000, 600_000, 900_000]);
export const BACKOFF_STEADY_MS = 30 * 60 * 1000;
/** سقف Retry-After من الهيئة: لا يؤخَّر مستند مبسّط ساعات فيفوته اليوم. */
export const RETRY_AFTER_CAP_MS = 60 * 60 * 1000;

export function retryDelayMs(attempts: number, retryAfterSeconds?: number): number {
  const n = Number.isInteger(attempts) && attempts > 0 ? attempts : 1;
  const base = n < BACKOFF_AFTER_ATTEMPT_MS.length ? BACKOFF_AFTER_ATTEMPT_MS[n] : BACKOFF_STEADY_MS;
  const ra = typeof retryAfterSeconds === 'number' && Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
    ? Math.min(retryAfterSeconds * 1000, RETRY_AFTER_CAP_MS) : 0;
  return Math.max(base, ra);
}

// ─── المطالبة ───

export interface ClaimableView {
  status: string;
  nextAttemptAt: Date | null;
  leaseUntil: Date | null;
}

/**
 * قابل للمطالبة الآن؟ SIGNED/RETRY_WAIT بلا عقد حيّ وقد حان موعده (أو ignoreSchedule لمحاولة فورية واحدة)، أو SUBMITTING
 * انتهى عقده (عامل مات؛ إعادة البايتات نفسها آمنة لأن التكرار نجاح).
 */
export function isClaimable(doc: ClaimableView, now: Date, opts: { ignoreSchedule?: boolean } = {}): boolean {
  const t = now.getTime();
  const leaseFree = doc.leaseUntil === null || doc.leaseUntil.getTime() < t;
  if ((CLAIMABLE_STATUSES as readonly string[]).includes(doc.status)) {
    return leaseFree && (opts.ignoreSchedule === true || doc.nextAttemptAt === null || doc.nextAttemptAt.getTime() <= t);
  }
  return doc.status === 'SUBMITTING' && doc.leaseUntil !== null && doc.leaseUntil.getTime() < t;
}

// ─── نتيجة الإرسال ⇒ حالة ───

export interface OutcomeContext {
  flow: Flow;
  /** attempts بعد المطالبة (رقم هذه المحاولة). */
  attempts: number;
  priorEmpty400: number;
  priorPayload413: number;
  issuedAt: Date;
  reportDeadline: Date | null;
  now: Date;
}

export type OutcomeAlert = 'CLEARED_NO_XML' | 'REJECTED' | 'AUTH' | 'CONFIG';

export interface OutcomeWrite {
  status: DocumentStatus;
  /** يُكتب حين يتغيّر (إيقاف الاعتماد) وحده. */
  flow?: Flow;
  nextAttemptAt: Date | null;
  leaseUntil: null;
  finalizedAt?: Date;
  /** يُكتب حين يتحوّل المستند إلى الإبلاغ. */
  reportDeadline?: Date;
  priorEmpty400?: number;
  priorPayload413?: number;
  /** الفاتورة المعتمدة base64 كما أعادتها الهيئة (المستدعي يخزّنها gzip ويستخرج رمزها). */
  clearedXmlB64?: string;
  warnings: Msg[];
  errors: Msg[];
  alert: OutcomeAlert | null;
  /** 401: المستدعي يقرّر نقل الوحدة (authFailureConfirmed) في معاملة مستقلة. */
  authFailure: boolean;
}

function base(status: DocumentStatus): OutcomeWrite {
  return { status, nextAttemptAt: null, leaseUntil: null, warnings: [], errors: [], alert: null, authFailure: false };
}

export function transitionForOutcome(outcome: Outcome, ctx: OutcomeContext): OutcomeWrite {
  switch (outcome.kind) {
    case 'ACCEPTED': {
      const warn = outcome.warnings.length > 0;
      if (ctx.flow === 'CLEARANCE') {
        if (!outcome.clearedXmlB64) return { ...base('CLEARED_NO_XML'), finalizedAt: ctx.now, warnings: outcome.warnings, alert: 'CLEARED_NO_XML' };
        return { ...base(warn ? 'CLEARED_WARN' : 'CLEARED'), finalizedAt: ctx.now, warnings: outcome.warnings, clearedXmlB64: outcome.clearedXmlB64 };
      }
      return { ...base(warn ? 'REPORTED_WARN' : 'REPORTED'), finalizedAt: ctx.now, warnings: outcome.warnings };
    }
    case 'DUPLICATE': {
      if (ctx.flow === 'CLEARANCE') {
        if (!outcome.clearedXmlB64) return { ...base('CLEARED_NO_XML'), finalizedAt: ctx.now, alert: 'CLEARED_NO_XML' };
        return { ...base('CLEARED'), finalizedAt: ctx.now, clearedXmlB64: outcome.clearedXmlB64 };
      }
      return { ...base('REPORTED'), finalizedAt: ctx.now };
    }
    case 'CLEARANCE_OFF': {
      // 303 لا يرد إلا على clearance (responses.ts)؛ غير ذلك خطأ إعداد
      if (ctx.flow !== 'CLEARANCE') return { ...base('CONFIG_ERROR'), alert: 'CONFIG' };
      return {
        ...base('SIGNED'), flow: 'REPORTING',
        reportDeadline: ctx.reportDeadline ?? new Date(ctx.issuedAt.getTime() + REPORT_WINDOW_MS),
      };
    }
    case 'REJECTED':
      return { ...base('REJECTED'), finalizedAt: ctx.now, errors: outcome.errors, warnings: outcome.warnings, alert: 'REJECTED' };
    case 'RETRY': {
      const w: OutcomeWrite = { ...base('RETRY_WAIT'), nextAttemptAt: new Date(ctx.now.getTime() + retryDelayMs(ctx.attempts, outcome.retryAfterSeconds)) };
      if (outcome.reason === 'empty400') w.priorEmpty400 = ctx.priorEmpty400 + 1;
      if (outcome.reason === 'payload') w.priorPayload413 = ctx.priorPayload413 + 1;
      return w;
    }
    case 'AUTH':
      return { ...base('AUTH_BLOCKED'), alert: 'AUTH', authFailure: true };
    case 'CONFIG':
      return { ...base('CONFIG_ERROR'), alert: 'CONFIG' };
  }
}

/** الإعادة اليدوية: null إن لم تُسمح من هذه الحالة. */
export function manualRetryWrite(status: string, now: Date): { status: 'RETRY_WAIT'; nextAttemptAt: Date; leaseUntil: null } | null {
  if (!(MANUAL_RETRY_FROM as readonly string[]).includes(status)) return null;
  return { status: 'RETRY_WAIT', nextAttemptAt: new Date(now.getTime()), leaseUntil: null };
}

export const AUTH_CONFIRM_MIN_GAP_MS = 60_000;

/** 401 مؤكَّد (يُعلِّم الوحدة AUTH_FAILED): سابق على مستند آخر منذ 60 ثانية على الأقل. */
export function authFailureConfirmed(
  previous: { documentId: string; at: Date } | null | undefined, current: { documentId: string; at: Date },
): boolean {
  if (!previous) return false;
  return previous.documentId !== current.documentId && current.at.getTime() - previous.at.getTime() >= AUTH_CONFIRM_MIN_GAP_MS;
}

// ─── مرآة الفاتورة ───

export const INVOICE_MIRROR_STATUSES = Object.freeze([
  'signed', 'clearance_pending', 'report_blocked', 'clearance_blocked', 'reported', 'reported_warn', 'cleared', 'cleared_warn',
  'cleared_no_xml', 'rejected',
] as const);
export type InvoiceMirrorStatus = (typeof INVOICE_MIRROR_STATUSES)[number];

/** مرايا تمنع التخصيص (سند قبض، رابط دفع) حتى الاعتماد — Z5.4 يستعملها بشرط NULL الآمن. */
export const ALLOCATION_BLOCKED_MIRRORS: readonly InvoiceMirrorStatus[] = Object.freeze(['clearance_pending', 'clearance_blocked', 'rejected'] as InvoiceMirrorStatus[]);

/**
 * Invoice.einvoiceStatus من حالة المستند ونوعه. null لتركيبة مستحيلة (مبسّطة معتمدة) — خطأ داخلي عند المستدعي.
 * القياسية بعد إيقاف الاعتماد تُبلَّغ: reported/reported_warn (نقد الخطة 10).
 */
export function mirrorStatusOf(docStatus: DocumentStatus, subtype: Subtype): InvoiceMirrorStatus | null {
  const b2b = subtype === '01';
  switch (docStatus) {
    case 'SIGNED': case 'SUBMITTING': case 'RETRY_WAIT': return b2b ? 'clearance_pending' : 'signed';
    case 'AUTH_BLOCKED': case 'CONFIG_ERROR': return b2b ? 'clearance_blocked' : 'report_blocked';
    case 'REPORTED': return 'reported';
    case 'REPORTED_WARN': return 'reported_warn';
    case 'CLEARED': return b2b ? 'cleared' : null;
    case 'CLEARED_WARN': return b2b ? 'cleared_warn' : null;
    case 'CLEARED_NO_XML': return b2b ? 'cleared_no_xml' : null;
    case 'REJECTED': return 'rejected';
  }
}

/**
 * Invoice.einvoiceQr: المبسّطة ختمنا دائماً؛ القياسية clearedQr وحده بعد الاعتماد، أو ختمنا بعد إيقاف الاعتماد والإبلاغ —
 * فلا يُكشف رمز قياسية لم تُعتمد أبداً.
 */
export function mirrorQrOf(input: { subtype: Subtype; status: DocumentStatus; qr: string; clearedQr: string | null }): string | null {
  if (input.subtype === '02') return input.qr;
  if (input.status === 'CLEARED' || input.status === 'CLEARED_WARN') return input.clearedQr ?? null;
  if (input.status === 'REPORTED' || input.status === 'REPORTED_WARN') return input.qr;
  return null;
}

/** قابلة للطباعة/المشاركة: المبسّطة بأي حالة عدا المرفوضة؛ القياسية بعد الاعتماد أو بعد الإبلاغ (إيقاف الاعتماد). */
export function isPrintableMirror(mirror: string | null | undefined, subtype: Subtype): boolean {
  if (typeof mirror !== 'string') return false;
  if (subtype === '02') return (INVOICE_MIRROR_STATUSES as readonly string[]).includes(mirror) && mirror !== 'rejected' && !mirror.startsWith('clear');
  return mirror === 'cleared' || mirror === 'cleared_warn' || mirror === 'reported' || mirror === 'reported_warn';
}

/** متأخرة (محسوبة لا مخزَّنة): لها مهلة إبلاغ، غير نهائية، وتجاوزت المهلة. */
export function isOverdue(doc: { status: string; reportDeadline: Date | null }, now: Date): boolean {
  if (!doc.reportDeadline) return false;
  if ((FINAL_DOCUMENT_STATUSES as readonly string[]).includes(doc.status)) return false;
  return now.getTime() > doc.reportDeadline.getTime();
}
