/**
 * البثّ اللحظيّ لكل شركة — «تغيّرت أموال الفواتير، أعد القراءة» (قرار المالك).
 *
 * سند يصدره مندوب من جواله، أو إداريّ من اللوحة، أو دفعة إلكترونية تؤكّدها
 * بوابة ميسر، كان لا يظهر في عمود «المدفوع» على شاشة إداريٍّ آخر مفتوحة حتى
 * يُعيد تحميلها بنفسه: القوائم لا تستطلع الخادم، ولا قناة تدفع إليها التغيير.
 *
 * التصميم: Server‑Sent Events في الذاكرة، وحمولة الحدث **بلا بيانات** — اسمه
 * وحده. الشاشة تعيد قراءة ما تعرضه بصلاحياتها ونطاقها هي، فلا يمرّ عبر القناة
 * رقمٌ أو اسم قد لا يحقّ لمستمعٍ مقيَّد النطاق أن يراه. والانتظار لا يلمس
 * قاعدة البيانات إطلاقاً (وهي العنق الضيّق في بنيتنا)؛ القراءة تقع فقط حين
 * يتغيّر شيء فعلاً، وعلى الشاشات الظاهرة وحدها.
 *
 * ⚠️ الذاكرة محلّية للعملية: يصحّ هذا ما دام الخادم نسخة واحدة (وهو كذلك اليوم).
 * التوسّع الأفقيّ يلزمه ناقلٌ مشترك (Postgres LISTEN/NOTIFY أو Redis).
 */

/** ما يلزم البثّ من الاستجابة — واجهة ضيّقة يسهل تزييفها في الاختبار */
export interface LiveSink {
  write(chunk: string): unknown;
}

interface Client { sink: LiveSink; userId: string }

const byTenant = new Map<string, Set<Client>>();

/** سقف الاتصالات المفتوحة لكل شركة — حاجزٌ أمام تسريب مقابس لا حدّ فعليّ للاستخدام */
export const MAX_PER_TENANT = 200;
/** نبضة تُبقي الاتصال حيّاً عبر وسطاء الشبكة (تُغلق الخامل عادةً بعد ٦٠ث فأكثر) */
export const HEARTBEAT_MS = 25_000;

/** إطار SSE — سطر الحدث ثم سطر البيانات ثم سطرٌ فارغ يُنهيه */
export function sseFrame(event: string, data: unknown = {}): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * يسجّل مستمعاً لشركة. يُرجع دالّة إلغاء التسجيل، أو `null` إن بلغت الشركة السقف.
 */
export function subscribe(tenantId: string, sink: LiveSink, userId: string): (() => void) | null {
  let set = byTenant.get(tenantId);
  if (!set) { set = new Set(); byTenant.set(tenantId, set); }
  if (set.size >= MAX_PER_TENANT) return null;
  const client: Client = { sink, userId };
  const own = set;
  own.add(client);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    own.delete(client);
    if (!own.size && byTenant.get(tenantId) === own) byTenant.delete(tenantId);
  };
}

/**
 * «فواتير هذه الشركة تغيّرت» — مدفوعها أو متبقّيها أو القائمة نفسها.
 * يُنادى **بعد التزام المعاملة** لا داخلها: حدثٌ قبل الالتزام يدفع الشاشات إلى
 * قراءة ما لم يُكتب بعد، ومعاملةٌ تتراجع بعده تترك الشاشة على رقمٍ لم يقع.
 */
export function publishInvoicesChanged(tenantId: string | null | undefined): void {
  if (!tenantId) return;
  const set = byTenant.get(tenantId);
  if (!set?.size) return;
  const frame = sseFrame('invoices', { at: Date.now() });
  for (const c of [...set]) {
    // مقبسٌ مات ولم يصل حدث إغلاقه بعد — يُتجاهل، ومعالج الإغلاق يُزيله
    try { c.sink.write(frame); } catch { /* */ }
  }
}

/** عدد المستمعين — للاختبار والتشخيص */
export function liveListenerCount(tenantId?: string): number {
  if (tenantId) return byTenant.get(tenantId)?.size ?? 0;
  let n = 0;
  for (const s of byTenant.values()) n += s.size;
  return n;
}
