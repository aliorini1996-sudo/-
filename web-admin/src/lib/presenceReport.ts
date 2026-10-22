// نتائج «التحقق العشوائي من التواجد» في تقرير ساعات العمل (طلب المالك، ٢٢ أكتوبر ٢٠٢٦؛ الخادم: services/presenceChecks.ts
// وGET /attendance-admin/presence) — صرفٌ يُختبر وحده.

export type PresenceStatus = 'SENT' | 'PASSED' | 'LATE' | 'MISSED' | 'SKIPPED';

export interface PresenceRow {
  /** يوم المندوب (يوم حضور النوبة) — يومُ صفّه في تقرير ساعات العمل */
  day?: string;
  id: string; salesRepId: string; status: PresenceStatus;
  dueAt: string; sentAt: string | null; respondedAt: string | null; delaySec: number | null;
  lat: number | null; lng: number | null; accuracy: number | null; distanceM: number | null;
  device: string | null; otherDevice: boolean | null; pushSent: number | null;
}

/** يومٌ محليّ بتوقيت المتصفّح — كأيام تقرير ساعات العمل (tz المتصفّح) */
export function localDate(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * التحققات لكل مندوب ويوم: `${salesRepId}|${YYYY-MM-DD}` بيوم المندوب (يوم حضور نوبته) كتقرير ساعات العمل — نوبةٌ مسائية
 * تعبر منتصف الليل تُنسب ليومها لا ليوم الإرسال. خادمٌ أقدم بلا day: بيوم الإرسال
 */
export function presenceByRepDay(rows: readonly PresenceRow[]): Map<string, PresenceRow[]> {
  const m = new Map<string, PresenceRow[]>();
  for (const r of rows) {
    const k = `${r.salesRepId}|${r.day ?? localDate(r.sentAt ?? r.dueAt)}`;
    const a = m.get(k) ?? [];
    a.push(r);
    m.set(k, a);
  }
  return m;
}

export interface PresenceSummary {
  asked: number; onTime: number; late: number; missed: number; pending: number;
  /** ردٌّ بلا موقع، وردٌّ من غير الجهاز المربوط، وطلبٌ لم يصل إشعاره جهازه */
  noFix: number; otherDevice: number; noPush: number;
  tone: 'good' | 'warn' | 'bad';
}

/** ملخّص اليوم: ما أُرسل (لا ما سقط قبل إرساله)، وفي الوقت منه — والنبرة: بلا ردّ أحمر، ومتأخر أو بلا موقع أو من جهازٍ آخر كهرماني */
export function presenceSummary(rows: readonly PresenceRow[]): PresenceSummary {
  const sent = rows.filter((r) => r.status !== 'SKIPPED');
  const onTime = sent.filter((r) => r.status === 'PASSED').length;
  const late = sent.filter((r) => r.status === 'LATE').length;
  const missed = sent.filter((r) => r.status === 'MISSED').length;
  const pending = sent.filter((r) => r.status === 'SENT').length;
  const answered = sent.filter((r) => r.status === 'PASSED' || r.status === 'LATE');
  const noFix = answered.filter((r) => r.lat == null).length;
  const otherDevice = answered.filter((r) => r.otherDevice === true).length;
  const noPush = sent.filter((r) => r.pushSent === 0).length;
  return {
    asked: sent.length, onTime, late, missed, pending, noFix, otherDevice, noPush,
    tone: missed ? 'bad' : late || noFix || otherDevice ? 'warn' : 'good',
  };
}

/** حالة التحقق كما تُعرض */
export function presenceStatusText(r: Pick<PresenceRow, 'status'>, tr: (s: string) => string): string {
  switch (r.status) {
    case 'PASSED': return tr('في الوقت');
    case 'LATE': return tr('متاخر');
    case 'MISSED': return tr('بلا رد');
    case 'SENT': return tr('بانتظار الرد');
    default: return tr('سقط خارج نوبته');
  }
}
