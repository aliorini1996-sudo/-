/**
 * المندوب الذكي — جلسة البحث في الخادم (ذاكرة مؤقتة لكل مندوب: آخر بحث فقط).
 *
 * لماذا: المراجع P1… والإحداثيات **يثبّتها الخادم** عند البحث، فلا يرسلها الجهاز لاحقاً.
 *   - لا يستطيع جهازٌ عابث تلفيق نقاط ليكشف مواقع عملاء الزملاء أو ليستعلم عن توقّعات عند أي إحداثيات.
 *   - المراجع ثابتة طوال الجلسة: تسجيل «مغلق» لمحل لا يزيح مراجع البقية، فلا يشير التوجيه لمحل خاطئ.
 * الإحداثيات من Google تبقى في الذاكرة ساعات قليلة فقط (الشروط تسمح بـ٣٠ يوماً)، ولا تُكتب في القاعدة.
 */
import type { Relation } from './nearby';

export interface SessionOutlet {
  ref: string;
  placeId: string;
  outletType: string;
  lat: number;
  lng: number;
  distanceM: number;
  relation: Relation;
  lastOutcome: string | null;
  customerId: string | null;
  closed?: boolean;
}

export interface SearchSession {
  searchId: string;
  createdAt: number;
  origin: { lat: number; lng: number };
  radiusM: number;
  outlets: SessionOutlet[];
}

export const SESSION_TTL_MS = 4 * 60 * 60 * 1000;
const MAX_SESSIONS = 20000;
const store = new Map<string, SearchSession>();
const k = (tid: string, repId: string) => `${tid}|${repId}`;

export function saveSession(tid: string, repId: string, s: SearchSession): void {
  store.delete(k(tid, repId));
  store.set(k(tid, repId), s);
  if (store.size > MAX_SESSIONS) {
    const oldest = store.keys().next().value;
    if (oldest !== undefined) store.delete(oldest);
  }
}

/** الجلسة إن طابق المعرّف ولم تنتهِ؛ وإلا null (يُطلب من المندوب بحث جديد). */
export function getSession(tid: string, repId: string, searchId: string | null | undefined, now = Date.now()): SearchSession | null {
  const s = store.get(k(tid, repId));
  if (!s || !searchId || s.searchId !== searchId) return null;
  if (now - s.createdAt > SESSION_TTL_MS) { store.delete(k(tid, repId)); return null; }
  return s;
}

/** جلسة المندوب الحالية أياً كان معرّفها (لقراءة موقع المحل عند تسجيل نتيجة — «هل كان عند الباب»). */
export function peekSession(tid: string, repId: string, now = Date.now()): SearchSession | null {
  const s = store.get(k(tid, repId));
  if (!s || now - s.createdAt > SESSION_TTL_MS) return null;
  return s;
}

/** تحديث محلٍّ في الجلسة بعد نتيجة زيارة أو تحويل (المرجع لا يتغيّر). */
export function patchSessionOutlet(tid: string, repId: string, placeId: string, patch: Partial<SessionOutlet>): void {
  const s = store.get(k(tid, repId));
  const o = s?.outlets.find(x => x.placeId === placeId);
  if (o) Object.assign(o, patch);
}

/** للاختبارات. */
export function clearSessions(): void { store.clear(); }
