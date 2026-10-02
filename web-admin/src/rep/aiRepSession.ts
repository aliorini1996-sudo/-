/**
 * المندوب الذكي — حالة الشاشة في ذاكرة الجلسة (لا على القرص).
 *
 * تطبيق المندوب يستبدل جسمه كلّه حين تُفتح «إضافة عميل» أو «ملف عميل» أو يُضغط زر الرجوع، فتُفكَّك شاشة المندوب
 * الذكي. بلا هذه الذاكرة كان يضيع كل شيء: قائمة المسح والتوجيه، ويلزم مسحٌ جديد يستهلك الحصة.
 * الأسماء من Google تبقى هنا في الذاكرة فقط أثناء الجلسة (لا تُكتب في IndexedDB)، وتُمحى بتبديل المندوب.
 * وحدة صغيرة تُحمَّل مع التطبيق (لا مع حزمة الشاشة الكسولة) كي يُعلِّم RepApp المحلّ «محوَّلاً» بعد إنشاء العميل.
 */

/**
 * businessName/address من المحل المقترح (لا يعيد المندوب كتابتهما)؛ lat/lng من GPS المندوب عند الباب، وإلا موقع المحل في
 * خريطة Google موسوماً pinFromMap (يلتقط المندوب موقعه عند الباب إن شاء).
 */
export interface AiAddPrefill { outletType: string; aiPlaceId: string; businessName?: string; address?: string; lat?: number; lng?: number; pinFromMap?: boolean }

type Fix = { lat: number; lng: number; accuracy: number };

export interface AiRepSessionState {
  repId: string;
  searchId: string | null;
  items: unknown[] | null;
  /** آخر موقع معروف للمندوب (يتجدّد مع كل تحديد) */
  origin: Fix | null;
  guide: unknown | null;
  /** موضع آخر مسح ولحظته — منفصلان عن origin: العودة للشاشة تقرّر بهما إعادة المسح */
  scanOrigin?: Fix | null;
  scannedAt?: number | null;
}

let state: AiRepSessionState | null = null;
const listeners = new Set<(placeId: string, customerId: string | null) => void>();
// المسح الجاري (واحد لكل مندوب): الشاشة التي تُركَّب أثناءه تنتظره بدل مسحٍ ثانٍ مدفوع. gen يُبطل نتيجة مسحٍ
// وصلت بعد تبديل المندوب (clearAiSession) فلا تُحيي جلسته
let inflight: { repId: string; p: Promise<unknown> } | null = null;
let gen = 0;

export function loadAiSession(repId: string): AiRepSessionState | null {
  return state && state.repId === repId ? state : null;
}

export function saveAiSession(s: AiRepSessionState): void { state = s; }

export function clearAiSession(): void { state = null; inflight = null; gen += 1; }

/** تحديث جزئي للجلسة من داخل طلب غير متزامن — تُطبَّق النتيجة ولو فُكّت الشاشة قبل وصولها. */
export function patchAiSession(repId: string, patch: Partial<AiRepSessionState>): void {
  const base: AiRepSessionState = state && state.repId === repId ? state
    : { repId, searchId: null, items: null, origin: null, guide: null };
  state = { ...base, ...patch };
}

/**
 * يسجّل مسحاً جارياً: نتيجته تُحفظ في الجلسة (toPatch) ولو فُكّت الشاشة قبل وصولها، وشاشةٌ تُركَّب أثناءه تنتظره
 * (aiScanInFlight) بدل أن تبدأ مسحاً ثانياً يحجز حصةً وطلبات Google من جديد.
 */
export function trackAiScan<T>(repId: string, p: Promise<T>, toPatch: (v: T) => Partial<AiRepSessionState>): Promise<T> {
  const g = gen;
  const run = p.then(v => { if (g === gen) patchAiSession(repId, toPatch(v)); return v; });
  const entry = { repId, p: run };
  inflight = entry;
  const done = () => { if (inflight === entry) inflight = null; };
  run.then(done, done);
  return run;
}

export function aiScanInFlight<T>(repId: string): Promise<T> | null {
  return inflight && inflight.repId === repId ? (inflight.p as Promise<T>) : null;
}

/**
 * بعد إنشاء عميل من محلٍّ مقترح: يصير المحل «عميلاً حالياً» في القائمة فلا يُضاف مرة ثانية، ويخرج من خطة التوجيه.
 * customerId=null: أُنشئ دون اتصال (في صفّ الإرسال) ⇒ «بانتظار المزامنة» بلا ملف عميل يُفتح بعد.
 */
export function markConverted(placeId: string, customerId: string | null): void {
  if (state?.items) {
    const ref = (state.items.find(it => (it as { placeId?: string }).placeId === placeId) as { ref?: string } | undefined)?.ref;
    const guide = state.guide as { stops?: { ref: string }[] } | null;
    state = {
      ...state,
      items: state.items.map(it => {
        const x = it as { placeId?: string };
        if (x.placeId !== placeId) return it;
        return customerId ? { ...x, relation: 'CUSTOMER', customerId, lastOutcome: 'CONVERTED' } : { ...x, pendingCustomer: true };
      }),
      // الشاشة مفكّكة أثناء «إضافة عميل» فلا يصلها المستمع ⇒ المحطة تُسقط هنا أيضاً
      guide: ref && guide?.stops ? { ...guide, stops: guide.stops.filter(s => s.ref !== ref) } : state.guide,
    };
  }
  listeners.forEach(fn => fn(placeId, customerId));
}

export function onConverted(fn: (placeId: string, customerId: string | null) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
