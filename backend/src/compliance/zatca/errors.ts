// ============================================================================
// ZATCA المرحلة الثانية (Z5.0) — كتالوج أخطاء الإصدار: رمز ثابت + حالة HTTP + رسالة عربية للمستخدم
// ----------------------------------------------------------------------------
// z5_plan §2.5 + نقد الخطة (26):
//   • toZatcaHttpError(err) يحوّل أخطاء وحدات Z1–Z4 (ZatcaInputError، StampError، FatooraInputError، SecretsError) وأخطاء
//     Prisma (P2002 على مفاتيح السلسلة وحدها، P2028) إلى ZatcaHttpError — وnull لما ليس له (يمضي إلى معالج الأخطاء العامّ
//     كما اليوم).
//   • P2002 على clientRef أو رقم الفاتورة ليس تعارض سلسلة: null (المستدعي يعيد الفاتورة القائمة أو يعيد الترقيم). تعارض
//     السلسلة = قيود zatca_documents الفريدة وحدها (egsUnitId+icv، uuid، invoiceId+attemptNo) ⇒ 503 + تنبيه المالك بلا إعادة.
//   • الأسباب الداخلية (رموز الختم الداخلية، FatooraInputError، P2002، أخطاء المفاتيح) لا تصل المستخدم: رسالة عامة ثابتة،
//     والتفصيل في logDetail (رموز ثابتة فقط — لا نصّ رسالة قد يحمل بيانات).
// لا يستورد services/gl ولا قاعدة البيانات.
// ============================================================================

import { FatooraInputError } from './api';
import { ZatcaInputError, type ZatcaIssue } from './model';
import type { RegimeBlockedReason } from './regime';
import { SecretsError } from './secrets';
import { StampError, type StampErrorCode } from './stamp';

export type ZatcaErrorCode =
  | 'ZATCA_PREFLIGHT' | 'ZATCA_BUYER_INCOMPLETE' | 'ZATCA_INCLUSIVE_HEAD_DISCOUNT' | 'ZATCA_ZERO_VALUE_LINE' | 'ZATCA_AMOUNTS'
  | 'ZATCA_CURRENCY' | 'ZATCA_SETTINGS_LOCKED' | 'ZATCA_UNIT_UNAVAILABLE' | 'ZATCA_UNIT_BUSY' | 'ZATCA_STAMP_FAILED'
  | 'ZATCA_CHAIN_CONFLICT' | 'ZATCA_CLEARANCE_PENDING' | 'ZATCA_REJECTED' | 'ZATCA_USE_CREDIT_NOTE' | 'ZATCA_RETURN_NEEDS_ORIGINAL'
  | 'ZATCA_ORIGINAL_NOT_CLEARED' | 'ZATCA_CREDIT_QTY_EXCEEDED' | 'ZATCA_NOTHING_TO_CREDIT' | 'ZATCA_CLIENT_UPDATE_REQUIRED'
  | 'ZATCA_CLEARED_NO_XML' | 'ZATCA_ALLOCATION_BLOCKED' | 'ZATCA_WITHDRAW_NOT_ALLOWED' | 'ZATCA_REISSUE_NOT_ALLOWED'
  | 'ZATCA_RETRY_NOT_ALLOWED' | 'ZATCA_CANCEL_NOT_ALLOWED' | 'ZATCA_WITHDRAWN' | 'ZATCA_CUTOVER_REVIEW' | 'ZATCA_OFFLINE_BLOCKED' | 'ZATCA_INTERNAL' | 'CUSTOMER_ZATCA_INVALID' | 'TENANT_HAS_EINVOICE_ARCHIVE';

export interface ZatcaCatalogueEntry {
  status: number;
  messageAr: string;
  /** يُبلَّغ مالك المنصة (إشعار + سطر سجل) — عطل لا خطأ بيانات. */
  alert: boolean;
}

