// ============================================================================
// ZATCA المرحلة الثانية (Z5.4) — قواعد إبطال الفاتورة المرفوضة وسحب المعلّقة (نقيّة: لا قاعدة بيانات ولا شبكة)
// ----------------------------------------------------------------------------
// z5_plan §3 «Z5.4» + design Z5.9 + نقد الخطة (7، 11، 14) وقرار المالك Q1:
//   • الرفض النهائي لقياسية (01) يُبطل الفاتورة **داخل معاملة كتابة النتيجة نفسها** (نقد 7): لا نصف حسم بعد انهيار،
//     ولا شرطَ على المرآة السابقة (كُتبت rejected قبل الخطّاف مباشرةً في المعاملة نفسها).
//   • المبسّطة المرفوضة (02) **لا تُبطل أبداً**: ورقتها مع المشتري فعلاً — تبقى CONFIRMED وتُصحَّح بإعادة إصدار (design Z5.9).
//   • Q1 (قرار المالك): فاتورة نقدية قياسية حُصّلت ثم رُفضت ⇒ يُعكس شقّ الفاتورة وحده ويبقى المحصَّل **رصيداً دائناً للعميل**
//     يُسدَّد به البديل — لا يُعكس تحصيل المندوب أبداً.
//   • السحب (نقد 11): مخرجٌ للفاتورة القياسية العالقة «بانتظار الاعتماد» — ولا يُسمح به إلا بإثبات أنّ الهيئة لم تستلم
//     المستند: لا محاولة قد تكون وصلت (سجلّ الطلبات شاهدُها)، والمستند ليس نهائياً ولا قيد الإرسال الآن. ودليلُ
//     «بايتات غادرت» هو `sentAttempts` وحده — يُرفع في جملةٍ مستقلّة قبل نداء الهيئة مباشرةً. أمّا `attempts` فيرفعه
//     **الاستيلاء** قبل أيّ فحص، فكلّ حسمٍ محلّيّ (شهادة مجدَّدة، بيانات اعتماد ناقصة، بايتات مفقودة، إيقاف 429)
//     كان يجعله أكبر من عدد السجلّات فيُرفض السحب أبداً — وهي عين الحالات التي وُضع لها (مراجعة عدائية ٢).
// لا يستورد services/gl ولا config/database.
// ============================================================================

import { FINAL_DOCUMENT_STATUSES, type DocumentStatus, type Flow, type InvoiceMirrorStatus, type Subtype } from './status';

// ─── الإبطال ───

/** سبب الإبطال: رفض الهيئة النهائي، أو سحب إداريّ قبل أن تستلمه الهيئة. */
export type VoidReason = 'REJECTED' | 'WITHDRAWN';

/**
 * كيف تُعكس القيود:
 *   • CREDIT — فاتورة آجلة (أو مقسّطة): عكس المدين كاملاً.
 *   • CASH_KEEP_COLLECTION — نقدية (Q1): عكس شقّ الفاتورة وحده، والتحصيل يبقى رصيداً دائناً للعميل.
 *   • RETURN — إشعار دائن/مرتجع: عكس دائنه (يستعمله Z5.5 لإشعارٍ رفضته الهيئة).
 */
export type VoidReversalKind = 'CREDIT' | 'CASH_KEEP_COLLECTION' | 'RETURN';

/** ما يحتاجه القرار من صفّ الفاتورة (يُقرأ مقفلاً FOR UPDATE داخل المعاملة). */
export interface VoidableInvoiceRow {
  id: string;
  tenantId: string;
  status: string;
  type: string;
  zatcaPhase: number | null;
  invoiceSubtype: string | null;
  einvoiceStatus: string | null;
  customerId: string;
  total: number;
}

export type VoidRefusal =
  | 'NOT_FOUND' | 'TENANT_MISMATCH' | 'NOT_PHASE2' | 'NOT_CONFIRMED' | 'SIMPLIFIED_KEPT' | 'MIRROR_NOT_VOIDABLE';

export type VoidDecision =
  | { ok: true; reversal: VoidReversalKind }
  | { ok: false; refusal: VoidRefusal };

/** المرايا التي يجوز الإبطال منها: القياسية قبل الاعتماد، وrejected/withdrawn لأنّ المرآة تُكتب قبل الخطّاف. */
export const VOIDABLE_MIRRORS: readonly string[] = Object.freeze(['clearance_pending', 'clearance_blocked', 'rejected', 'withdrawn']);

