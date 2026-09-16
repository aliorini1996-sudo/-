import { Response, NextFunction, RequestHandler } from 'express';
import { Prisma } from '@prisma/client';
import { isLedgerError, LEDGER_ERROR_HTTP, type LedgerErrorCode } from '../../services/gl/types';
import { isGlNotFoundError } from '../../services/gl/resolve';
import { AuthRequest } from '../../types';

/**
 * ترجمة أخطاء الدفاتر إلى HTTP (ملحق ب) — مشتركة بين موجّهات routes/ledger/*.
 *
 * الشكل: `{success:false, code, message, ...details, details}`. التفاصيل تُنشر بجانب الرمز كما يتوقعها
 * عميل الويب، والمفاتيح المحجوزة (success/code/message) لا تُكتب فوقها — تبقى كاملة في `details`
 * (مثل `LEDGER_JOURNAL_CODE_CONFLICT {code: 'INV'}`).
 * - LedgerError ⇒ httpStatus ورمزه.
 * - GlNotFoundError ⇒ 404 (العزل §9.4: معرّف لا ينتمي للشركة كغير الموجود).
 * - LedgerHttpError ⇒ حالة المسار المحلية (قيود تحرير بلا رمز في ملحق ب، بـreason).
 * - Prisma P2002 ⇒ 409 (سباق على قيد فريد).
 * غير ذلك (ومنه ZodError) يمرّ إلى errorHandler العام.
 */

/** رسائل عربية مختصرة لكل رمز — الواجهة تترجم بالرمز، والرسالة احتياط. */
export const LEDGER_ERROR_MESSAGES: Readonly<Partial<Record<LedgerErrorCode, string>>> = {
  ACCOUNTING_SUITE_NOT_ALLOWED: 'النظام المحاسبي المتكامل غير مفعّل لهذه الشركة تواصل مع مزود الخدمة',
  LEDGER_PERMISSION_DENIED: 'لا تملك صلاحية الوصول لهذا القسم',
  LEDGER_SCOPED_ADMIN: 'الدفاتر على مستوى الشركة كلها وحسابك مقيد بنطاق محدد',
  LEDGER_NOT_SETUP: 'الإعداد المبدئي للدفاتر لم يكتمل بعد',
  LEDGER_UNBALANCED: 'القيد غير متوازن',
  LEDGER_PERIOD_LOCKED: 'التاريخ ضمن فترة مقفلة',
  LEDGER_CONTROL_ACCOUNT_MANUAL: 'لا يجوز استعمال حساب رئيسي في قيد يدوي',
  LEDGER_ACCOUNT_ARCHIVED: 'الحساب مؤرشف',
  LEDGER_ACCOUNT_NOT_FOUND: 'الحساب غير موجود',
  LEDGER_PARTNER_REQUIRED: 'سطر الذمم يتطلب تحديد الشريك',
  LEDGER_OFF_BALANCE_MIXED: 'لا يجوز خلط حسابات خارج الميزانية بغيرها',
  LEDGER_LOCK_DATE_BACKWARD: 'تاريخ الإقفال النهائي لا يتراجع',
  LEDGER_DRAFTS_BEFORE_LOCK: 'توجد مسودات قبل تاريخ الإقفال',
  LEDGER_SECURED_MOVE: 'القيد مؤمَّن',
  LEDGER_MOVE_NOT_DRAFT: 'القيد ليس مسودة',
  LEDGER_MOVE_DOCUMENT_OWNED: 'المسودة مرتبطة بمستند وتُزال من مستندها',
  LEDGER_SOURCE_OWNED_MOVE: 'القيد مملوك لمستند مصدر ويُلغى من مستنده',
  LEDGER_SYNC_PENDING: 'الترحيل الآلي متأخر عن التاريخ المطلوب',
  LEDGER_JOURNAL_HAS_POSTED_MOVES: 'لا يتغير رمز الدفتر ولا نمط ترقيمه بعد أول ترحيل',
  LEDGER_JOURNAL_CODE_CONFLICT: 'رمز الدفتر يتعارض مع دفتر آخر',
  LEDGER_REVERSAL_REASON_REQUIRED: 'سبب العكس مطلوب',
  LEDGER_NAME_ARABIC_REQUIRED: 'الاسم يجب أن يحوي حرفاً عربياً والاسم بلغة أخرى مكانه الاسم الإنجليزي',
  LEDGER_VAT_LINE_UNTAGGED: 'سطر الضريبة يتطلب تحديد الضريبة ومربع الإقرار',
  LEDGER_EXPORT_TOO_LARGE: 'التصدير يتجاوز الحد المسموح',
  LEDGER_ATTACHMENT_QUOTA: 'تجاوزت سقف المرفقات',
};

/** خطأ مسار محلي بحالة HTTP صريحة (قيود تحرير لا رمز لها في ملحق ب) — يُحمل سببه في reason. */
export class LedgerHttpError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly details: Readonly<Record<string, unknown>>;
  constructor(status: number, message: string, details: Record<string, unknown> = {}, code: string | null = null) {
    super(message);
    this.name = 'LedgerHttpError';
    this.status = status;
    this.code = code;
    this.details = details;
    Object.setPrototypeOf(this, LedgerHttpError.prototype);
  }
}

const RESERVED = new Set(['success', 'code', 'message']);

function spread(details: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(details)) if (!RESERVED.has(k)) out[k] = v;
  return out;
}

/** BigInt في التفاصيل ⇒ نص، فلا ينهار JSON.stringify. */
function jsonSafe<T>(v: T): T {
  return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)));
}

export interface LedgerErrorResponse {
  status: number;
  body: Record<string, unknown>;
}

/** يحوّل الخطأ إلى {status, body} أو null إن لم يكن من أخطاء الدفاتر. صرفة. */
export function ledgerErrorResponse(err: unknown): LedgerErrorResponse | null {
  if (isLedgerError(err)) {
    const details = jsonSafe({ ...err.details });
    return {
      status: LEDGER_ERROR_HTTP[err.code] ?? 422,
      body: { success: false, ...spread(details), code: err.code, message: LEDGER_ERROR_MESSAGES[err.code] ?? err.code, details },
    };
  }
  if (isGlNotFoundError(err)) {
    return { status: 404, body: { success: false, message: 'السجل غير موجود', entity: err.entity, id: err.id } };
  }
  if (err instanceof LedgerHttpError) {
    const details = jsonSafe({ ...err.details });
    return {
      status: err.status,
      body: { success: false, ...spread(details), ...(err.code ? { code: err.code } : {}), message: err.message, details },
    };
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    return { status: 409, body: { success: false, message: 'السجل موجود مسبقا', target: (err.meta as { target?: unknown } | undefined)?.target ?? null } };
  }
  return null;
}

/** يرد بخطأ الدفاتر إن كان كذلك، وإلا يمرّره إلى next (errorHandler العام). */
export function handleLedgerError(err: unknown, res: Response, next: NextFunction): void {
  const r = ledgerErrorResponse(err);
  if (r) { res.status(r.status).json(r.body); return; }
  next(err);
}

/** يلفّ معالجاً غير متزامن: أي خطأ ⇒ handleLedgerError. */
export function ledgerHandler(fn: (req: AuthRequest, res: Response) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    fn(req as AuthRequest, res).catch((err) => handleLedgerError(err, res, next));
  };
}
