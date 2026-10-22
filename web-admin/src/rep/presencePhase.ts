// مرحلة طلب «أثبت تواجدك» وعدّه التنازلي — صرفٌ بلا متصفّح (PresenceCheck.tsx يعرضه)، يُختبر وحده.

export interface PendingPresence { id: string; sentAt: string; deadline: string; until: string; serverNow: number }

export type PresencePhase = 'onTime' | 'late' | 'expired';

/** مرحلة الطلب بساعة الخادم: الدقيقتان، ثم القبول متأخراً، ثم الانتهاء — ومعها ما بقي من المرحلة */
export function presencePhase(p: Pick<PendingPresence, 'deadline' | 'until'>, serverNow: number): { phase: PresencePhase; leftMs: number } {
  const deadline = Date.parse(p.deadline);
  const until = Date.parse(p.until);
  if (serverNow < deadline) return { phase: 'onTime', leftMs: deadline - serverNow };
  if (serverNow < until) return { phase: 'late', leftMs: until - serverNow };
  return { phase: 'expired', leftMs: 0 };
}

/** «1:45» */
export const mmss = (ms: number): string => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
