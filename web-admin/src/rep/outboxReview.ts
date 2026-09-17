/**
 * فوترة ZATCA المرحلة الثانية (Z5.0، خامل حتى Z5.8) — مستندات الصفّ الصادر «قيد مراجعة الإدارة» وحالة الجهاز للنبضة.
 * نقيّ (بلا IndexedDB ولا شبكة) كي يُختبر.
 *
 *  • ZATCA_CUTOVER_REVIEW: مستند دون اتصال من قبل التفعيل يردّه الخادم للمراجعة. ليس رفض أعمال ولا عطل ميزة: يبقى مصفوفاً،
 *    والمزامنة **تتابع** المستند التالي (نقد الخطة 3 — لا توقّف يحبس سندات القبض والزيارات والتقارير خلفه)، ولا يُسأل الخادم
 *    عنه مجدداً قبل مهلة، ولا زرّ «إزالة» له.
 *  • حالة الجهاز للنبضة: كل مستندات الجهاز غير المرفوعة (منتظرة أو مرفوضة) **لكل المناديب** على الجهاز — لا مستندات صاحب
 *    الجلسة وحده (نقد الخطة 23: جهاز مشترك يُخفي صفّ الزميل)؛ والضريبية = الفواتير والمرتجعات.
 */
import type { OutboxDoc } from './offlineDb';

export const CUTOVER_REVIEW_CODE = 'ZATCA_CUTOVER_REVIEW';
export const REVIEW_RECHECK_MS = 10 * 60 * 1000;

/** يُرفع الآن؟ مستند قيد المراجعة لا يُعاد إرساله قبل مرور المهلة على آخر سؤال. */
export function reviewRecheckDue(doc: Pick<OutboxDoc, 'reviewCode' | 'reviewCheckedAt'>, nowMs: number): boolean {
  if (doc.reviewCode !== CUTOVER_REVIEW_CODE) return true;
  const at = doc.reviewCheckedAt ? Date.parse(doc.reviewCheckedAt) : NaN;
  return !Number.isFinite(at) || nowMs - at >= REVIEW_RECHECK_MS;
}

/** قيد مراجعة الإدارة (للوسم وإخفاء «إزالة») — المصفوف وحده: المرفوض أو المرفوع خرج من المراجعة ولو بقي وسم قديم. */
export function underCutoverReview(doc: Pick<OutboxDoc, 'reviewCode'> & Partial<Pick<OutboxDoc, 'status'>>): boolean {
  return doc.reviewCode === CUTOVER_REVIEW_CODE && doc.status !== 'rejected' && doc.status !== 'sent';
}

/** مستند يخرج من المراجعة (رُفع، أو رُفض، أو أُعيد للصفّ يدوياً): بلا وسمها — فلا تُخفى «إزالة» عن مرفوض ولا يُوسم المُعاد «قيد مراجعة». */
export function clearReview<T extends Pick<OutboxDoc, 'reviewCode' | 'reviewCheckedAt'>>(doc: T): T {
  return { ...doc, reviewCode: undefined, reviewCheckedAt: undefined };
}

export interface HeartbeatPayload {
  bundle: string;
  outboxPending?: number;
  outboxTaxPending?: number;
}

/** جسم النبضة: الحزمة دائماً، والعدّان حين قُرئ الصفّ (null = تعذّرت القراءة ⇒ لا عدّ كاذب). */
export function heartbeatPayload(bundle: string, docs: ReadonlyArray<Pick<OutboxDoc, 'kind' | 'status'>> | null): HeartbeatPayload {
  if (!docs) return { bundle };
  const unsent = docs.filter((d) => d.status !== 'sent');
  return { bundle, outboxPending: unsent.length, outboxTaxPending: unsent.filter((d) => d.kind === 'invoice').length };
}
