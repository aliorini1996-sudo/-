import { ledgerConfigCodeLabels, ledgerConfigReasonLabels } from './labels';

/**
 * نصوص أخطاء الدفاتر المترجمة (صرفة، مختبَرة في errors.test.ts) — نداءات tr حرفية.
 *
 * الترتيب: تسمية السبب (`reason` من الجسم أو details) ← تسمية الرمز (ملحق ب) ← نص عام بحسب حالة HTTP.
 * **رسالة الخادم لا تُعرض**: هي عربية دائماً فتتسرّب إلى واجهة en/fr/tr/zh (ومنها ZodError 400 من errorHandler العام).
 * كل سبب يرده الخادم تحت routes/ledger وservices/gl إما له تسمية هنا أو في LEDGER_REASONS_CODE_TEXT (نص رمزه دقيق)
 * أو LEDGER_REASONS_INTERNAL (لا يصل للواجهة) — حارس errors.test يمسح الخادم.
 */

type Tr = (ar: string) => string;

/** أسباب القيود والمرفقات والمفضلات والتصدير التي يضلّل فيها نص رمزها وحده. */
export const ledgerMoveReasonLabels = (tr: Tr): Record<string, string> => ({
  NOT_POSTED: tr('القيد غير مرحّل فلا يُعكس'),
  ALREADY_REVERSED: tr('القيد معكوس مسبقا'),
  NOT_FOUND: tr('السجل غير موجود'),
  RACE: tr('تغيّر القيد أثناء التنفيذ، أعد المحاولة'),
  INVALID_AMOUNT: tr('مبلغ غير صالح'),
  AMOUNT_PRECISION: tr('المبلغ فيه منازل عشرية أكثر مما تسمح به العملة'),
  TOO_FEW_LINES: tr('القيد يحتاج سطرين على الأقل'),
  ZERO_LINE_NOT_MARKER: tr('سطر بلا مبلغ'),
  DEBIT_AND_CREDIT: tr('السطر لا يحمل مدينا ودائنا معا'),
  NEGATIVE_AMOUNT: tr('المبلغ لا يكون سالبا'),
  MARKER_WITH_AMOUNT: tr('سطر علامة الضريبة لا يحمل مبلغا'),
  MARKER_WITHOUT_TAX: tr('سطر علامة الضريبة يتطلب ضريبة'),
  MARKER_NONZERO_RATE: tr('سطر علامة الضريبة لضريبة صفرية وحدها'),
  MARKER_WITHOUT_BASE: tr('سطر علامة الضريبة يتطلب وعاء'),
  TAX_NOT_FOUND: tr('الضريبة غير موجودة'),
  TAX_ARCHIVED: tr('الضريبة مؤرشفة'),
  JOURNAL_NOT_FOUND: tr('الدفتر غير موجود'),
  JOURNAL_ARCHIVED: tr('الدفتر مؤرشف'),
  INVALID_DATE: tr('تاريخ غير صالح'),
  BEFORE_ORIGINAL_DATE: tr('تاريخ العكس لا يسبق تاريخ القيد الأصلي'),
  LOCK_DATE_IN_FUTURE: tr('لا يجوز تاريخ إقفال في المستقبل'),
  INVALID_SCREEN: tr('شاشة المفضلة غير صالحة'),
  FILTER_TOO_LARGE: tr('المفضلة أكبر من المسموح'),
  UNSUPPORTED_FORMAT: tr('صيغة التصدير غير مدعومة'),
  UNKNOWN_LIST: tr('قائمة التصدير غير معروفة'),
  LIST_NOT_AVAILABLE: tr('هذه القائمة غير متاحة للتصدير بعد'),
  ATTACHMENT_TYPE_NOT_ALLOWED: tr('نوع الملف غير مدعوم — PDF أو صورة فقط'),
  INVALID_BASE64: tr('محتوى المرفق غير صالح'),
  EMPTY_FILE: tr('الملف فارغ'),
  FILE_TOO_LARGE: tr('الملف أكبر من الحجم المسموح للمرفق الواحد'),
  MONTHLY_QUOTA: tr('تجاوزت شركتك سقف المرفقات الشهري'),
  TOTAL_QUOTA: tr('تجاوزت شركتك سقف المرفقات'),
  CHECK_NOT_ADJUSTABLE: tr('قيد التصحيح متاح لفحوص ذمم العملاء والعهدة والأمانات وحدها'),
  LEDGER_WORKER_UNAVAILABLE: tr('معالج الترحيل غير متاح حاليا'),
  STATUS_CHANGED: tr('تغيّرت حالة الحدث، أعد التحميل'),
});

/** أسباب نص رمزها دقيق (لا تحتاج تسمية). */
export const LEDGER_REASONS_CODE_TEXT = [
  'ACCOUNT_ARCHIVED', 'ACCOUNT_NOT_FOUND', 'CONTROL_ACCOUNT_MANUAL', 'CUSTOMER_REQUIRED', 'VENDOR_REQUIRED',
  'OFF_BALANCE_MIXED', 'UNBALANCED', 'VAT_LINE_UNTAGGED', 'NOT_ACTIVATED',
] as const;