/** الرسائل بلا {الحقول}: تُلحق القائمة عند البناء. */
export const ZATCA_ERROR_CATALOGUE: Readonly<Record<ZatcaErrorCode, Readonly<ZatcaCatalogueEntry>>> = Object.freeze({
  ZATCA_PREFLIGHT: { status: 422, messageAr: 'بيانات ناقصة أو غير صحيحة لإصدار فاتورة ضريبية', alert: false },
  ZATCA_BUYER_INCOMPLETE: { status: 422, messageAr: 'بيانات العميل (منشأة) ناقصة للفاتورة الضريبية', alert: false },
  ZATCA_INCLUSIVE_HEAD_DISCOUNT: { status: 422, messageAr: 'الخصم على إجمالي الفاتورة غير مسموح مع الأسعار الشاملة للضريبة — ضع الخصم على الأصناف', alert: false },
  ZATCA_ZERO_VALUE_LINE: { status: 422, messageAr: 'لا يمكن إصدار صنف بسعر صفر في فاتورة ضريبية', alert: false },
  ZATCA_AMOUNTS: { status: 422, messageAr: 'تعذّرت مطابقة مبالغ الفاتورة مع قواعد الهيئة — عدّل الكمية أو السعر', alert: false },
  ZATCA_CURRENCY: { status: 422, messageAr: 'الريال السعودي فقط للشركات المربوطة بالمرحلة الثانية', alert: false },
  ZATCA_SETTINGS_LOCKED: { status: 409, messageAr: 'لا يمكن تغيير الدولة أو العملة أو مزوّد الفوترة بعد التفعيل', alert: false },
  ZATCA_UNIT_UNAVAILABLE: { status: 503, messageAr: 'وحدة الفوترة الإلكترونية غير متاحة — راجع مدير الشركة', alert: false },
  ZATCA_UNIT_BUSY: { status: 503, messageAr: 'النظام مشغول بإصدار فاتورة أخرى — أعد المحاولة', alert: false },
  ZATCA_STAMP_FAILED: { status: 503, messageAr: 'تعذّر توقيع الفاتورة إلكترونياً ولم تُصدر — أعد المحاولة، وأُبلغت الإدارة', alert: true },
  ZATCA_CHAIN_CONFLICT: { status: 503, messageAr: 'تعذّر توقيع الفاتورة إلكترونياً ولم تُصدر — أعد المحاولة، وأُبلغت الإدارة', alert: true },
  ZATCA_CLEARANCE_PENDING: { status: 202, messageAr: 'صدرت الفاتورة وبانتظار اعتماد الهيئة — لا تُسلِّم فاتورة ضريبية الآن؛ سلّم مذكرة التسليم وستصل الفاتورة المعتمدة لاحقاً', alert: false },
  ZATCA_REJECTED: { status: 422, messageAr: 'رفضت الهيئة الفاتورة وأُبطلت تلقائياً', alert: false },
  ZATCA_USE_CREDIT_NOTE: { status: 409, messageAr: 'لا يمكن إلغاء فاتورة بعد الربط مع الهيئة — أصدر إشعاراً دائناً كاملاً', alert: false },
  ZATCA_RETURN_NEEDS_ORIGINAL: { status: 422, messageAr: 'المرتجع يُصدر إشعاراً دائناً مرتبطاً بالفاتورة الأصلية — اختر الفاتورة أولاً', alert: false },
  ZATCA_ORIGINAL_NOT_CLEARED: { status: 409, messageAr: 'لا يمكن إصدار إشعار على فاتورة لم تعتمدها الهيئة بعد', alert: false },
  ZATCA_CREDIT_QTY_EXCEEDED: { status: 422, messageAr: 'الكمية المرتجعة تتجاوز المتاح', alert: false },
  ZATCA_NOTHING_TO_CREDIT: { status: 409, messageAr: 'كل كميات هذه الفاتورة مُرتجعة سابقاً', alert: false },
  // Z5.4: اعتمدت الهيئة ولم تُعد النسخة المعتمدة — نهائية عند الهيئة وغير قابلة للطباعة حتى تُسترجع (U8)
  ZATCA_CLEARED_NO_XML: { status: 202, messageAr: 'اعتمدت الهيئة الفاتورة ولم تُعد نسختها المعتمدة — لا تُسلِّم فاتورة ضريبية الآن، وأُبلغت الإدارة لاسترجاعها', alert: true },
  // Z5.4 (F2): لا تحصيل ولا رابط دفع على فاتورة لم تصر نهائية عند الهيئة
  ZATCA_ALLOCATION_BLOCKED: { status: 409, messageAr: 'لا يمكن تحصيل فاتورة لم تعتمدها الهيئة بعد — انتظر الاعتماد ثم حصّل', alert: false },
  // Z5.4 (نقد 11): السحب لا يُسمح إلا بإثبات أنّ الهيئة لم تستلم المستند
  ZATCA_WITHDRAW_NOT_ALLOWED: { status: 409, messageAr: 'لا يمكن سحب هذه الفاتورة', alert: false },
  ZATCA_REISSUE_NOT_ALLOWED: { status: 409, messageAr: 'لا يمكن إعادة إصدار هذه الفاتورة', alert: false },
  ZATCA_RETRY_NOT_ALLOWED: { status: 409, messageAr: 'لا يمكن إعادة إرسال هذا المستند الآن', alert: false },
  // Z5.4 (مراجعة عدائية ٢): الإلغاء اليدويّ لا يمسّ مستند الهيئة، فكان يترك المسح يرسل فاتورةً عُكست قيودها
  ZATCA_CANCEL_NOT_ALLOWED: {
    status: 409,
    messageAr: 'لا يُلغى مستند الفوترة الإلكترونية يدوياً — إن لم تعتمده الهيئة بعد فاسحب الفاتورة، وإن اعتمدته فأصدر إشعاراً دائناً كاملاً',
    alert: false,
  },
  // Z5.4 (مراجعة عدائية ٢): إعادة رفع فاتورة سُحبت وأُلغيت — لا «بانتظار الاعتماد» عن مستند لن يُرسل أبداً
  ZATCA_WITHDRAWN: { status: 409, messageAr: 'سُحبت هذه الفاتورة قبل وصولها إلى الهيئة وأُلغيت — أصدر فاتورة جديدة', alert: false },
  ZATCA_CLIENT_UPDATE_REQUIRED: { status: 426, messageAr: 'حدّث التطبيق لإصدار الفواتير الضريبية (أغلق التطبيق وافتحه من جديد)', alert: false },
  ZATCA_CUTOVER_REVIEW: { status: 409, messageAr: 'مستند دون اتصال من قبل التفعيل — بانتظار مراجعة الإدارة', alert: false },
  ZATCA_OFFLINE_BLOCKED: { status: 409, messageAr: 'لا يمكن إصدار فاتورة ضريبية أو مرتجع دون اتصال — المرحلة الثانية مفعّلة', alert: false },
  ZATCA_INTERNAL: { status: 500, messageAr: 'تعذّر إكمال عملية الفوترة الإلكترونية — أعد المحاولة، وأُبلغت الإدارة', alert: true },
  CUSTOMER_ZATCA_INVALID: { status: 400, messageAr: 'بيانات الفوترة الإلكترونية للعميل غير صحيحة', alert: false },
  TENANT_HAS_EINVOICE_ARCHIVE: { status: 409, messageAr: 'لا يمكن حذف شركة لديها سجل فوترة إلكترونية (يلزم حفظه نظاماً)', alert: false },
});

