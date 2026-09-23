// ============================================================================
// ZATCA المرحلة الثانية (Z5.4) — قرار «الاعتماد قبل المشاركة»: من حالة المستند بعد المحاولة الحيّة إلى ردّ المسار
// ----------------------------------------------------------------------------
// z5_plan §3 «Z5.4» + design Z5.7 + نقد الخطة (5، 10، 13):
//   • القرار يُؤخذ من **حالة المستند بعد المحاولة** لا من قيمة أعادها الاستدعاء: انقضاء مهلتنا، أو سبْقُ عاملٍ آخر إلى
//     المستند، أو انهيار في المنتصف — كلّها تُقرأ من الحالة المخزَّنة، وهي وحدها الحقيقة.
//   • CLEARED/CLEARED_WARN ⇒ 201 بفاتورة معتمدة قابلة للطباعة (رمزها رمز الهيئة).
//   • REPORTED/REPORTED_WARN على قياسية ⇒ 201 أيضاً: أوقفت الهيئة الاعتماد (303) فصارت الفاتورة مُبلَّغة بختمنا وقابلة
//     للطباعة، ولها مهلة 24 ساعة (نقد 10) — لولا ذلك بقيت معلّقة إلى الأبد.
//   • REJECTED ⇒ 422 وقد أُبطلت الفاتورة في معاملة النتيجة نفسها (نقد 7).
//   • CLEARED_NO_XML ⇒ 202 برمز خاصّ: اعتُمدت عند الهيئة ولا نسخة معتمدة لدينا فلا تُطبع (U8).
//   • WITHDRAWN ⇒ 409: سُحبت قبل أن تصل الهيئة وأُلغيت الفاتورة — لا تُقال «بانتظار الحسم» عن مستند لن يُرسل أبداً.
//   • أيّ شيء آخر (موقَّعة، قيد الإرسال، بانتظار إعادة، محجوبة) ⇒ 202 «بانتظار الاعتماد» (قرار المالك D5): تُسلَّم مذكّرة
//     تسليم لا فاتورة ضريبية، والمسح الدوري يُكمل ثم تصل الفاتورة المعتمدة إلكترونياً.
// نقيّ: لا شبكة ولا قاعدة بيانات ولا services/gl.
// ============================================================================

import { ZATCA_ERROR_CATALOGUE, ZatcaHttpError, rejectedError } from './errors';
import { isPrintableMirror, mirrorStatusOf, type DocumentStatus, type InvoiceMirrorStatus, type Subtype } from './status';

/** المهلة القصوى التي ينتظرها الطلب الحيّ اعتمادَ الهيئة (بعدها 202 والمسح يُكمل). */
export const INLINE_CLEARANCE_TIMEOUT_MS = 20_000;
/** مهلة الاستدعاء نفسه داخل تلك النافذة (أقصر كي يبقى متّسع لكتابة النتيجة). */
export const INLINE_CLEARANCE_CALL_TIMEOUT_MS = 17_000;

export type ClearanceKind = 'cleared' | 'cleared_no_xml' | 'rejected' | 'withdrawn' | 'pending';

export type ClearancePendingReason = 'IN_FLIGHT' | 'RETRY' | 'BLOCKED' | 'UNKNOWN';

export const CLEARANCE_PENDING_REASONS: Readonly<Record<ClearancePendingReason, string>> = Object.freeze({
  IN_FLIGHT: 'الفاتورة في طريقها إلى الهيئة',
  RETRY: 'تعذّر الوصول إلى الهيئة الآن وتُعاد المحاولة تلقائياً',
  BLOCKED: 'توقّف الإرسال إلى الهيئة — راجع إعدادات الفوترة الإلكترونية',
  UNKNOWN: 'بانتظار حسم الهيئة',
});

export interface ClearanceOutcome {
  kind: ClearanceKind;
  /** حالة المستند التي بُني عليها القرار (null = تعذّرت قراءتها ⇒ معلّقة). */
  documentStatus: string | null;
  mirror: InvoiceMirrorStatus | null;
  printable: boolean;
  pendingReason: ClearancePendingReason | null;
}

const PENDING_REASON_OF: Readonly<Record<string, ClearancePendingReason>> = Object.freeze({
  SIGNED: 'IN_FLIGHT', SUBMITTING: 'IN_FLIGHT', RETRY_WAIT: 'RETRY', AUTH_BLOCKED: 'BLOCKED', CONFIG_ERROR: 'BLOCKED',
});

