/**
 * منطق «تفعيل المرحلة الثانية» (Z5.8) — نقيّ بلا React ولا DOM ولا شبكة.
 *
 * الخادم (backend/src/routes/zatca.ts + compliance/zatca/goLive.ts) هو الحارس الفعليّ: هذه الدوالّ تشتقّ عرض
 * الجاهزية من بوابة `GoLiveGate` التي يُرجعها الخادم، وتصنّف طابور مراجعة الانتقال (D11) — لا تقرّر شيئاً.
 *
 * القاعدة الحاكمة للعرض: شاشة التفعيل الغنيّة (تسليح + go-live) لا تظهر إلا حين هيّأ الخادم البوابة **وسمح علم
 * المنصّة `ZATCA_GO_LIVE` لهذه الشركة** (`envAllows === true`). غير ذلك ⇒ الزرّ المعطَّل كما اليوم تماماً، فشركةٌ
 * لم تُفتح لها المرحلة الثانية لا ترى شيئاً جديداً.
 *
 * التسميات عربية وتُمرَّر عبر tr() في المكوّنات (مداخلها في goLivePhrases.ts، والحارس في goLiveLogic.test.ts).
 */
import type { ZatcaGoLiveCheckKey, ZatcaGoLiveReadiness, ZatcaOverview, ZatcaRepUnsyncedReason } from '../../types';

// ─────────────────────────────────────────────────────────────────────────────
// تأكيد التفعيل وظهور الشاشة
// ─────────────────────────────────────────────────────────────────────────────

/** كلمة التأكيد المكتوبة قبل التفعيل — مطابقة لـ backend GO_LIVE_CONFIRMATION_TEXT. */
export const GO_LIVE_CONFIRMATION_TEXT = 'تفعيل';

export function isGoLiveConfirmed(typed: string): boolean {
  return typed.trim() === GO_LIVE_CONFIRMATION_TEXT;
}

/**
 * هل تُعرض شاشة التفعيل الغنيّة بدل الزرّ المعطَّل؟ فقط حين هيّأ الخادم البوابة وسمح علم المنصّة لهذه الشركة.
 * بلا بوابة (المخزن غير مهيّأ، أو الشركة مفعّلة بالفعل فتُرجَع null) أو بعلمٍ مغلق ⇒ لا شيء جديد (كما اليوم).
 */
export function activationVisible(ov: Pick<ZatcaOverview, 'goLiveReadiness'>): boolean {
  const r = ov.goLiveReadiness;
  return !!r && r.envAllows === true;
}

// ─────────────────────────────────────────────────────────────────────────────
// قائمة الجاهزية
// ─────────────────────────────────────────────────────────────────────────────

export const GO_LIVE_CHECK_ORDER: readonly ZatcaGoLiveCheckKey[] = ['unitActive', 'sellerReady', 'currencySar', 'repsSynced'];

export const GO_LIVE_CHECK_LABEL: Record<ZatcaGoLiveCheckKey, string> = {
  unitActive: 'وحدة فوترة إنتاجيّة مفعّلة وشهادتها سارية',
  sellerReady: 'بيانات المنشأة (البائع) مكتملة',
  currencySar: 'عملة الفوترة هي الريال السعودي',
  repsSynced: 'كل مندوب نشط زامن جهازه بعد التسليح',
};

export interface GoLiveCheckRow { key: ZatcaGoLiveCheckKey; ok: boolean; label: string }

export function goLiveCheckRows(r: ZatcaGoLiveReadiness): GoLiveCheckRow[] {
  return GO_LIVE_CHECK_ORDER.map(key => ({ key, ok: r.checks?.[key] === true, label: GO_LIVE_CHECK_LABEL[key] }));
}

export const REP_UNSYNCED_REASON_LABEL: Record<ZatcaRepUnsyncedReason, string> = {
  NO_REPORT: 'لم يفتح التطبيق ليبلّغ حالة صندوقه بعد',
  STALE_REPORT: 'آخر مزامنة قبل التسليح — يفتح التطبيق ليبلّغ من جديد',
  OUTBOX_PENDING: 'لديه مستندات معلّقة لم تُرفع بعد',
};

export function repUnsyncedReasonLabel(reason: string): string {
  return (REP_UNSYNCED_REASON_LABEL as Record<string, string>)[reason] ?? 'لم يزامن جهازه بعد';
}

// ─────────────────────────────────────────────────────────────────────────────
// حالة الأزرار (تسليح / تفعيل)
// ─────────────────────────────────────────────────────────────────────────────

export interface ActivationButtons {
  /** زرّ «تسليح التفعيل»: متاح ما دامت البوابة قائمة ولم يُسلَّح بعد ولا عمليّة جارية. */
  canArm: boolean;
  armed: boolean;
  /** زرّ «تفعيل المرحلة الثانية»: جاهزٌ كامل (armed + كل الفحوص) + إقرار المزامنة + كتابة «تفعيل». */
  canGoLive: boolean;
}

export function activationButtons(
  r: ZatcaGoLiveReadiness | null | undefined, typed: string, repsAck: boolean, busy: boolean,
): ActivationButtons {
  const armed = !!r?.armed;
  return {
    canArm: !!r && !armed && !busy,
    armed,
    canGoLive: !!r && r.available === true && repsAck && isGoLiveConfirmed(typed) && !busy,
  };
}

