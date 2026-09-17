/**
 * إجراءات الأدمن على أحداث الترحيل الآلي (M3، DESIGN.md §2.5، §5.4، §9.3، ملحق أ `/events/:id/retry|skip|release`) — صرفة.
 *
 * - retry (EVENT_RETRY): ERROR (ومنه النهائي بعد خمس محاولات) أو BLOCKED ⇒ PENDING فوراً بعدّاد محاولات صفري.
 * - release (EVENT_HOLD_RELEASE): HELD (بعد إصلاح الربط أو العملة) ⇒ PENDING.
 * - skip (EVENT_SKIP): أي حالة غير نهائية ⇒ SKIPPED(MANUAL) بسبب مكتوب إلزامي. يزيل عمداً ما لا يُرحَّل أبداً
 *   (مثل HELD(CURRENCY_MISMATCH)) فلا يعطّل الإقفال، وبوابة الأشقاء تُسقط عكسه SKIPPED(MANUAL) (§5.4).
 * المسار ينفّذ الكتابة تحت قفل gl-post وبشرط الحالة المقروءة (updateMany)، فلا يسبقه المُرحِّل.
 */
import type { EventStatus, SourceEventPatch } from '../sync/types';

export const EVENT_ACTIONS = ['retry', 'skip', 'release'] as const;
export type EventAction = (typeof EVENT_ACTIONS)[number];

export function isEventAction(v: unknown): v is EventAction {
  return typeof v === 'string' && (EVENT_ACTIONS as readonly string[]).includes(v);
}

export const EVENT_ACTION_ALLOWED: Readonly<Record<EventAction, readonly EventStatus[]>> = {
  retry: ['ERROR', 'BLOCKED'],
  release: ['HELD'],
  skip: ['PENDING', 'BLOCKED', 'ERROR', 'HELD'],
};

export const EVENT_ACTION_AUDIT: Readonly<Record<EventAction, string>> = {
  retry: 'EVENT_RETRY',
  release: 'EVENT_HOLD_RELEASE',
  skip: 'EVENT_SKIP',
};

export type EventActionPlan =
  | { ok: true; patch: SourceEventPatch; onlyIfStatus: EventStatus }
  | { ok: false; reason: 'STATUS_NOT_ALLOWED' | 'REASON_REQUIRED'; allowed: readonly EventStatus[] };

export function planEventAction(action: EventAction, status: string, input: { reason?: unknown; now: Date }): EventActionPlan {
  const allowed = EVENT_ACTION_ALLOWED[action];
  if (!(allowed as readonly string[]).includes(status)) return { ok: false, reason: 'STATUS_NOT_ALLOWED', allowed };
  const st = status as EventStatus;
  switch (action) {
    case 'retry':
    case 'release':
      return { ok: true, onlyIfStatus: st, patch: { status: 'PENDING', attempts: 0, nextAttemptAt: null, lastError: null } };
    case 'skip': {
      const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
      if (!reason) return { ok: false, reason: 'REASON_REQUIRED', allowed };
      return {
        ok: true, onlyIfStatus: st,
        patch: { status: 'SKIPPED', skipReason: 'MANUAL', processedAt: input.now, nextAttemptAt: null, lastError: `SKIPPED_BY_ADMIN|${reason.slice(0, 500)}` },
      };
    }
  }
}