/** نقيّ: حالة المستند + نوعه الفرعي ⇒ ماذا يقول المسار للعميل. */
export function clearanceOutcome(documentStatus: string | null | undefined, subtype: Subtype): ClearanceOutcome {
  const status = typeof documentStatus === 'string' && documentStatus !== '' ? documentStatus : null;
  const mirror = status ? mirrorStatusOf(status as DocumentStatus, subtype) : null;
  const printable = isPrintableMirror(mirror, subtype);
  if (status === 'CLEARED' || status === 'CLEARED_WARN' || status === 'REPORTED' || status === 'REPORTED_WARN') {
    return { kind: 'cleared', documentStatus: status, mirror, printable, pendingReason: null };
  }
  if (status === 'CLEARED_NO_XML') return { kind: 'cleared_no_xml', documentStatus: status, mirror, printable, pendingReason: null };
  if (status === 'REJECTED') return { kind: 'rejected', documentStatus: status, mirror, printable, pendingReason: null };
  // Z5.4 (مراجعة عدائية ٢): مستندٌ سُحب لا يصل الهيئة أبداً والفاتورة تحته مُلغاة — لا يُردّ عنه «بانتظار الحسم»
  if (status === 'WITHDRAWN') return { kind: 'withdrawn', documentStatus: status, mirror, printable, pendingReason: null };
  return {
    kind: 'pending', documentStatus: status, mirror, printable,
    pendingReason: (status && PENDING_REASON_OF[status]) || 'UNKNOWN',
  };
}

// ─── رسائل الهيئة المخزَّنة (validation المنقّحة) ───

export interface StoredMessage {
  code: string | null;
  message: string | null;
}

const MAX_SHOWN_MESSAGES = 6;

function messagesFrom(raw: unknown, key: 'errors' | 'warnings'): StoredMessage[] {
  if (!raw || typeof raw !== 'object') return [];
  const list = (raw as Record<string, unknown>)[key];
  if (!Array.isArray(list)) return [];
  const out: StoredMessage[] = [];
  for (const m of list.slice(0, MAX_SHOWN_MESSAGES)) {
    if (!m || typeof m !== 'object') continue;
    const r = m as Record<string, unknown>;
    out.push({
      code: typeof r.code === 'string' ? r.code : null,
      message: typeof r.message === 'string' ? r.message : null,
    });
  }
  return out;
}

/** أخطاء الهيئة كما خزّنها محرّك الإرسال في validation (منقّحة، بلا نصّ خام ولا أسرار). */
export function storedZatcaErrors(validation: unknown): StoredMessage[] {
  return messagesFrom(validation, 'errors');
}

export function storedZatcaWarnings(validation: unknown): StoredMessage[] {
  return messagesFrom(validation, 'warnings');
}

// ─── ردود المسار ───

/** 422 برسائل الهيئة (الفاتورة أُبطلت في معاملة النتيجة نفسها). */
export function clearanceRejectedError(validation: unknown, data?: unknown): ZatcaHttpError {
  return rejectedError(storedZatcaErrors(validation), data);
}

/** 202 «بانتظار الاعتماد» بسببها (D5). */
export function clearancePendingError(reason: ClearancePendingReason, data?: unknown): ZatcaHttpError {
  return new ZatcaHttpError('ZATCA_CLEARANCE_PENDING', {
    messageAr: `${ZATCA_ERROR_CATALOGUE.ZATCA_CLEARANCE_PENDING.messageAr} (${CLEARANCE_PENDING_REASONS[reason]})`,
    reason, ...(data !== undefined ? { data } : {}),
  });
}

/** 409 سُحبت الفاتورة قبل وصول الهيئة وأُلغيت (Z5.4) — لا انتظار بعدها. */
export function clearanceWithdrawnError(data?: unknown): ZatcaHttpError {
  return new ZatcaHttpError('ZATCA_WITHDRAWN', { ...(data !== undefined ? { data } : {}) });
}

/** 202 اعتماد بلا نسخة معتمدة (U8) — نهائي عند الهيئة وغير قابل للطباعة. */
export function clearedNoXmlError(data?: unknown): ZatcaHttpError {
  return new ZatcaHttpError('ZATCA_CLEARED_NO_XML', { ...(data !== undefined ? { data } : {}) });
}

// ─── حدّ زمنيّ للانتظار الحيّ ───

export interface DeadlineResult<T> {
  /** انقضت المهلة قبل أن يعود الوعد (العمل يكمل في الخلفية والمسح شبكة الأمان). */
  timedOut: boolean;
  value: T | null;
  error: unknown;
}

/**
 * ينتظر الوعد بحدٍّ أقصى ولا يرمي أبداً: ما بعد المهلة يكمل في الخلفية (المستند مُستولى عليه بعقد إيجار، وإعادة إرسال
 * البايتات نفسها تكرارٌ = نجاح). أخطاء الوعد تُلتقط كي لا يسقط الطلب بعد أن التُزمت الفاتورة فعلاً.
 */
export async function withDeadline<T>(p: Promise<T>, ms: number): Promise<DeadlineResult<T>> {
  const limit = Math.max(1, Math.trunc(ms));
  let timer: ReturnType<typeof setTimeout> | null = null;
  const guarded = p.then(
    value => ({ timedOut: false, value, error: null } as DeadlineResult<T>),
    error => ({ timedOut: false, value: null, error } as DeadlineResult<T>),
  );
  // الوعد الخلفي لا يُهمَل: أخطاؤه مُلتقطة في guarded أعلاه فلا unhandled rejection بعد انقضاء المهلة
  const timeout = new Promise<DeadlineResult<T>>(resolve => {
    timer = setTimeout(() => resolve({ timedOut: true, value: null, error: null }), limit);
    if (typeof (timer as { unref?: () => void }).unref === 'function') (timer as { unref: () => void }).unref();
  });
  try {
    return await Promise.race([guarded, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
