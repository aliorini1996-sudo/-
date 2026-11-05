/**
 * فاتورةٌ دون اتصال تتجاوز مخزون السيارة لمندوبٍ بلا «البيع بدون مخزون» (مراجعة المخزون نوفمبر ٢٠٢٦، البند ٥ — قرار المالك D5).
 *
 * سُلّمت بضاعتها وطُبعت ورقتها، فلا يُعدمها الصندوق: الخادم يردّ إعادة رفعها 409 VAN_STOCK_REPLAY_HELD (لا 403) ويُشعر الإدارة لتسجّل
 * التحميل الناقص، والصندوق يبقيها مصفوفةً بوسم «بانتظار الإدارة» كحجز اللوط (LOT_REPLAY_HELD)، ولا يسأل عنها قبل المهلة نفسها.
 * نقيّ (بلا IndexedDB ولا شبكة) كي يُختبر.
 */
import type { OutboxDoc } from './offlineDb';
import { REVIEW_RECHECK_MS } from './outboxReview';

/** رمز الحجز كما يرسله الخادم (backend/src/services/repSaleStock.ts) */
export const VAN_STOCK_REPLAY_HELD_CODE = 'VAN_STOCK_REPLAY_HELD';

/** محجوزٌ بانتظار الإدارة — المصفوف وحده: المرفوع أو المرفوض خرج من الحجز ولو بقي وسمٌ قديم */
export function underVanStockHeld(doc: Pick<OutboxDoc, 'reviewCode'> & Partial<Pick<OutboxDoc, 'status'>>): boolean {
  return doc.reviewCode === VAN_STOCK_REPLAY_HELD_CODE && doc.status !== 'rejected' && doc.status !== 'sent';
}

/** يُرفع الآن؟ المحجوز لا يُسأل عنه قبل مرور المهلة على آخر سؤال — وغيره دائماً */
export function vanStockHeldRecheckDue(doc: Pick<OutboxDoc, 'reviewCode' | 'reviewCheckedAt'>, nowMs: number): boolean {
  if (doc.reviewCode !== VAN_STOCK_REPLAY_HELD_CODE) return true;
  const at = doc.reviewCheckedAt ? Date.parse(doc.reviewCheckedAt) : NaN;
  return !Number.isFinite(at) || nowMs - at >= REVIEW_RECHECK_MS;
}