export function reversalKindOf(type: string): VoidReversalKind {
  if (type === 'RETURN') return 'RETURN';
  if (type === 'CASH') return 'CASH_KEEP_COLLECTION';
  return 'CREDIT';
}

/**
 * هل تُبطَل هذه الفاتورة الآن؟ نقيّ. القياسية (01) وحدها تُبطل؛ المبسّطة تبقى ورقتُها عند المشتري (design Z5.9).
 */
export function voidDecision(
  invoice: VoidableInvoiceRow | null | undefined, at: { tenantId: string; subtype: Subtype },
): VoidDecision {
  if (!invoice) return { ok: false, refusal: 'NOT_FOUND' };
  if (invoice.tenantId !== at.tenantId) return { ok: false, refusal: 'TENANT_MISMATCH' };
  if (invoice.zatcaPhase !== 2) return { ok: false, refusal: 'NOT_PHASE2' };
  if (at.subtype !== '01') return { ok: false, refusal: 'SIMPLIFIED_KEPT' };
  if (invoice.status !== 'CONFIRMED') return { ok: false, refusal: 'NOT_CONFIRMED' };
  if (invoice.einvoiceStatus !== null && !VOIDABLE_MIRRORS.includes(invoice.einvoiceStatus)) {
    return { ok: false, refusal: 'MIRROR_NOT_VOIDABLE' };
  }
  return { ok: true, reversal: reversalKindOf(invoice.type) };
}

export const VOID_NOTIFICATION_TYPES: Readonly<Record<VoidReason, string>> = Object.freeze({
  REJECTED: 'ZATCA_INVOICE_REJECTED',
  WITHDRAWN: 'ZATCA_INVOICE_WITHDRAWN',
});

/** مبلغ للنصّ العربي (D9: الريال وحده). */
const sar = (v: number): string => `${(Math.round(Number(v) * 100) / 100).toFixed(2)} ريال`;

/**
 * نصّ الإشعار الإداريّ — يبقى مهمّةً مفتوحة حتى يُصدَر البديل (نقد 14). ويقول صراحةً ما لا يراه المدير في الشاشة
 * (مراجعة عدائية): كمّيات الفاتورة المُبطلة عادت حسابياً إلى مخزون السيارة (المخزون مشتقٌّ من الفواتير المعتمدة)،
 * والمحصَّل نقداً بقي رصيداً دائناً للعميل (Q1) فالبديل يُصدر **آجلاً** ليُسدَّد منه لا نقداً فيتضاعف التحصيل.
 */
export function voidNotificationText(
  reason: VoidReason, number: string,
  ctx: { reversal?: VoidReversalKind | null; total?: number | null; documentKind?: string | null } = {},
): { title: string; body: string } {
  /* Z5.5: الصفّ المُبطل قد يكون **إشعاراً دائناً** لا فاتورة، وكلّ اتجاهٍ في النصّ ينقلب حينها (مراجعة «امتثال»):
   * الكمّيات خرجت من رصيد مخزون السيارة لا عادت إليه، والبضاعة عند المندوب لا عند العميل، والبديل إشعارٌ دائن
   * جديد لا فاتورة. ولا رصيد دائن يُذكر: عكسُ المرتجع ردّ الدَّين إلى ما كان. */
  if (ctx.documentKind === 'CREDIT_NOTE') {
    if (reason === 'WITHDRAWN') {
      return {
        title: 'سحب إشعار دائن قبل الاعتماد',
        body: `سُحب الإشعار الدائن ${number} قبل أن تستلمه الهيئة وأُبطل — كمّياته خرجت من رصيد مخزون السيارة`
          + ' ومتبقّي الفاتورة الأصلية عاد كما كان؛ أعد إصدار الإشعار إن كانت البضاعة مرتجعةً فعلاً.',
      };
    }
    return {
      title: 'رفض الهيئة إشعاراً دائناً وأُبطل',
      body: `رفضت الهيئة الإشعار الدائن ${number} فأُبطل — كمّياته خرجت من رصيد مخزون السيارة ومتبقّي الفاتورة`
        + ' الأصلية عاد كما كان؛ صحّح البيانات وأصدر إشعاراً دائناً جديداً اليوم نفسه.',
    };
  }
  const credit = ctx.reversal === 'CASH_KEEP_COLLECTION' && typeof ctx.total === 'number' && ctx.total > 0
    ? ` والمحصَّل نقداً (${sar(ctx.total)}) بقي رصيداً دائناً للعميل — أصدر البديل آجلاً ليُسدَّد منه.` : '';
  if (reason === 'WITHDRAWN') {
    return {
      title: 'سحب فاتورة ضريبية قبل الاعتماد',
      body: `سُحبت الفاتورة ${number} قبل أن تستلمها الهيئة وأُلغيت — إن كانت البضاعة سُلّمت فأصدر فاتورة بديلة اليوم نفسه`
        + ` (كمّياتها عادت إلى رصيد مخزون السيارة).${credit}`,
    };
  }
  return {
    title: 'رفض الهيئة فاتورة ضريبية وأُبطلت',
    body: `رفضت الهيئة الفاتورة ${number} فأُبطلت تلقائياً — صحّح البيانات وأصدر فاتورة جديدة للعميل اليوم نفسه`
      + ` (كمّيات الفاتورة عادت إلى رصيد مخزون السيارة والبضاعة عند العميل).${credit}`,
  };
}

