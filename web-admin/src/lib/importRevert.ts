// تجميع «المتبقي» بعد التراجع الجزئي عن دفعة استيراد حسب السبب (blocked[].reason من الخادم):
// المحمي بمعاملات حقيقية لا يُعاد، أما انشغال قفل الدفاتر أو خطأ الحذف العابر فيُعاد لاحقاً.
import { errorDetail, errorResponseOf } from './importData';

/** نص الخادم حرفياً (backend/src/services/importLedger.ts LEDGER_BUSY_MESSAGE) */
export const REVERT_LEDGER_BUSY = 'جارٍ تفعيل الدفاتر، أعد المحاولة';
/** بادئة خطأ الحذف العابر («تعذّر الحذف: <رسالة>») — مفتاح ثابت لا يمرّر نص الخطأ الخام عبر tr */
export const REVERT_DELETE_FAILED = 'تعذّر الحذف';
/** سبب غائب من خادم قديم */
export const REVERT_PROTECTED_FALLBACK = 'سجل محمي';

export interface RevertBlockedItem { id?: string; name?: string | null; reason?: string }
export interface RevertGroup {
  /** مفتاح عربي يُمرَّر عبر tr() */
  key: string;
  /** يُعاد لاحقاً (قفل الدفاتر أو خطأ عابر) لا محمي */
  retry: boolean;
  count: number;
  names: string[];
}

export function revertReasonKey(reason: string | undefined): { key: string; retry: boolean } {
  const r = String(reason ?? '').trim();
  if (!r) return { key: REVERT_PROTECTED_FALLBACK, retry: false };
  if (r === REVERT_LEDGER_BUSY) return { key: REVERT_LEDGER_BUSY, retry: true };
  if (r.startsWith(REVERT_DELETE_FAILED)) return { key: REVERT_DELETE_FAILED, retry: true };
  return { key: r, retry: false };
}

/** تجميع بترتيب الظهور: المحمي أولاً ثم ما يُعاد */
export function groupRevertBlocked(list: readonly RevertBlockedItem[]): RevertGroup[] {
  const map = new Map<string, RevertGroup>();
  for (const b of list) {
    const { key, retry } = revertReasonKey(b?.reason);
    let g = map.get(key);
    if (!g) { g = { key, retry, count: 0, names: [] }; map.set(key, g); }
    g.count++;
    if (b?.name) g.names.push(b.name);
  }
  const groups = [...map.values()];
  return [...groups.filter((g) => !g.retry), ...groups.filter((g) => g.retry)];
}

// ═══ حالة الدفعة في سجل الاستيرادات (GET /import/batches status) ═══

export type ImportBatchStatus = 'running' | 'interrupted' | 'done';
export const BATCH_RUNNING_LABEL = 'قيد الاستيراد';
export const BATCH_INTERRUPTED_LABEL = 'انقطع';

export interface BatchStatusView {
  status: ImportBatchStatus;
  /** وسم عربي يُمرَّر عبر tr (null للمنتهية) */
  label: string | null;
  /** التراجع متاح: الجارية 409 IMPORT_BATCH_RUNNING، والمنقطعة يُتراجع عمّا سُجّل منها */
  revertable: boolean;
  /** العدد نهائي — الجارية تُحفظ دفعات، والمنقطعة ما سُجّل منها قبل الانقطاع */
  countFinal: boolean;
}

/** status غائب (خادم أقدم أو دفعة ما قبل الحجز) أو غير معروف ⇒ منتهية */
export function batchStatusView(b: { status?: string | null }): BatchStatusView {
  if (b.status === 'running') return { status: 'running', label: BATCH_RUNNING_LABEL, revertable: false, countFinal: false };
  if (b.status === 'interrupted') return { status: 'interrupted', label: BATCH_INTERRUPTED_LABEL, revertable: true, countFinal: false };
  return { status: 'done', label: null, revertable: true, countFinal: true };
}

/** إعادة جلب السجل ما دامت فيه دفعة جارية */
export const hasRunningBatch = (list: readonly { status?: string | null }[] | undefined): boolean =>
  !!list?.some((b) => batchStatusView(b).status === 'running');

// ═══ تصنيف فشل التراجع (صرف) ═══

/** نص الخادم حرفياً (importLedger.ts OPENING_STOCK_REVERT_LEDGER_ACTIVE_MESSAGE) */
export const OPENING_STOCK_REVERT_ACTIVE = 'الدفاتر مفعّلة: المخزون الافتتاحي دخل القيد الافتتاحي فلا يُتراجع عنه — صحّحه بتسوية مستودع';
export const REVERT_BATCH_RUNNING = 'الدفعة ما زالت قيد الاستيراد — انتظر انتهاءها ثم تراجع عنها';
export const REVERT_BATCH_GONE = 'الدفعة غير موجودة أو متراجع عنها';
export const NETWORK_LOST_MESSAGE = 'انقطع الاتصال قبل وصول رد الخادم وقد تكون العملية تمت. تحقق من سجل الاستيرادات قبل إعادة المحاولة';

export type RevertFailure =
  | { type: 'network' }
  | { type: 'running'; batchId?: string }
  | { type: 'ledgerBusy' }
  | { type: 'openingStockActive' }
  | { type: 'gone' }
  | { type: 'other'; message?: string };

export function classifyRevertFailure(e: unknown): RevertFailure {
  const { status, body: b, network } = errorResponseOf(e);
  if (network) return { type: 'network' };
  switch (b.code) {
    case 'IMPORT_BATCH_RUNNING': return { type: 'running', batchId: typeof errorDetail(b, 'batchId') === 'string' ? errorDetail(b, 'batchId') as string : undefined };
    case 'IMPORT_REVERT_LEDGER_BUSY': return { type: 'ledgerBusy' };
    case 'OPENING_STOCK_REVERT_LEDGER_ACTIVE': return { type: 'openingStockActive' };
  }
  if (status === 404) return { type: 'gone' };
  return { type: 'other', message: typeof b.message === 'string' ? b.message : undefined };
}

/** المفتاح العربي (يُمرَّر عبر tr) لرسالة فشل التراجع؛ other بلا رسالة ⇒ null (الافتراضي «تعذر التراجع») */
export function revertFailureKey(f: RevertFailure): string | null {
  switch (f.type) {
    case 'network': return NETWORK_LOST_MESSAGE;
    case 'running': return REVERT_BATCH_RUNNING;
    case 'ledgerBusy': return REVERT_LEDGER_BUSY;
    case 'openingStockActive': return OPENING_STOCK_REVERT_ACTIVE;
    case 'gone': return REVERT_BATCH_GONE;
    default: return null;
  }
}
