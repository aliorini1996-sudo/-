/**
 * المندوب الذكي — حلقة التعلّم: الأنواع المشتركة بين وحداتها (بلا منطق، لتجنّب الاعتماد الدائري).
 *
 * «التعلّم» هنا ذاكرة إحصائية لكل شركة على حدة فوق نموذج ثابت (Groq openai/gpt-oss-120b لا يُعاد تدريبه):
 *   - ترتيب محلات المسح (POLICY) يُعاير بنتائج زيارات مناديب الشركة لخطط المسح نفسها (ميزات Google: SCAN_FS).
 *   - الطلب التجريبي (CALIBRATION) يُعاير بأول طلبات العملاء الجدد الفعلية (توقّعٌ لا يُعرض للمندوب في الشاشة الحالية).
 *   - إحصاء الميدان (FieldStats): الاعتراضات وأوقات الإغلاق والعودة، بعتبات تعرّض (عدد ومناديب وحصة أكبر مندوب).
 *   - دروس قصيرة بلا أرقام (AiLesson) تُختبر قبل اعتمادها، ومراجعة ذاتية بالعقل على ملخّص رقمي مجهول الهوية.
 */

export type ObjectionCode =
  | 'PRICE' | 'HAS_SUPPLIER' | 'NO_SHELF_SPACE' | 'NEEDS_CREDIT' | 'SLOW_MOVING'
  | 'DECISION_MAKER_ABSENT' | 'WANTS_SAMPLE' | 'UNKNOWN_BRAND' | 'TIMING' | 'OTHER';

export type Intent =
  | 'GUIDE' | 'WHERE_START' | 'ROUTE' | 'WHAT_OFFER' | 'HOW_MUCH' | 'OBJ_PRICE' | 'OBJ_SUPPLIER' | 'OBJ_SHELF'
  | 'OBJ_CREDIT' | 'OPENING' | 'PRODUCT' | 'TEAM_EXPERIENCE' | 'OTHER';

export type Arm = 'LEARNED' | 'BASELINE';
export type LearningMode = 'AUTO' | 'REVIEW' | 'OFF';
export type ConfLevel = 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';

// ───────────── ترتيب الفرص ─────────────

export interface PolicyParams {
  v: 1;
  /** أُسّ المسافة: score ∝ 1/(0.3+km)^alpha */
  alpha: number;
  confW: Record<ConfLevel, number>;
  /** مضاعف قبول نوع المحل (من إحصاء الميدان) — غيابه = ١ */
  typeMult: Record<string, number>;
  /** احتمال وجود المحل مغلقاً لكل نوع × فترة من اليوم (٥ فترات) */
  closedRisk: Record<string, number[]> | null;
  useClosed: boolean;
}

/** مطابقٌ تماماً لـopportunityScore قبل التعلّم (اختبار انحدار يقفله). */
export const DEFAULT_POLICY: PolicyParams = Object.freeze({
  v: 1, alpha: 1, confW: { HIGH: 1, MEDIUM: 0.8, LOW: 0.5, NONE: 0.4 }, typeMult: {}, closedRisk: null, useClosed: false,
}) as PolicyParams;

/** سياسة المسح قبل التعلّم: أوزان الثقة كلها ١ (التقييم مشدود بعدد مقيّميه أصلاً) — نقاطها = shopScore. */
export const SCAN_DEFAULT_POLICY: PolicyParams = Object.freeze({
  v: 1, alpha: 1, confW: { HIGH: 1, MEDIUM: 1, LOW: 1, NONE: 1 }, typeMult: {}, closedRisk: null, useClosed: false,
}) as PolicyParams;

/** مخطّط ميزات المسح (Google): v درجة التقييم المشدود بعدد مقيّميه، و c من عدد المقيّمين، و o الفتح الآن. */
export const SCAN_FS = 'SCAN1';
/** مضاعف المغلق الآن ومضاعف المتابعة في نقاط المسح (shopScore) — هنا لا في scanGuide تجنّباً للاعتماد الدائري. */
export const SCAN_CLOSED_NOW_W = 0.35;
export const SCAN_FOLLOW_UP_BOOST = 1.25;

/** ميزات مرشّح واحد في دورة توجيه (تُخزَّن في AiTurn.candidates) — بلا مسافات ولا إحداثيات ولا أسماء. */
export interface CandFeature {
  /** placeId */
  p: string;
  /** نوع المحل */
  t: string;
  /** شريحة المسافة 0..5 */
  b: number;
  /** ثقة التوقّع (القديم) أو ثقة التقييم من عدد مقيّميه (SCAN1) */
  c: ConfLevel;
  /** قيمة الفرصة V: من بيانات الشركة (القديم) أو درجة تقييم Google المشدود (SCAN1)، ٣ أرقام معنوية */
  v: number;
  /** آخر نتيجة: S = مهتم/عُد لاحقاً/عرض سعر، N = غير ذلك */
  lo: 'N' | 'S';
  /** رتبته في ترتيب الذراع (١…) */
  rr: number;
  /** موضعه في الخطة النهائية (١…٥) أو ٠ */
  fr: number;
  /** مفتوح الآن حسب Google: ١ مفتوح، ٠ مغلق، غيابه = غير معروف */
  o?: 0 | 1;
  /** مخطّط الميزات (SCAN_FS) — غيابه = ميزات التوقّع القديمة (/guide) فلا تدخل التسميات */
  fs?: string;
}

// ───────────── معايرة الطلب التجريبي ─────────────

export interface CalParams {
  v: 1;
  trial: { tenant: number; byType: Record<string, number> };
  customers: number;
  pairs: number;
}

// ───────────── إحصاء الميدان ─────────────

export interface FieldCell { n: number; reps: number; topRepShare: number; exposed: boolean }

export interface FieldTypeStats extends FieldCell {
  posRate: number;
  typeMult: number;
  convRate: (FieldCell & { rate: number }) | null;
  objections: (FieldCell & { shares: Partial<Record<ObjectionCode, number>> }) | null;
  callback: (FieldCell & { rate: number }) | null;
  closed: { rate: number; byBand: number[]; nByBand: number[] };
}

export interface FieldStats {
  v: 1;
  computedAt: string;
  windowDays: 90;
  activeReps: number;
  tenantPosRate: number;
  byType: Record<string, FieldTypeStats>;
}

// ───────────── الدروس ─────────────

export type LessonStatus = 'PENDING' | 'TRIAL' | 'ACTIVE' | 'RETIRED' | 'DISABLED' | 'REJECTED';
export type LessonKind = 'FIELD' | 'PROCESS';
export type LessonOrigin = 'STATS' | 'SELF' | 'REFLECTION';

/** ما يُحمَّل للاستعمال الحيّ (بلا الدليل الكامل ولا السجلّ). */
export interface AiLessonLite {
  id: string;
  /** مفتاح الدرس (OBJ:/TIME:/REVISIT: للإحصاء) — لسطر «من تجربة فريقك» الحتمي */
  key?: string;
  kind: LessonKind;
  origin: LessonOrigin;
  outletType: string | null;
  intent: string | null;
  textAr: string;
  status: LessonStatus;
  /** حجم الدليل (للترتيب) */
  n: number;
}

export interface Learned {
  mode: LearningMode;
  policy: { version: number; params: PolicyParams } | null;
  calibration: { version: number; params: CalParams } | null;
  field: FieldStats | null;
  lessons: AiLessonLite[];
}

export const EMPTY_LEARNED: Learned = Object.freeze({ mode: 'AUTO', policy: null, calibration: null, field: null, lessons: [] }) as Learned;