/** سبب عدم توفّر الوحدة كما يصل العميل (reason) — أسباب النظام الضريبي + أعطال إعداد الوحدة والمفاتيح. */
export type UnitUnavailableReason = RegimeBlockedReason | 'UNIT_CONFIG' | 'SECRETS';

export const UNIT_UNAVAILABLE_MESSAGES: Readonly<Record<UnitUnavailableReason, string>> = Object.freeze({
  NO_ACTIVE_UNIT: ZATCA_ERROR_CATALOGUE.ZATCA_UNIT_UNAVAILABLE.messageAr,
  MULTIPLE_ACTIVE_UNITS: ZATCA_ERROR_CATALOGUE.ZATCA_UNIT_UNAVAILABLE.messageAr,
  RENEWING: 'يجري تجديد شهادة الفوترة — أعد المحاولة بعد دقائق',
  AUTH_FAILED: 'توقّف إصدار الفواتير الضريبية — راجع مدير الشركة',
  EXPIRED: 'انتهت صلاحية شهادة الفوترة — يلزم التجديد',
  SELLER_NOT_READY: 'بيانات المنشأة ناقصة لإصدار فاتورة ضريبية — راجع مدير الشركة',
  SELLER_VAT_CHANGED: 'تغيّر الرقم الضريبي للمنشأة بعد ربط وحدة الفوترة — راجع مدير الشركة',
  UNIT_CONFIG: ZATCA_ERROR_CATALOGUE.ZATCA_UNIT_UNAVAILABLE.messageAr,
  SECRETS: ZATCA_ERROR_CATALOGUE.ZATCA_UNIT_UNAVAILABLE.messageAr,
});

