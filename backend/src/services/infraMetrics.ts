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
 * آخر قياس مع نسبته المئويّة وعمره — أو `null` إن لم يصل قياسٌ يُعتدّ به.
 *
 * ⚠️ **كانت نافذة القِدَم ٣٠ دقيقة فاختفت البطاقة أغلب اليوم.** افترضتُ أن
 * النبضة تعمل كل ١٠ دقائق كما في جدولها (`*\/10`)، والقياس الحيّ لسجلّ GitHub
 * يقول غير ذلك: ١٣:١٧ · ١٦:٢١ · ١٨:٣٢ · ٢٠:٥٤ · ٢٢:٤٤ · ٠٠:٢٥ · ٠٥:٠٦ — أي
 * **كل ساعتين تقريباً، وأربع ساعات ونصف ليلاً**. جدولة GitHub «أفضل جهد» لا
 * وعد، وتُؤخَّر الجدولات المتكرّرة تحت الضغط. فكل قياسٍ كان يُعدّ قديماً بعد
 * نصف ساعة من وصوله، وتختفي البطاقة ساعةً ونصفاً من كل ساعتين.
 *
 * والعلاج ليس إخفاء القديم بل **إظهار عمره**: ذاكرة القاعدة تتحرّك ببطء (كاشٌ
 * يمتلئ على مدى ساعات)، فقياسٌ عمره ساعتان يبقى صالحاً لقرار الترقية — بشرط أن
 * يُكتب عمره بجانبه فلا يُقرأ كأنّه لحظيّ. ويُخفى فقط بعد ٦ ساعات.
 */
const STALE_MS = 6 * 60 * 60 * 1000;

export function getInfraSnapshot(): (InfraSnapshot & { memoryPct: number; connectionsPct: number; ageMinutes: number }) | null {
  if (!snapshot) return null;
  const ageMs = Date.now() - new Date(snapshot.at).getTime();
  if (ageMs > STALE_MS) return null;
  const pct = (used: number, cap: number) => (cap > 0 ? Math.round((used / cap) * 1000) / 10 : 0);
  return {
    ...snapshot,
    memoryPct: pct(snapshot.memoryBytes, snapshot.memoryLimitBytes),
    connectionsPct: pct(snapshot.connections, snapshot.connectionLimit),
    ageMinutes: Math.max(0, Math.round(ageMs / 60000)),
  };
}