/** رسالة رفض التفعيل: نصّ الخادم العربيّ أولاً (يحمل سبب النقص)، وإلا تسمية الرمز، وإلا رسالة عامّة. */
export const GO_LIVE_ERROR_LABEL: Record<string, string> = {
  GO_LIVE_UNAVAILABLE: 'التفعيل غير متاح الآن — لم تفتح المنصّة إطلاق المرحلة الثانية لشركتك بعد',
  GO_LIVE_NOT_READY: 'لم تكتمل شروط التفعيل بعد — راجع قائمة الجاهزية',
  CONFIRMATION_REQUIRED: 'اكتب كلمة «تفعيل» وأقرَّ بمزامنة المناديب أولاً',
  TENANT_NOT_FOUND: 'تعذّر العثور على إعدادات الشركة',
};

export function goLiveErrorMessage(code: string | null, serverMessage: string | null): string {
  if (serverMessage && serverMessage.trim() !== '') return serverMessage;
  if (code && GO_LIVE_ERROR_LABEL[code]) return GO_LIVE_ERROR_LABEL[code];
  return 'تعذّر تنفيذ الطلب';
}

// ─────────────────────────────────────────────────────────────────────────────
// طابور مراجعة الانتقال (D11)
// ─────────────────────────────────────────────────────────────────────────────

export const CUTOVER_STATUSES = ['PENDING', 'ACCEPTED_PHASE1', 'ACCEPTED_PHASE2', 'REJECTED'] as const;
export type CutoverStatus = (typeof CUTOVER_STATUSES)[number];
export type CutoverReason = 'CREATED_AFTER_GOLIVE' | 'WINDOW_EXPIRED' | 'TOO_OLD' | 'NO_CLIENT_TIME';

export interface CutoverItem {
  id: string;
  clientRef: string | null;
  clientCreatedAt: string | null;
  reason: CutoverReason | string;
  status: CutoverStatus | string;
  salesRepId: string | null;
  customerId: string | null;
  amount: number | null;
  note: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  resultInvoiceId: string | null;
  createdAt: string | null;
}

export const CUTOVER_REASON_LABEL: Record<CutoverReason, string> = {
  CREATED_AFTER_GOLIVE: 'أُنشئ على الجهاز بعد لحظة التفعيل',
  WINDOW_EXPIRED: 'وصل بعد مهلة اثنتين وسبعين ساعة من التفعيل',
  TOO_OLD: 'تاريخ إنشائه أقدم من الحدّ المسموح قبل التفعيل',
  NO_CLIENT_TIME: 'بلا لحظة إنشاء على الجهاز — يتعذّر تصنيفه تلقائياً',
};

export function cutoverReasonLabel(reason: string): string {
  return (CUTOVER_REASON_LABEL as Record<string, string>)[reason] ?? 'يحتاج مراجعة الإدارة';
}

export const CUTOVER_STATUS_LABEL: Record<CutoverStatus, string> = {
  PENDING: 'بانتظار المراجعة',
  ACCEPTED_PHASE1: 'قُبل مرحلةً أولى',
  ACCEPTED_PHASE2: 'أُعيد إصداره مرحلةً ثانية',
  REJECTED: 'مرفوض',
};

export type CutoverTone = 'pending' | 'success' | 'danger' | 'muted';
export const CUTOVER_STATUS_TONE: Record<CutoverStatus, CutoverTone> = {
  PENDING: 'pending', ACCEPTED_PHASE1: 'success', ACCEPTED_PHASE2: 'success', REJECTED: 'danger',
};

export function cutoverStatusLabel(status: string): string {
  return (CUTOVER_STATUS_LABEL as Record<string, string>)[status] ?? 'حالة غير معروفة';
}

export function cutoverStatusTone(status: string): CutoverTone {
  return (CUTOVER_STATUS_TONE as Record<string, CutoverTone>)[status] ?? 'muted';
}

export function cutoverIsPending(item: { status: string }): boolean {
  return item.status === 'PENDING';
}

/** استخراج قائمة مراجعة الانتقال من جسم الردّ ({ items: [...] }) مع تطبيع الحقول (لا ثقة بشكل غير متوقّع). */
export function cutoverItemsFrom(data: unknown): CutoverItem[] {
  const items = (data as { data?: { items?: unknown } } | null)?.data?.items;
  if (!Array.isArray(items)) return [];
  const out: CutoverItem[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.id !== 'string' || r.id === '') continue;
    out.push({
      id: r.id,
      clientRef: typeof r.clientRef === 'string' ? r.clientRef : null,
      clientCreatedAt: typeof r.clientCreatedAt === 'string' ? r.clientCreatedAt : null,
      reason: typeof r.reason === 'string' ? r.reason : '',
      status: typeof r.status === 'string' ? r.status : 'PENDING',
      salesRepId: typeof r.salesRepId === 'string' ? r.salesRepId : null,
      customerId: typeof r.customerId === 'string' ? r.customerId : null,
      amount: typeof r.amount === 'number' ? r.amount : null,
      note: typeof r.note === 'string' ? r.note : null,
      reviewedBy: typeof r.reviewedBy === 'string' ? r.reviewedBy : null,
      reviewedAt: typeof r.reviewedAt === 'string' ? r.reviewedAt : null,
      resultInvoiceId: typeof r.resultInvoiceId === 'string' ? r.resultInvoiceId : null,
      createdAt: typeof r.createdAt === 'string' ? r.createdAt : null,
    });
  }
  return out;
}

/** أهي حالة «مخزن التفعيل غير مهيّأ» (404 GO_LIVE_UNAVAILABLE)؟ عندها تُخفي الشاشة نفسها (شركة غير مربوطة بالإطلاق). */
export function isCutoverStoreAbsent(status: number | null, code: string | null): boolean {
  return status === 404 && code === 'GO_LIVE_UNAVAILABLE';
}
