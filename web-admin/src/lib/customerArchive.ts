/**
 * «أرشيف العميل» (طلب المالك ٢١ نوفمبر ٢٠٢٦): منطق السجلّ الزمني الصرف — بلا React، فيُختبر وحده.
 * الواجهة: components/CustomerStudioModal.tsx، والبيانات من GET /customers/:id/studio (routes/customerStudio.ts).
 */

export type ArchiveSource = 'doc' | 'visit' | 'receipt';
export interface ArchiveItem {
  source: ArchiveSource; id: string; at: string; by: string | null;
  kind?: string; byKind?: string; sizeBytes?: number;
  /** رافع الوثيقة (مع byKind) أو مندوب السند — الفرز بالمندوب بمعرّفه لا باسمه (اسمان متطابقان، أو اسمٌ تغيّر) */
  byId?: string | null; repId?: string | null;
  visitId?: string; note?: string | null;
  receiptId?: string; number?: string; cancelled?: boolean;
}
export interface ArchiveVisit {
  id: string; at: string; repId: string; rep: string | null; note: string | null;
  durationSec: number | null; startedAt: string | null; endedAt: string | null;
  lat: number | null; lng: number | null; photoIds: string[];
}

export type ArchiveEntry =
  | { type: 'visit'; key: string; at: string; v: ArchiveVisit; photos: ArchiveItem[] }
  | { type: 'doc'; key: string; at: string; item: ArchiveItem }
  | { type: 'receipt'; key: string; at: string; number?: string; by: string | null; repId?: string | null; cancelled?: boolean; photos: ArchiveItem[] };

const ms = (at: string) => new Date(at).getTime();

/** السجلّ من الزيارات (كلها، بصورٍ أو بلا صور) والوثائق ومرفقات السندات (مجمّعةً بسندها) — صور الزيارة في الشبكة لا تتكرّر هنا */
export function buildEntries(data: { items: ArchiveItem[]; visits?: ArchiveVisit[] }): ArchiveEntry[] {
  const out: ArchiveEntry[] = [];
  for (const v of data.visits ?? []) {
    out.push({
      type: 'visit', key: `v-${v.id}`, at: v.at, v,
      photos: v.photoIds.map((id) => ({ source: 'visit' as const, id, at: v.at, by: v.rep, visitId: v.id, note: v.note })),
    });
  }
  const receipts = new Map<string, Extract<ArchiveEntry, { type: 'receipt' }>>();
  for (const it of data.items) {
    if (it.source === 'doc') out.push({ type: 'doc', key: `d-${it.id}`, at: it.at, item: it });
    else if (it.source === 'receipt' && it.receiptId) {
      const r = receipts.get(it.receiptId);
      if (r) r.photos.push(it);
      else receipts.set(it.receiptId, { type: 'receipt', key: `r-${it.receiptId}`, at: it.at, number: it.number, by: it.by, repId: it.repId, cancelled: it.cancelled, photos: [it] });
    }
  }
  out.push(...receipts.values());
  return out;
}

/**
 * فرز السجلّ: بالمندوب (زياراته، وسنداته، ووثائقٌ رفعها هو من تطبيقه — بالمعرّف) وبنصٍّ يُبحث في الملاحظة واسم المندوب
 * ووصف البند (labelOf: نوع الوثيقة مترجماً، أو رقم السند)
 */
export function filterEntries(list: ArchiveEntry[], opts: { repId?: string; q?: string; labelOf?: (e: ArchiveEntry) => string }): ArchiveEntry[] {
  const needle = (opts.q ?? '').trim().toLowerCase();
  return list.filter((e) => {
    if (opts.repId) {
      const mine = e.type === 'visit' ? e.v.repId === opts.repId
        : e.type === 'receipt' ? e.repId === opts.repId
        : e.item.byKind === 'REP' && e.item.byId === opts.repId;
      if (!mine) return false;
    }
    if (needle) {
      const hay = e.type === 'visit' ? `${e.v.note ?? ''} ${e.v.rep ?? ''}`
        : e.type === 'doc' ? `${opts.labelOf?.(e) ?? ''} ${e.item.by ?? ''}`
        : `${e.number ?? ''} ${e.by ?? ''}`;
      if (!hay.toLowerCase().includes(needle)) return false;
    }
    return true;
  });
}

/** ترتيب السجلّ: الأحدث أولاً أو الأقدم أولاً — والتساوي بالمفتاح فلا يقفز بندٌ بين رسمٍ وآخر */
export function sortEntries(list: ArchiveEntry[], order: 'desc' | 'asc'): ArchiveEntry[] {
  const dir = order === 'desc' ? -1 : 1;
  return [...list].sort((a, b) => (ms(a.at) - ms(b.at)) * dir || a.key.localeCompare(b.key));
}

/** من خدم العميل: لكل مندوب عدد زياراته وأولها وآخرها — الأحدث خدمةً أولاً */
export function repsOf(visits: ArchiveVisit[]) {
  const m = new Map<string, { repId: string; rep: string; count: number; first: string; last: string }>();
  for (const v of visits) {
    const r = m.get(v.repId);
    if (!r) m.set(v.repId, { repId: v.repId, rep: v.rep ?? '—', count: 1, first: v.at, last: v.at });
    else {
      r.count++;
      if (ms(v.at) < ms(r.first)) r.first = v.at;
      if (ms(v.at) > ms(r.last)) r.last = v.at;
    }
  }
  return [...m.values()].sort((a, b) => ms(b.last) - ms(a.last));
}

/** تسلّم المندوب: الزيارة التي اختلف مندوبها عن الزيارة التي قبلها زمنياً ⇒ اسم السابق (الأولى لا تسلّم فيها) */
export function handoversOf(visits: ArchiveVisit[]): Map<string, string> {
  const asc = [...visits].sort((a, b) => ms(a.at) - ms(b.at));
  const out = new Map<string, string>();
  for (let i = 1; i < asc.length; i++) if (asc[i].repId !== asc[i - 1].repId) out.set(asc[i].id, asc[i - 1].rep ?? '—');
  return out;
}

/** آخر زيارة، وآخر زيارةٍ فيها ملاحظة مكتوبة (قد تكون أقدم من الأخيرة) */
export function lastOf(visits: ArchiveVisit[]): { last: ArchiveVisit | null; lastNoted: ArchiveVisit | null } {
  const desc = [...visits].sort((a, b) => ms(b.at) - ms(a.at));
  return { last: desc[0] ?? null, lastNoted: desc.find((v) => v.note) ?? null };
}
