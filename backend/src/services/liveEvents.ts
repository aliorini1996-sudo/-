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
    if (!own.size && byTenant.get(tenantId) === own) {
      byTenant.delete(tenantId);
      lastLocations.delete(tenantId);
      clearTimeout(pendingLocations.get(tenantId));
      pendingLocations.delete(tenantId);
    }
  };
}

/**
 * «فواتير هذه الشركة تغيّرت» — مدفوعها أو متبقّيها أو القائمة نفسها.
 * يُنادى **بعد التزام المعاملة** لا داخلها: حدثٌ قبل الالتزام يدفع الشاشات إلى
 * قراءة ما لم يُكتب بعد، ومعاملةٌ تتراجع بعده تترك الشاشة على رقمٍ لم يقع.
 */
export function publishInvoicesChanged(tenantId: string | null | undefined): void {
  if (!tenantId) return;
  broadcast(tenantId, 'invoices');
}

/** أقلّ فاصلٍ بين حدثي «locations» للشركة — نقاط المناديب تتلاحق، والشاشة تكفيها قراءة كل لحظة */
export const LOCATIONS_MIN_GAP_MS = 2_000;
const lastLocations = new Map<string, number>();
/** حدثٌ مؤجَّل لكل شركة: ما يقع داخل النافذة يُبثّ عند نهايتها — لا يسقط فيبقى دبّوسه قديماً حتى الاستطلاع */
const pendingLocations = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * «موقع مندوبٍ في هذه الشركة تحدّث» — تعيد خريطة التتبّع الظاهرة قراءة المواقع بنطاقها هي (الحمولة بلا موقع).
 * مجمَّع: حدثٌ واحد على الأكثر لكل شركة في LOCATIONS_MIN_GAP_MS، فعشرات المناديب لا تصير عشرات القراءات — وما يقع
 * داخل النافذة يؤجَّل إلى نهايتها (حافةٌ لاحقة) ولا يسقط.
 */
export function publishLocationsChanged(tenantId: string | null | undefined, now = Date.now()): void {
  if (!tenantId) return;
  const set = byTenant.get(tenantId);
  if (!set?.size) return;
  const last = lastLocations.get(tenantId) ?? 0;
  if (now - last < LOCATIONS_MIN_GAP_MS) {
    if (pendingLocations.has(tenantId)) return; // مؤجَّلٌ سيلتقط هذا أيضاً
    const t = setTimeout(() => {
      pendingLocations.delete(tenantId);
      if (!byTenant.get(tenantId)?.size) return;
      const at = Date.now();
      lastLocations.set(tenantId, at);
      broadcast(tenantId, 'locations', at);
    }, last + LOCATIONS_MIN_GAP_MS - now);
    t.unref?.();
    pendingLocations.set(tenantId, t);
    return;
  }
  clearTimeout(pendingLocations.get(tenantId));
  pendingLocations.delete(tenantId);
  lastLocations.set(tenantId, now);
  broadcast(tenantId, 'locations', now);
}

function broadcast(tenantId: string, event: string, at = Date.now()): void {
  const set = byTenant.get(tenantId);
  if (!set?.size) return;
  const frame = sseFrame(event, { at });
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
