/**
 * المندوب الذكي — حالة الشاشة في ذاكرة الجلسة (لا على القرص).
 *
 * تطبيق المندوب يستبدل جسمه كلّه حين تُفتح «إضافة عميل» أو «ملف عميل» أو يُضغط زر الرجوع، فتُفكَّك شاشة المندوب
 * الذكي. بلا هذه الذاكرة كان يضيع كل شيء: الأسماء والتوجيه والمسار والمحادثة، ويلزم بحث جديد مدفوع.
 * الأسماء من Google تبقى هنا في الذاكرة فقط أثناء الجلسة (لا تُكتب في IndexedDB)، وتُمحى بتبديل المندوب.
 * وحدة صغيرة تُحمَّل مع التطبيق (لا مع حزمة الشاشة الكسولة) كي يُعلِّم RepApp المحلّ «محوَّلاً» بعد إنشاء العميل.
 */

export interface AiAddPrefill { outletType: string; aiPlaceId: string; lat?: number; lng?: number }

export interface AiRepSessionState {
  repId: string;
  searchId: string | null;
  items: unknown[] | null;
  origin: { lat: number; lng: number; accuracy: number } | null;
  guide: unknown | null;
  routeIds: string[];
  chat: unknown[];
  askDraft: string;
  tab: 'near' | 'route' | 'ask';
}

let state: AiRepSessionState | null = null;
const listeners = new Set<(placeId: string, customerId: string) => void>();

export function loadAiSession(repId: string): AiRepSessionState | null {
  return state && state.repId === repId ? state : null;
}

export function saveAiSession(s: AiRepSessionState): void { state = s; }

export function clearAiSession(): void { state = null; }

/** بعد إنشاء عميل من محلٍّ مقترح: يصير المحل «عميلاً حالياً» في القائمة فلا يُضاف مرة ثانية. */
export function markConverted(placeId: string, customerId: string): void {
  if (state?.items) {
    state = {
      ...state,
      items: state.items.map(it => {
        const x = it as { placeId?: string };
        return x.placeId === placeId ? { ...x, relation: 'CUSTOMER', customerId, lastOutcome: 'CONVERTED' } : it;
      }),
      routeIds: state.routeIds.filter(id => id !== placeId),
    };
  }
  listeners.forEach(fn => fn(placeId, customerId));
}

export function onConverted(fn: (placeId: string, customerId: string) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
