/**
 * مقاييس البنية التحتيّة — ذاكرة قاعدة البيانات واتصالاتها.
 *
 * **لماذا لا يقيسها الخادم بنفسه:** ذاكرة القاعدة قياسٌ على مستوى الحاوية لا
 * يراه Postgres من داخله، فلا سبيل لمعرفتها بـSQL. مصدرها الوحيد واجهة Render.
 *
 * **ولماذا لا ينادي الخادمُ Render مباشرةً:** مفتاح Render **يملك الحساب كلّه**
 * (يُنشئ الخدمات ويحذفها ويقرأ كل الأسرار). وضعُه في خدمةٍ مكشوفة للإنترنت
 * يجعل اختراقها اختراقاً للحساب بأسره. فالمفتاح يبقى في أسرار GitHub وحدها،
 * والنبضة الدوريّة هي التي تقيس ثم **تدفع** الرقم إلى هنا.
 *
 * والتخزين في الذاكرة لا في القاعدة عمداً: مقياسُ سعةٍ عمرُه دقائق لا يستحقّ
 * جدولاً ولا هجرة مخطَّط، وضياعه عند النشر يُعوَّض بالنبضة التالية خلال ١٠ دقائق.
 */

export interface InfraSnapshot {
  /** ذاكرة القاعدة المستهلَكة بالبايت */
  memoryBytes: number;
  /** سقف ذاكرة خطّة القاعدة بالبايت */
  memoryLimitBytes: number;
  /** الاتصالات المفتوحة الآن */
  connections: number;
  /** سقف اتصالات الخطّة */
  connectionLimit: number;
  /** لحظة القياس (ISO) */
  at: string;
}

let snapshot: InfraSnapshot | null = null;

/** يحفظ آخر قياس ورد من النبضة */
export function setInfraSnapshot(s: Omit<InfraSnapshot, 'at'>): void {
  snapshot = { ...s, at: new Date().toISOString() };
}

/**
 * آخر قياس مع نسبته المئويّة — أو `null` إن لم تصل نبضة بعد.
 *
 * ويُعتبر القياس **قديماً** بعد ٣٠ دقيقة (ثلاثة أضعاف دورة النبضة): عرضُ رقمٍ
 * بائتٍ على أنّه حاليّ أسوأ من عدم عرضه، لأنّ المالك يطمئنّ إلى قياسٍ مضى.
 */
const STALE_MS = 30 * 60 * 1000;

export function getInfraSnapshot(): (InfraSnapshot & { memoryPct: number; connectionsPct: number }) | null {
  if (!snapshot) return null;
  if (Date.now() - new Date(snapshot.at).getTime() > STALE_MS) return null;
  const pct = (used: number, cap: number) => (cap > 0 ? Math.round((used / cap) * 1000) / 10 : 0);
  return {
    ...snapshot,
    memoryPct: pct(snapshot.memoryBytes, snapshot.memoryLimitBytes),
    connectionsPct: pct(snapshot.connections, snapshot.connectionLimit),
  };
}
