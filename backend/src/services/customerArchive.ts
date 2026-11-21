/**
 * «أرشيف العميل» (طلب المالك ٢١ نوفمبر ٢٠٢٦): منطق الأرشيف الصرف بلا قاعدة بيانات — routes/customerStudio.ts يقرأ ويمرّر.
 */
import { asVisitLike, mergeVisitsByRep } from './workDay';

export type ArchiveRow = {
  id: string; createdAt: Date; note: string | null; durationSec: number | null; startedAt: Date | null; endedAt: Date | null;
  lat: number | null; lng: number | null; customerId: string; salesRepId: string; salesRep: { name: string } | null; photos: { id: string }[];
};

/**
 * زيارات الأرشيف وقفاتٍ لا سجلّات: تطبيق المندوب يحفظ الزيارة الواحدة سجلَّين — المؤقّت (بمدّته) والملاحظة أو الصور —
 * فتُدمج بالمصدر الوحيد للدمج (services/workDay.ts، ككل شاشة تعرض الزيارات أو تعدّها) وإلا ظهرت الزيارة بطاقتين وتضاعف عدّها.
 * الوقفة تأخذ المؤقّت أساساً (معرّفه وطابعيه ومدّته)، وملاحظاتِ سجلّاتها مجموعةً، وصورَها كلها، ولحظتُها بداية المؤقّت متى وُجد
 */
export function archiveVisits(rows: ArchiveRow[]) {
  return mergeVisitsByRep(rows.map(asVisitLike)).map((m) => {
    const head = m.sources[0];
    const notes = [...new Set(m.sources.map((v) => (v.note || '').trim()).filter(Boolean))];
    return {
      id: head.id, at: m.start, repId: head.salesRepId, rep: head.salesRep?.name ?? null,
      note: notes.length ? notes.join('\n') : null,
      durationSec: m.durationSec, startedAt: head.startedAt, endedAt: head.endedAt,
      lat: m.lat, lng: m.lng, photoIds: m.sources.flatMap((v) => v.photos.map((p) => p.id)),
    };
  }).sort((a, b) => b.at.getTime() - a.at.getTime());
}