/** أسباب تستوجب تنبيه المالك (عطل لا حالة تشغيل متوقّعة كالتجديد). */
const ALERTING_REASONS: ReadonlySet<UnitUnavailableReason> = new Set<UnitUnavailableReason>(['MULTIPLE_ACTIVE_UNITS', 'UNIT_CONFIG', 'SECRETS', 'AUTH_FAILED']);

export interface ZatcaLogDetail {
  /** مصدر الخطأ: اسم الصنف أو رمز Prisma. */
  source: string;
  /** رمز ثابت داخلي (رمز الختم، رمز المدخل…) — لا نصّ رسالة. */
  code: string | null;
}

export class ZatcaHttpError extends Error {
  readonly status: number;
  readonly code: ZatcaErrorCode;
  readonly messageAr: string;
  readonly issues?: ZatcaIssue[];
  readonly errors?: unknown[];
  readonly data?: unknown;
  readonly customerId?: string;
  readonly reason?: string;
  readonly subcode?: string;
  readonly alert: boolean;
  readonly logDetail: ZatcaLogDetail | null;
  constructor(code: ZatcaErrorCode, extra: {
    messageAr?: string; issues?: ZatcaIssue[]; errors?: unknown[]; data?: unknown; customerId?: string; reason?: string;
    subcode?: string; alert?: boolean; logDetail?: ZatcaLogDetail | null;
  } = {}) {
    const entry = ZATCA_ERROR_CATALOGUE[code];
    const messageAr = extra.messageAr ?? entry.messageAr;
    super(`${code}: ${messageAr}`);
    this.name = 'ZatcaHttpError';
    this.status = entry.status;
    this.code = code;
    this.messageAr = messageAr;
    if (extra.issues !== undefined) this.issues = extra.issues;
    if (extra.errors !== undefined) this.errors = extra.errors;
    if (extra.data !== undefined) this.data = extra.data;
    if (extra.customerId !== undefined) this.customerId = extra.customerId;
    if (extra.reason !== undefined) this.reason = extra.reason;
    if (extra.subcode !== undefined) this.subcode = extra.subcode;
    this.alert = extra.alert ?? entry.alert;
    this.logDetail = extra.logDetail ?? null;
  }

  /** جسم الردّ: {success, code, message} + الحقول الاختيارية الموجودة فقط (لا logDetail أبداً). */
  body(): Record<string, unknown> {
    const out: Record<string, unknown> = { success: this.status < 400, code: this.code, message: this.messageAr };
    if (this.issues !== undefined) out.issues = this.issues;
    if (this.errors !== undefined) out.errors = this.errors;
    if (this.data !== undefined) out.data = this.data;
    if (this.customerId !== undefined) out.customerId = this.customerId;
    if (this.reason !== undefined) out.reason = this.reason;
    if (this.subcode !== undefined) out.subcode = this.subcode;
    return out;
  }
}

// ─── بُناة ───

const MAX_LISTED = 6;

/** قائمة الحقول للرسالة: رسائل المخالفات المانعة بلا تكرار، أولها ستّ ثم «و n أخرى». */
export function issuesSummaryAr(issues: readonly ZatcaIssue[]): string {
  const msgs = [...new Set(issues.filter(i => i.severity === 'error').map(i => i.messageAr).filter(Boolean))];
  if (msgs.length === 0) return '';
  const head = msgs.slice(0, MAX_LISTED).join('؛ ');
  return msgs.length > MAX_LISTED ? `${head}؛ و${msgs.length - MAX_LISTED} أخرى` : head;
}

function withList(base: string, issues: readonly ZatcaIssue[], tail = ''): string {
  const list = issuesSummaryAr(issues);
  return list ? `${base}: ${list}${tail}` : base;
}

/**
 * مخالفات الفحص المسبق (أو MAPPING_INPUT) ⇒ رمز محدَّد إن كانت كلها من قاعدة معروفة (عملة/صنف بسعر صفر)، وإلا ZATCA_PREFLIGHT
 * بالقائمة. null إن لم تكن فيها مخالفة مانعة.
 */