// ─── السحب (نقد 11) ───

export type WithdrawRefusal =
  | 'NOT_PHASE2' | 'NOT_STANDARD' | 'NOT_CONFIRMED' | 'MIRROR_NOT_PENDING' | 'NO_DOCUMENT' | 'DOCUMENT_FINAL'
  | 'IN_FLIGHT' | 'MAY_HAVE_BEEN_RECEIVED' | 'STATE_CHANGED';

export const WITHDRAW_REFUSAL_MESSAGES: Readonly<Record<WithdrawRefusal, string>> = Object.freeze({
  STATE_CHANGED: 'تغيّرت حالة الفاتورة أثناء السحب — أعد المحاولة',
  NOT_PHASE2: 'هذه الفاتورة ليست من الفوترة الإلكترونية للمرحلة الثانية',
  NOT_STANDARD: 'السحب للفاتورة الضريبية (منشأة) المعلّقة وحدها — والمبسّطة تُصحَّح بإعادة الإصدار',
  NOT_CONFIRMED: 'الفاتورة غير معتمدة أو أُلغيت مسبقاً',
  MIRROR_NOT_PENDING: 'الفاتورة ليست بانتظار اعتماد الهيئة',
  NO_DOCUMENT: 'لا يوجد مستند ضريبي لهذه الفاتورة',
  DOCUMENT_FINAL: 'حسمت الهيئة هذا المستند — لا يمكن سحبه',
  IN_FLIGHT: 'المستند قيد الإرسال إلى الهيئة الآن — أعد المحاولة بعد دقيقة',
  MAY_HAVE_BEEN_RECEIVED: 'تعذّر إثبات أنّ الهيئة لم تستلم الفاتورة — انتظر حتى تُحسم، فالسحب بعد وصولها مخالفة',
});

/** المستند كما يُقرأ للسحب (إسقاط القاعدة). */
export interface WithdrawDocumentView {
  status: string;
  flow: Flow | string;
  /**
   * عدّاد الإرسال الفعليّ: يُرفع قبل نداء الهيئة مباشرةً — دليلٌ دائم على أنّ بايتات غادرت (سجلّ الطلبات best-effort).
   * ليس عدّاد المطالبة `attempts`: ذاك يرفعه الاستيلاء ولو حُسم المستند محلياً بلا نداء.
   */
  sentAttempts?: number;
  firstSubmitAt: Date | null;
  leaseUntil?: Date | null;
}

export interface WithdrawInvoiceView {
  status: string;
  zatcaPhase: number | null;
  invoiceSubtype: string | null;
  einvoiceStatus: string | null;
}

/**
 * الدليل: إمّا أنّ المستند لم يُرسل قطّ (لا محاولة غادرت ولا سجلّ)، وإمّا أنّ **كلّ** محاولة غادرت خلّفت سجلّاً وكلّها
 * رُدّت بما يُثبت أنّ الهيئة لم تعالجها (401/403/429). ما بينهما — محاولةٌ غادرت بلا سجلّ (موتُ العملية بعد إرسال
 * البايتات) — ليس دليلاً بل جهلاً، فيُرفض.
 */
export type WithdrawProof = 'NEVER_SENT' | 'ALL_ATTEMPTS_REFUSED';

