import { RECEIPT_TOUCHES } from './receiptEffects';

/**
 * سياسة التحديث اللحظيّ — نقيّة بلا React ولا متصفّح، فتُختبر في node.
 * يستعملها `liveInvoices.ts`.
 */

/** ما يعرض المدفوع/المتبقي أو السند نفسه — يُقرأ فوراً إن كان ظاهراً */
export const LIVE_REFETCH: readonly (readonly string[])[] = [
  ['invoices'],
  ['receipts'],
  ['m-docs', 'invoice'],
  ['m-docs', 'receipt'],
  ['m-doc'],
  ['open-invoices'],
  ['m-rcp-invoices'],
  ['statement'],
  ['m-statement'],
  ['rep-statement'],
];

const key = (k: readonly string[]) => k.join('/');
const REFETCH_SET = new Set(LIVE_REFETCH.map(key));

/**
 * بقيّة ما يمسّه السند (لوحة التحكم، أرصدة العملاء) — يُوسَم قديماً بلا قراءة،
 * فيُقرأ حين يُفتح. الحدث يصل كل شاشة مفتوحة في الشركة، ولوحة التحكم وحدها
 * إحدى عشرة استعلاماً على قاعدةٍ هي العنق الضيّق.
 */
export const LIVE_MARK_STALE: readonly (readonly string[])[] =
  RECEIPT_TOUCHES.filter(k => !REFETCH_SET.has(key(k)));

const RATE_LIMIT_MAX_WAIT = 15 * 60_000;

/**
 * هل رفضٌ نهائيّ لا يُعاد؟ جلسةٌ منتهية أو حسابٌ بلا شركة أو دورٌ لا يستمع.
 * أمّا 429 (محدّد المعدّل المشترك لعنوان IP) و404 (الواجهة نُشرت قبل الخادم)
 * و408 و5xx فعابرة: الإيقاف عندها يُسكت التحديث بقيّة الجلسة دون علم أحد.
 */
export function isFinalRejection(status: number): boolean {
  return status === 400 || status === 401 || status === 403;
}

/** مهلة ما بعد 429 — ما يطلبه الخادم (Retry-After بالثواني) ولا أقلّ من التراجع الجاري */
export function rateLimitWait(retryAfter: string | null, backoff: number): number {
  const s = Number(retryAfter);
  if (!Number.isFinite(s) || s <= 0) return backoff;
  return Math.min(Math.max(backoff, s * 1000), RATE_LIMIT_MAX_WAIT);
}