export function preflightHttpError(issues: readonly ZatcaIssue[]): ZatcaHttpError | null {
  const blocking = issues.filter(i => i.severity === 'error');
  if (blocking.length === 0) return null;
  const all = [...issues];
  if (blocking.some(i => i.rule === 'ZATCA_CURRENCY')) return new ZatcaHttpError('ZATCA_CURRENCY', { issues: all });
  if (blocking.every(i => i.rule === 'ZERO-VALUE-LINE')) return new ZatcaHttpError('ZATCA_ZERO_VALUE_LINE', { issues: all });
  return new ZatcaHttpError('ZATCA_PREFLIGHT', { messageAr: withList(ZATCA_ERROR_CATALOGUE.ZATCA_PREFLIGHT.messageAr, blocking), issues: all });
}

/** D2 بعد التفعيل: قياسية لعميل منشأة بيانات ناقصة (قبل أي قفل). */
export function buyerIncompleteError(customerId: string, issues: readonly ZatcaIssue[]): ZatcaHttpError {
  return new ZatcaHttpError('ZATCA_BUYER_INCOMPLETE', {
    messageAr: withList(ZATCA_ERROR_CATALOGUE.ZATCA_BUYER_INCOMPLETE.messageAr, issues, '. أكملها ثم أعد الإصدار'),
    issues: [...issues], customerId,
  });
}

/** النظام الضريبي محجوب أو عطل في الوحدة ⇒ 503 ZATCA_UNIT_UNAVAILABLE بالسبب ورسالته. */
export function unitUnavailableError(reason: UnitUnavailableReason, logDetail: ZatcaLogDetail | null = null): ZatcaHttpError {
  return new ZatcaHttpError('ZATCA_UNIT_UNAVAILABLE', {
    reason, messageAr: UNIT_UNAVAILABLE_MESSAGES[reason], alert: ALERTING_REASONS.has(reason), logDetail,
  });
}

/** رفض الهيئة (Z5.4): رسائلها العربية كما وردت (نصوص فقط). */
export function rejectedError(errors: ReadonlyArray<{ message: string | null; code: string | null }>, data?: unknown): ZatcaHttpError {
  const msgs = [...new Set(errors.map(e => e.message).filter((m): m is string => typeof m === 'string' && m !== ''))].slice(0, MAX_LISTED);
  const base = ZATCA_ERROR_CATALOGUE.ZATCA_REJECTED.messageAr;
  return new ZatcaHttpError('ZATCA_REJECTED', {
    messageAr: msgs.length ? `${base}: ${msgs.join('؛ ')}. صحّح البيانات وأصدر فاتورة جديدة` : `${base}. صحّح البيانات وأصدر فاتورة جديدة`,
    errors: errors.map(e => ({ code: e.code, message: e.message })), ...(data !== undefined ? { data } : {}),
  });
}

// ─── مجموعات رموز الختم ───

export type StampErrorGroup = 'data' | 'unit' | 'internal';

export const STAMP_ERROR_GROUPS: Readonly<Record<StampErrorCode, StampErrorGroup>> = Object.freeze({
  INPUT: 'data', KIND_MISMATCH: 'data', DOC_MISMATCH: 'data', SLOT_NOT_EMPTY: 'data', QR_TOO_LONG: 'data', XML_INVALID: 'data',
  CERT_INVALID: 'unit', CERT_KEY_MISMATCH: 'unit', CERT_NOT_VALID: 'unit', SIGNER: 'unit',
  SELF_CHECK_HASH: 'internal', SELF_CHECK_SIGNATURE: 'internal', SELF_CHECK_QR: 'internal', SELF_CHECK_SIGNED_PROPERTIES: 'internal',
  SELF_CHECK_CERT: 'internal', SELF_CHECK_LAYOUT: 'internal', INTERNAL: 'internal',
});

const STAMP_FIELD_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  QR_TOO_LONG: 'رمز QR للفاتورة أطول من المسموح — اختصر اسم المنشأة أو اسم العميل',
  INPUT: 'الفاتورة أكبر من الحدّ المدعوم للتوقيع — قسّمها إلى فاتورتين',
});

