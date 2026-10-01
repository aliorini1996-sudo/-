/**
 * المندوب الذكي — جلسة البحث في الخادم (ذاكرة مؤقتة لكل مندوب: آخر بحث فقط).
 *
 * لماذا: المراجع P1… والإحداثيات **يثبّتها الخادم** عند البحث، فلا يرسلها الجهاز لاحقاً.
 *   - لا يستطيع جهازٌ عابث تلفيق نقاط ليكشف مواقع عملاء الزملاء أو ليستعلم عن توقّعات عند أي إحداثيات.
 *   - المراجع ثابتة طوال الجلسة: تسجيل «مغلق» لمحل لا يزيح مراجع البقية، فلا يشير التوجيه لمحل خاطئ.
 * الإحداثيات من Google تبقى في الذاكرة ساعات قليلة فقط (الشروط تسمح بـ٣٠ يوماً)، ولا تُكتب في القاعدة — ومثلها أسماء
 * محلات المسح في مدخلات توجيه العقل المؤجَّل (aiGuide).
 */
import type { Relation } from './nearby';
import type { RepLang, ScanGuide, ScanShop, ShopScorer } from './scanGuide';
import type { AiLessonLite } from './learn/types';
import type { DemandProduct, ProductsSource, TypeBaseline } from './googleDemand';
import type { ShownExpected } from './learn/gsig';

/** مدخلات «الطلب المتوقع» من المسح: وسيط مقيّمي كل نوع حوله وأصناف المندوب — تعيد الدراسة استعمالها (لا تُقرأ ثانيةً). */
export interface SessionDemand {
  baselines: Record<string, TypeBaseline>;
  products: DemandProduct[];
  source: ProductsSource;
}

/**
 * توجيه العقل المؤجَّل لمسحٍ واحد (POST /rep/scan/guide): المسح يعيد القائمة والخطة الحتمية فوراً، ومدخلات العقل
 * تبقى هنا مع الجلسة — لا يرسلها الجهاز. result يُحفظ فنداءٌ ثانٍ للمسح نفسه لا يُكلّف حصةً ولا نموذجاً.
 */
export interface PendingScanGuide {
  at: Date;
  shops: ScanShop[];
  recommended: string[];
  score: ShopScorer;
  rules: ScanGuide;
  /** الترتيب بسياسة متعلَّمة مرقّاة */
  learned: boolean;
  /** دورة المسح المسجَّلة (null = لم تُسجَّل لحدّ الدقيقتين) — تُحدَّث بخطة العقل */
  turnId: string | null;
  lessons: { injected: AiLessonLite[]; heldOut: string[] };
  /** دروس سطر «من تجربة فريقك» المعروض (للدورة) */
  tips: (AiLessonLite | null)[];
  playbook: string | null;
  /** لغة واجهة المندوب عند المسح — يكتب بها العقل */
  lang?: RepLang;
  result?: Promise<unknown>;
}

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
  /** جلسة مسحٍ (/rep/scan) — لا دراسة منفردة ولا إضافة يدوية */
  scan?: boolean;
  /** توجيه العقل المنتظر لهذا المسح (وحده — لا دراسة ولا إضافة يدوية) */
  aiGuide?: PendingScanGuide;
  /** محلات من هذا المسح دُرست بلا خصم من حصة المسح (مجانية حتى FREE_STUDIES_PER_SCAN) */
  freeStudies?: string[];
  /** مدخلات «الطلب المتوقع» (مسحٌ نجح تحميلها فيه وحده) */
  demand?: SessionDemand;
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
export function clearSessions(): void { store.clear(); shown.clear(); }

// ───────────── «الطلب المتوقع» كما عُرض (حلقة التعلّم) ─────────────
// آخر ما عُرض لكل محل في الشركة (أي مندوب) يبقى يوماً في الذاكرة: إن صار عميلاً تُحفظ لقطته (gsig-1) لتُقارن بأول طلب
// حقيقي. أرقامٌ محسوبة ونوع المحل وحدهما — لا شيء من ملف Google — ولا تُكتب في القاعدة إلا عند التحويل.
export const SHOWN_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SHOWN = 20000;
const shown = new Map<string, ShownExpected>();

export function noteShownExpected(tid: string, placeId: string, s: ShownExpected): void {
  const key = `${tid}|${placeId}`;
  shown.delete(key);
  shown.set(key, s);
  if (shown.size > MAX_SHOWN) {
    const oldest = shown.keys().next().value;
    if (oldest !== undefined) shown.delete(oldest);
  }
}

/** ما عُرض لهذا المحل خلال يوم (ويُزال: لقطة واحدة لكل تحويل) — null إن لم يُعرض أو قدُم. */
export function takeShownExpected(tid: string, placeId: string, now = Date.now()): ShownExpected | null {
  const key = `${tid}|${placeId}`;
  const s = shown.get(key);
  if (!s) return null;
  shown.delete(key);
  return now - s.at <= SHOWN_TTL_MS ? s : null;
}