export type WithdrawDecision =
  | { ok: true; proof: WithdrawProof }
  | { ok: false; refusal: WithdrawRefusal; messageAr: string };

const refuse = (refusal: WithdrawRefusal): WithdrawDecision => ({ ok: false, refusal, messageAr: WITHDRAW_REFUSAL_MESSAGES[refusal] });

/** مرايا الفاتورة التي يجوز السحب منها (قياسية لم تُعتمد بعد). */
export const WITHDRAWABLE_MIRRORS: readonly InvoiceMirrorStatus[] =
  Object.freeze(['clearance_pending', 'clearance_blocked'] as InvoiceMirrorStatus[]);

/**
 * نقيّ: هل يجوز سحب هذه الفاتورة؟ `possiblyDeliveredAttempts` = عدد محاولات الإرسال التي **قد** تكون وصلت الهيئة
 * (كلّ محاولة أُرسلت فعلاً إلا ما رُدّ عليه بـ401/403/429 — وانقطاع الشبكة وانقضاء المهلة يُحسبان «قد وصلت» عمداً).
 */
export function withdrawDecision(input: {
  invoice: WithdrawInvoiceView;
  document: WithdrawDocumentView | null;
  possiblyDeliveredAttempts: number;
  /** عدد صفوف سجلّ الطلبات لهذا المستند (أيّاً كان ردّها) — يُقارَن بـsentAttempts لكشف محاولةٍ غادرت بلا سجلّ. */
  loggedAttempts?: number;
  now: Date;
}): WithdrawDecision {
  const { invoice, document } = input;
  if (invoice.zatcaPhase !== 2) return refuse('NOT_PHASE2');
  if (invoice.invoiceSubtype !== '01') return refuse('NOT_STANDARD');
  if (invoice.status !== 'CONFIRMED') return refuse('NOT_CONFIRMED');
  if (!(WITHDRAWABLE_MIRRORS as readonly string[]).includes(invoice.einvoiceStatus ?? '')) return refuse('MIRROR_NOT_PENDING');
  if (!document) return refuse('NO_DOCUMENT');
  if ((FINAL_DOCUMENT_STATUSES as readonly string[]).includes(document.status)) return refuse('DOCUMENT_FINAL');
  if (document.status === 'SUBMITTING' && document.leaseUntil instanceof Date && document.leaseUntil.getTime() > input.now.getTime()) {
    return refuse('IN_FLIGHT');
  }
  if (input.possiblyDeliveredAttempts > 0) return refuse('MAY_HAVE_BEEN_RECEIVED');
  /* عدّاد الإرسال الفعليّ هو الدليل، لا عدّاد المطالبة: محاولةٌ **غادرت** (sentAttempts) ولم تخلّف سجلّاً تعني بايتات
   * في الطريق لا نعرف مصيرها — وهي عين ما نهى عنه نقد 11. ولو سقطت جملةُ الوسم نفسها (sent=0) بينما وُجد سجلّ،
   * فالسجلّ أثبتُ من غيابها: لا يُقال «لم يُرسل قطّ» وفي السجلّ ردٌّ من الهيئة. */
  const sent = Number.isInteger(document.sentAttempts) ? (document.sentAttempts as number) : 0;
  const logged = Number.isInteger(input.loggedAttempts) ? (input.loggedAttempts as number) : 0;
  if (sent === 0 && logged === 0) return { ok: true, proof: 'NEVER_SENT' };
  if (logged > 0 && logged >= sent) return { ok: true, proof: 'ALL_ATTEMPTS_REFUSED' };
  return refuse('MAY_HAVE_BEEN_RECEIVED');
}

/**
 * حالات المستند التي يُسحب منها (شرط CAS في المخزن). SUBMITTING ليست منها: مستندٌ بدأ إرساله لا يُسحب ولو انقضى
 * عقده — يُترك للمسح حتى يحسمه ردُّ الهيئة أو تكرارها (409/208).
 */
export const WITHDRAWABLE_DOCUMENT_STATUSES: readonly DocumentStatus[] = Object.freeze(
  ['SIGNED', 'RETRY_WAIT', 'AUTH_BLOCKED', 'CONFIG_ERROR'] as DocumentStatus[],
);

/** ردود الهيئة التي تُثبت أنّ المستند لم يُعالَج (تُستثنى من عدّ «قد وصلت»). */
export const NOT_RECEIVED_HTTP_STATUSES: readonly number[] = Object.freeze([401, 403, 429]);