function stampHttpError(e: StampError): ZatcaHttpError {
  const group = STAMP_ERROR_GROUPS[e.code] ?? 'internal';
  const logDetail: ZatcaLogDetail = { source: 'StampError', code: e.code };
  // خطأ بيانات يسمّي الختمُ حقله (QR_TOO_LONG، الحجم) — يصحّحه المستخدم؛ دون حقل = خلل في مسارنا لا بياناته
  if (group === 'data' && typeof e.field === 'string' && e.field !== '') {
    const messageAr = STAMP_FIELD_MESSAGES[e.code] ?? ZATCA_ERROR_CATALOGUE.ZATCA_PREFLIGHT.messageAr;
    return new ZatcaHttpError('ZATCA_PREFLIGHT', {
      messageAr: `${ZATCA_ERROR_CATALOGUE.ZATCA_PREFLIGHT.messageAr}: ${messageAr}`,
      issues: [{ rule: `STAMP-${e.code}`, field: e.field, messageAr, severity: 'error' }], logDetail,
    });
  }
  if (group === 'unit') return unitUnavailableError(e.code === 'CERT_NOT_VALID' ? 'EXPIRED' : 'UNIT_CONFIG', logDetail);
  return new ZatcaHttpError('ZATCA_STAMP_FAILED', { logDetail });
}

// ─── Prisma ───

const CHAIN_TARGET_RE = /zatca_documents|\bicv\b|attemptNo|^uuid$/i;

function prismaTarget(meta: unknown): string[] {
  const t = meta && typeof meta === 'object' ? (meta as { target?: unknown }).target : undefined;
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === 'string');
  return typeof t === 'string' ? [t] : [];
}

/** P2002 على قيود zatca_documents الفريدة وحدها (egsUnitId+icv، uuid، invoiceId+attemptNo). */
export function isChainUniqueViolation(err: unknown): boolean {
  const e = err as { code?: unknown; meta?: unknown } | null;
  if (!e || typeof e !== 'object' || e.code !== 'P2002') return false;
  const model = e.meta && typeof e.meta === 'object' ? (e.meta as { modelName?: unknown }).modelName : undefined;
  if (typeof model === 'string') return model === 'ZatcaDocument';
  const target = prismaTarget(e.meta);
  if (target.length === 1) return CHAIN_TARGET_RE.test(target[0]);
  return target.includes('icv') || target.includes('attemptNo');
}

/**
 * أي خطأ ⇒ ZatcaHttpError، أو null لما لا يخصّ الفوترة (يمضي كما اليوم إلى next(err)): ZatcaHttpError كما هو؛ ZatcaInputError
 * بحسب رمزه؛ StampError بمجموعته؛ FatooraInputError وSecretsError أعطال داخلية؛ P2002 على السلسلة وحدها؛ P2028 انشغال.
 */
export function toZatcaHttpError(err: unknown): ZatcaHttpError | null {
  if (err instanceof ZatcaHttpError) return err;
  if (err instanceof ZatcaInputError) {
    const logDetail: ZatcaLogDetail = { source: 'ZatcaInputError', code: err.code };
    switch (err.code) {
      case 'INCLUSIVE_HEAD_DISCOUNT':
        return new ZatcaHttpError('ZATCA_INCLUSIVE_HEAD_DISCOUNT', { issues: [...err.issues], logDetail });
      case 'AMOUNT_INPUT':
      case 'ENGINE_ROUNDING_CONFLICT':
        return new ZatcaHttpError('ZATCA_AMOUNTS', { subcode: err.code, issues: [...err.issues], logDetail });
      default: {
        const mapped = preflightHttpError(err.issues);
        if (mapped) return new ZatcaHttpError(mapped.code, { messageAr: mapped.messageAr, issues: mapped.issues, logDetail });
        return new ZatcaHttpError('ZATCA_PREFLIGHT', { issues: [...err.issues], logDetail });
      }
    }
  }
  if (err instanceof StampError) return stampHttpError(err);
  if (err instanceof FatooraInputError) return new ZatcaHttpError('ZATCA_INTERNAL', { logDetail: { source: 'FatooraInputError', code: err.field } });
  if (err instanceof SecretsError) return unitUnavailableError('SECRETS', { source: 'SecretsError', code: err.code });
  const code = err && typeof err === 'object' ? (err as { code?: unknown }).code : undefined;
  if (code === 'P2002' && isChainUniqueViolation(err)) return new ZatcaHttpError('ZATCA_CHAIN_CONFLICT', { logDetail: { source: 'P2002', code: prismaTarget((err as { meta?: unknown }).meta).join(',').slice(0, 120) || null } });
  if (code === 'P2028') return new ZatcaHttpError('ZATCA_UNIT_BUSY', { logDetail: { source: 'P2028', code: null } });
  return null;
}