/** أسباب داخلية لا تصل جسم خطأ في الواجهة (فحص سلسلة التدقيق، تخطي المجدول، قيد صفري آلي). */
export const LEDGER_REASONS_INTERNAL = ['HASH', 'PREV_HASH', 'SEQ_GAP', 'SUITE_OFF', 'ZERO_VALUE'] as const;

export const ledgerReasonLabels = (tr: Tr): Record<string, string> => ({ ...ledgerConfigReasonLabels(tr), ...ledgerMoveReasonLabels(tr) });

/** نص عام بحسب حالة HTTP حين لا رمز ولا سبب معروف. */
export function ledgerStatusText(tr: Tr, status: number | null | undefined): string {
  switch (status) {
    case 400: return tr('بيانات غير صالحة');
    case 404: return tr('السجل غير موجود');
    case 413: return tr('الحجم أكبر من المسموح');
    case 429: return tr('طلبات كثيرة، حاول بعد قليل');
    default: return tr('تعذر تنفيذ الإجراء');
  }
}

/**
 * نص مترجم لرمز رفض/خطأ من الدفاتر. `reason` يسبق الرمز حين له تسمية. `fallback` نص **مترجم** مسبقاً
 * (لا رسالة الخادم) — استعمل ledgerErrorMessage لجسم خطأ كامل.
 */
export function ledgerErrorText(tr: Tr, code: string | null | undefined, fallback?: string | null, reason?: unknown): string {
  if (typeof reason === 'string') {
    const label = ledgerReasonLabels(tr)[reason];
    if (label) return label;
  }
  switch (code) {
    case 'LEDGER_NOT_SETUP': return tr('الترحيل متاح بعد اكتمال الإعداد المبدئي للدفاتر');
    case 'LEDGER_MOVE_NOT_DRAFT': return tr('القيد ليس مسودة');
    case 'LEDGER_SOURCE_OWNED_MOVE': return tr('القيد مملوك لمستند مصدر ويُلغى من مستنده');
    case 'LEDGER_MOVE_DOCUMENT_OWNED': return tr('المسودة مرتبطة بمستند وتُزال من مستندها');
    case 'LEDGER_SECURED_MOVE': return tr('القيد مؤمَّن');
    case 'LEDGER_UNBALANCED': return tr('القيد غير متوازن');
    case 'LEDGER_PERIOD_LOCKED': return tr('التاريخ ضمن فترة مقفلة');
    case 'LEDGER_CONTROL_ACCOUNT_MANUAL': return tr('لا يجوز استعمال حساب رئيسي في قيد يدوي');
    case 'LEDGER_ACCOUNT_ARCHIVED': return tr('الحساب مؤرشف');
    case 'LEDGER_ACCOUNT_NOT_FOUND': return tr('الحساب غير موجود');
    case 'LEDGER_PARTNER_REQUIRED': return tr('سطر الذمم يتطلب تحديد الشريك');
    case 'LEDGER_VAT_LINE_UNTAGGED': return tr('سطر الضريبة يتطلب تحديد الضريبة ومربع الإقرار');
    case 'LEDGER_OFF_BALANCE_MIXED': return tr('لا يجوز خلط حسابات خارج الميزانية بغيرها');
    case 'LEDGER_REVERSAL_REASON_REQUIRED': return tr('سبب العكس مطلوب');
    case 'LEDGER_EXPORT_TOO_LARGE': return tr('التصدير يتجاوز الحد المسموح');
    case 'LEDGER_ATTACHMENT_QUOTA': return tr('تجاوزت شركتك سقف المرفقات');
    case 'LEDGER_PERMISSION_DENIED': return tr('لا تملك صلاحية الوصول لهذا القسم');
    case 'RATE_LIMITED': return tr('طلبات كثيرة، حاول بعد قليل');
    case 'NOT_FOUND': return tr('القيد غير موجود');
    default: {
      // رموز المعالج خارج ملحق ب (LEDGER_IMPORT_IN_PROGRESS وLEDGER_OPENING_STOCK_* …) حين يغيب السبب
      const label = code ? ledgerConfigCodeLabels(tr)[code] : undefined;
      return label || fallback || tr('تعذر تنفيذ الإجراء');
    }
  }
}

export interface LedgerErrorLike {
  code?: string | null;
  reason?: unknown;
  details?: Record<string, unknown> | null;
  status?: number;
}

/** جسم خطأ كامل (ledgerErrorOf) ⇒ نص مترجم بلا رسالة الخادم. */
export function ledgerErrorMessage(tr: Tr, e: LedgerErrorLike | null | undefined): string {
  const reason = typeof e?.reason === 'string' ? e.reason : typeof e?.details?.reason === 'string' ? e.details.reason : undefined;
  return ledgerErrorText(tr, e?.code, ledgerStatusText(tr, e?.status), reason);
}
